/**
 * RECOVER — the two crash scenarios the Stellar lane proved are distinguishable
 * with exactly one question to the ledger.
 *
 * Seen from inside the DB these two are IDENTICAL: one settlements row in
 * `submitted`, one order in `settling`. Only the ledger can tell them apart.
 * That is why recover may not guess, may not rebuild, and may not send the
 * money again.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/src/db/client'
import { settlementsRepo } from '@/src/db/repo'
import { orderEvents, settlements } from '@/src/db/schema'
import {
  addRecipient,
  confirmDeposit,
  confirmQuote,
  createOrder,
  getOrder,
  issueDepositReference,
} from '@/src/domain/orders'
import { transitionOrder } from '@/src/domain/state'
import { openLock } from '../lock'
import { recoverPending } from '../recover'
import { createFakeStellar, fakeXdr } from './fake-stellar'
import { WORKER_NOW, WORKER_REF_LIKE, cleanupWorkerData, closeDb, ensureSchema } from './worker-db'

const RECIPIENT = {
  fullName: 'Maria Santos',
  bankName: 'BDO Unibank',
  accountNumber: '00123456789',
  bankCode: 'BNORPHMM',
}

async function orderReadyToSettle(usdAmount = '100') {
  const order = await createOrder({ usdAmount, now: WORKER_NOW })
  await confirmQuote(order.id, WORKER_NOW)
  await addRecipient(order.id, RECIPIENT)
  const { depositReference } = await issueDepositReference(order.id)
  await confirmDeposit(order.id, { depositReference, usdAmount })
  return getOrder(order.id)
}

/**
 * Reconstruct the exact state after the worker was `kill -9`ed: the leg written
 * to the DB in `submitted`, the order already moved to `settling`. That is the
 * last step the old process managed before dying — whether it died BEFORE or
 * AFTER the submit.
 */
async function crashedMidSettlement(deadlineMs: number, usdAmount = '100') {
  const order = await orderReadyToSettle(usdAmount)
  const txHash = Buffer.from(order.referenceId.padEnd(32, 'x')).toString('hex').slice(0, 64)

  await settlementsRepo.insertSubmitted(db, {
    orderId: order.id,
    txHash,
    signedXdr: fakeXdr(txHash, deadlineMs, 101),
    sourceAccount: 'GTREASURYFAKE',
    destinationAccount: 'GPAYOUTFAKE',
    assetCode: 'USDC',
    assetIssuer: 'GISSUERFAKE',
    amount: '99.0000000',
    memo: order.referenceId,
  })
  await db.transaction((tx) =>
    transitionOrder(tx, {
      orderId: order.id,
      from: 'settlement_ready',
      to: 'settling',
      actor: 'worker',
      externalRef: txHash,
    }),
  )

  return { order, txHash }
}

const legsOf = (orderId: string) =>
  db.select().from(settlements).where(eq(settlements.orderId, orderId))

beforeAll(async () => {
  await ensureSchema()
  await cleanupWorkerData()
})

beforeEach(async () => {
  await cleanupWorkerData()
})

afterAll(async () => {
  await cleanupWorkerData()
  await closeDb()
})

describe('recoverPending — crash BETWEEN build and submit', () => {
  it('tx never reached the network ⇒ markFailed once the timebounds expire, NO rebuild', async () => {
    // The timebounds have passed: this tx can never reach a ledger any more.
    const { order, txHash } = await crashedMidSettlement(Date.now() - 1000)

    // forbidBuild + forbidSubmit: if recover ever slipped into a rebuild or
    // resent the money, the fake throws and the test goes red.
    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })

    const report = await recoverPending({ db, stellar: fake.port, lock: openLock, referenceLike: WORKER_REF_LIKE })

    expect(report.scanned).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.settled).toBe(0)

    // Recover DID ask the ledger — and only asked, nothing else.
    expect(fake.calls.map((c) => c.op)).toEqual(['deadline', 'poll'])
    expect(fake.calls[1].txHash).toBe(txHash)
    expect(fake.count('build')).toBe(0)
    expect(fake.count('submit')).toBe(0)
    expect(fake.payments).toHaveLength(0)

    const legs = await legsOf(order.id)
    expect(legs).toHaveLength(1)
    expect(legs[0].status).toBe('failed')
    expect(legs[0].failureReason).toBe('timebounds_expired_not_on_ledger')

    // The money never left the wallet ⇒ the order stays `settling`; a new leg
    // is the main loop's job, NOT recover's.
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settling')
  })

  it('timebounds not expired yet ⇒ no conclusion, state left as it is', async () => {
    const { order } = await crashedMidSettlement(Date.now() + 120_000)
    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })

    const report = await recoverPending({ db, stellar: fake.port, lock: openLock, referenceLike: WORKER_REF_LIKE })

    expect(report.pending).toBe(1)
    expect(report.failed).toBe(0)
    const legs = await legsOf(order.id)
    expect(legs[0].status).toBe('submitted')
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settling')
  })
})

