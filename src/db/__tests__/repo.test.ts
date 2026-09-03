/**
 * TESTS — the repository layer running against a real DB.
 *
 * The focus: `insertSubmitted` must TRANSLATE Postgres unique violations into typed
 * errors, so upper layers can tell "a duplicate" from "the DB is broken". Nothing is mocked.
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '@/src/db/schema'
import { settlements, transferOrders } from '@/src/db/schema'
import { SettlementConflictError, isSettlementConflict } from '@/src/db/repo/errors'
import * as ordersRepo from '@/src/db/repo/orders'
import * as settlementsRepo from '@/src/db/repo/settlements'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set — see .env.example')

const client = postgres(DATABASE_URL, { max: 2, onnotice: () => {} })
const db = drizzle(client, { schema })

/** Own namespace — the date 2099-12-30, so it never collides with constraints.test.ts. */
const REF_PREFIX = 'TP-PHP-20991230-'
const REF_LIKE = `${REF_PREFIX}%`

let seq = 0
const nextRef = () => `${REF_PREFIX}${String(++seq).padStart(4, '0')}`
const nextHash = () => `repotest2099hash${++seq}`

async function cleanup() {
  await client`delete from settlements where order_id in (
    select id from transfer_orders where reference_id like ${REF_LIKE}
  )`
  await client`delete from transfer_orders where reference_id like ${REF_LIKE}`
}

async function seedOrder() {
  const referenceId = nextRef()
  const accessToken = `repotest2099-${seq}`
  const [order] = await db
    .insert(transferOrders)
    .values({
      referenceId,
      accessToken,
      corridor: 'PHP',
      status: 'settlement_ready',
      usdAmount: '250.0000000',
      phpEstimate: '13986.25',
      fxRate: '56.5000000',
      feeUsd: '2.5000000',
      quotedAt: new Date(),
      confirmedAt: new Date(),
    })
    .returning()
  return order
}

function legInput(orderId: string, memo: string) {
  return {
    orderId,
    txHash: nextHash(),
    signedXdr: 'AAAAdGVzdA==',
    sourceAccount: 'GTREASURY',
    destinationAccount: 'GPAYOUT',
    assetCode: 'USDC',
    assetIssuer: 'GISSUER',
    amount: '250.0000000',
    memo,
  }
}

beforeAll(cleanup)
beforeEach(cleanup)
afterAll(async () => {
  await cleanup()
  await client.end({ timeout: 5 })
})

describe('repo/orders', () => {
  it('findById / findByReferenceId / findByAccessToken return the same row', async () => {
    const order = await seedOrder()
    const byId = await ordersRepo.findById(db, order.id)
    const byRef = await ordersRepo.findByReferenceId(db, order.referenceId)
    const byToken = await ordersRepo.findByAccessToken(db, order.accessToken)
    expect(byId?.id).toBe(order.id)
    expect(byRef?.id).toBe(order.id)
    expect(byToken?.id).toBe(order.id)
  })

  it('returns null when nothing is found', async () => {
    expect(await ordersRepo.findByReferenceId(db, `${REF_PREFIX}9999`)).toBeNull()
    expect(await ordersRepo.findByAccessToken(db, 'does-not-exist')).toBeNull()
  })

  it('listForEvidence has every D1 table field and does NOT leak access_token', async () => {
    const order = await seedOrder()
    await client`
      insert into recipients (order_id, full_name, bank_name, account_number, bank_code)
      values (${order.id}, 'Juan Dela Cruz', 'BDO Unibank', '000123456', 'BDOPHMM')
    `
    await client`
      insert into deposit_references (order_id, deposit_reference, expected_usd_amount, confirmed_at)
      values (${order.id}, ${`DEP-${order.referenceId}`}, '250.0000000', now())
    `
    const rows = await ordersRepo.listForEvidence(db)
    const row = rows.find((r) => r.referenceId === order.referenceId)
    expect(row).toBeTruthy()
    expect(row!.usdAmount).toBe('250.0000000')
    expect(row!.phpEstimate).toBe('13986.25')
    expect(row!.fxRate).toBe('56.5000000')
    expect(row!.recipientName).toBe('Juan Dela Cruz')
    expect(row!.recipientBank).toBe('BDO Unibank')
    expect(row!.depositReference).toBe(`DEP-${order.referenceId}`)
    expect(row!.confirmedAt).toBeInstanceOf(Date)
    expect(Object.keys(row!)).not.toContain('accessToken')
  })
})