describe('recoverPending — crash AFTER submit', () => {
  it('tx already on the ledger ⇒ markConfirmed + settled, money NOT sent again', async () => {
    const { order, txHash } = await crashedMidSettlement(Date.now() + 120_000)

    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })
    // The truth only the ledger knows: the tx entered block 555_123 before the worker died.
    fake.putOnLedger(txHash, 555_123)

    const report = await recoverPending({ db, stellar: fake.port, lock: openLock, referenceLike: WORKER_REF_LIKE })

    expect(report.settled).toBe(1)
    expect(report.outcomes[0].txHash).toBe(txHash)
    expect(report.outcomes[0].ledgerSeq).toBe(555_123)

    // No build, no submit — reads only.
    expect(fake.count('build')).toBe(0)
    expect(fake.count('submit')).toBe(0)
    expect(fake.payments).toHaveLength(0)

    const legs = await legsOf(order.id)
    expect(legs).toHaveLength(1)
    expect(legs[0].status).toBe('confirmed')
    expect(legs[0].ledgerSeq).toBe(555_123)
    expect(legs[0].confirmedAt).toBeInstanceOf(Date)

    expect(await getOrder(order.id).then((o) => o.status)).toBe('settled')

    const events = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.id))
    const settledEvent = events.find((e) => e.toStatus === 'settled')!
    expect(settledEvent.fromStatus).toBe('settling')
    expect(settledEvent.externalRef).toBe(txHash)
    expect(settledEvent.actor).toBe('worker:recover')
  })

  it('tx included but result failed ⇒ order rejected, never silently settled', async () => {
    const { order, txHash } = await crashedMidSettlement(Date.now() + 120_000)
    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })
    fake.putOnLedger(txHash, 555_999, false)

    const report = await recoverPending({ db, stellar: fake.port, lock: openLock, referenceLike: WORKER_REF_LIKE })

    expect(report.settled).toBe(0)
    expect(report.outcomes[0].kind).toBe('failed')
    const legs = await legsOf(order.id)
    expect(legs[0].status).toBe('failed')
    expect(legs[0].failureReason).toBe('tx_included_but_failed')
    expect(await getOrder(order.id).then((o) => o.status)).toBe('rejected')
  })
})

describe('recoverPending — the gap between markConfirmed and transitionOrder', () => {
  it('leg confirmed but order still settling ⇒ finish the move, no network call', async () => {
    const { order, txHash } = await crashedMidSettlement(Date.now() + 120_000)
    await settlementsRepo.markConfirmed(db, txHash, 777_000, { ledger: 777_000 })

    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })
    const report = await recoverPending({ db, stellar: fake.port, lock: openLock, referenceLike: WORKER_REF_LIKE })

    expect(report.settled).toBe(1)
    // The truth is already in the DB — not a single request needed.
    expect(fake.calls).toHaveLength(0)
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settled')
  })
})

describe('recoverPending — nothing to clean up', () => {
  it('clean DB ⇒ empty report, no network call', async () => {
    await orderReadyToSettle('100') // settlement_ready, no leg yet
    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })

    const report = await recoverPending({ db, stellar: fake.port, lock: openLock, referenceLike: WORKER_REF_LIKE })

    expect(report.scanned).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('settling order whose legs have all failed ⇒ reported as an orphan, left to the main loop', async () => {
    const { order, txHash } = await crashedMidSettlement(Date.now() - 1000)
    await settlementsRepo.markFailed(db, txHash, 'timebounds_expired_not_on_ledger')

    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })
    const report = await recoverPending({ db, stellar: fake.port, lock: openLock, referenceLike: WORKER_REF_LIKE })

    expect(report.scanned).toBe(1)
    expect(report.orphans).toBe(1)
    expect(report.outcomes[0].reason).toBe('orphan_settling_no_active_leg')
    expect(fake.count('build')).toBe(0)
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settling')
  })
})