describe('repo/settlements', () => {
  it('insertSubmitted writes the leg in status submitted', async () => {
    const order = await seedOrder()
    const leg = await settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId))
    expect(leg.status).toBe('submitted')
    expect(leg.memo).toBe(order.referenceId)
    expect(leg.confirmedAt).toBeNull()
    // tx_hash + signed_xdr are in the DB before anyone calls Horizon.
    expect(leg.signedXdr).toBe('AAAAdGVzdA==')
  })

  it('insertSubmitted translates a duplicate tx_hash into SettlementConflictError(duplicate_tx_hash)', async () => {
    const a = await seedOrder()
    const b = await seedOrder()
    const input = legInput(a.id, a.referenceId)
    await settlementsRepo.insertSubmitted(db, input)

    const err = await settlementsRepo
      .insertSubmitted(db, { ...legInput(b.id, b.referenceId), txHash: input.txHash })
      .then(() => null, (e: unknown) => e)

    expect(isSettlementConflict(err)).toBe(true)
    expect((err as SettlementConflictError).kind).toBe('duplicate_tx_hash')
    expect((err as SettlementConflictError).constraintName).toBe('settlements_tx_hash_key')
  })

  it('insertSubmitted translates a duplicate leg on one order into SettlementConflictError(active_settlement)', async () => {
    const order = await seedOrder()
    await settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId))

    const err = await settlementsRepo
      .insertSubmitted(db, legInput(order.id, order.referenceId))
      .then(() => null, (e: unknown) => e)

    expect(isSettlementConflict(err)).toBe(true)
    expect((err as SettlementConflictError).kind).toBe('active_settlement')
    expect((err as SettlementConflictError).constraintName).toBe('settlements_active_order_key')
  })

  it('other DB errors are NOT swallowed into a SettlementConflictError', async () => {
    const err = await settlementsRepo
      .insertSubmitted(db, legInput('00000000-0000-0000-0000-000000000000', 'TP-PHP-20991230-0001'))
      .then(() => null, (e: unknown) => e)

    expect(isSettlementConflict(err)).toBe(false)
    expect((err as { code?: string }).code).toBe('23503') // foreign_key_violation, rethrown untouched
  })

  it('markConfirmed writes ledger_seq + the horizon response, markFailed opens the way to retry', async () => {
    const order = await seedOrder()
    const first = await settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId))

    const confirmed = await settlementsRepo.markConfirmed(db, first.txHash, 987654, {
      successful: true,
      hash: first.txHash,
    })
    expect(confirmed?.status).toBe('confirmed')
    expect(confirmed?.ledgerSeq).toBe(987654)
    expect(confirmed?.confirmedAt).toBeInstanceOf(Date)
    expect((confirmed?.horizonResponse as { successful: boolean }).successful).toBe(true)

    // A confirmed leg is still a live leg ⇒ no further insert is allowed.
    expect(await settlementsRepo.findActiveByOrderId(db, order.id)).toMatchObject({ id: first.id })

    const failed = await settlementsRepo.markFailed(db, first.txHash, 'tx_too_late')
    expect(failed?.status).toBe('failed')
    expect(failed?.failureReason).toBe('tx_too_late')
    expect(await settlementsRepo.findActiveByOrderId(db, order.id)).toBeNull()

    const retry = await settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId))
    expect(retry.status).toBe('submitted')
    expect(await settlementsRepo.listByOrderId(db, order.id)).toHaveLength(2)
  })

  it('markConfirmed / markFailed return null when the tx_hash does not exist', async () => {
    expect(await settlementsRepo.markConfirmed(db, 'no-such-hash-2099', 1, {})).toBeNull()
    expect(await settlementsRepo.markFailed(db, 'no-such-hash-2099', 'x')).toBeNull()
  })

  it('listForEvidence has every D2 table field', async () => {
    const order = await seedOrder()
    const leg = await settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId))
    await settlementsRepo.markConfirmed(db, leg.txHash, 111222, { successful: true })

    const rows = await settlementsRepo.listForEvidence(db)
    const row = rows.find((r) => r.txHash === leg.txHash)
    expect(row).toBeTruthy()
    expect(row!.referenceId).toBe(order.referenceId)
    // Invariant #4: memo = exactly reference_id, nothing appended.
    expect(row!.memo).toBe(order.referenceId)
    expect(row!.sourceAccount).toBe('GTREASURY')
    expect(row!.destinationAccount).toBe('GPAYOUT')
    expect(row!.amount).toBe('250.0000000')
    expect(row!.assetCode).toBe('USDC')
    expect(row!.ledgerSeq).toBe(111222)
    expect(row!.submittedAt).toBeInstanceOf(Date)
    expect(row!.confirmedAt).toBeInstanceOf(Date)
  })

  it('findByTxHash finds the leg that was just written', async () => {
    const order = await seedOrder()
    const leg = await settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId))
    expect((await settlementsRepo.findByTxHash(db, leg.txHash))?.id).toBe(leg.id)
    expect(await settlementsRepo.findByTxHash(db, 'no-such-2099')).toBeNull()
  })

  it('concurrent inserts for one order: exactly 1 wins (decided by the DB, not the app)', async () => {
    const order = await seedOrder()
    const results = await Promise.allSettled([
      settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId)),
      settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId)),
      settlementsRepo.insertSubmitted(db, legInput(order.id, order.referenceId)),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && isSettlementConflict(r.reason),
    )
    expect(ok).toHaveLength(1)
    expect(conflicts).toHaveLength(2)

    const [{ n }] = await db
      .select({ n: raw<string>`count(*)::text` })
      .from(settlements)
      .where(eq(settlements.orderId, order.id))
    expect(n).toBe('1')
  })
})
