/**
 * Integration tests for `settleOnce` — real Postgres, fake Stellar.
 *
 * Every test here corresponds to a way of losing money that the Stellar lane
 * proved is real. If one goes red, do not fix the test: reread
 * `src/worker/settle.ts`.
 */
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/src/db/client'
import { settlementsRepo } from '@/src/db/repo'
import { orderEvents, settlements } from '@/src/db/schema'
import { InvalidTransitionError } from '@/src/domain/errors'
import {
  addRecipient,
  confirmDeposit,
  confirmQuote,
  createOrder,
  getOrder,
  issueDepositReference,
} from '@/src/domain/orders'
import { runOnce } from '../index'
import { openLock } from '../lock'
import { silentLogger } from '../log'
import { resumeSubmittedLeg, settleOnce, settlementAmountOf } from '../settle'
import { createFakeStellar, fakeXdr } from './fake-stellar'
import { WORKER_NOW, WORKER_REF_LIKE, cleanupWorkerData, closeDb, ensureSchema } from './worker-db'

const RECIPIENT = {
  fullName: 'Maria Santos',
  bankName: 'BDO Unibank',
  accountNumber: '00123456789',
  bankCode: 'BNORPHMM',
}

/** Push an order to `settlement_ready` along the real domain path. */
async function orderReadyToSettle(usdAmount = '100') {
  const order = await createOrder({ usdAmount, now: WORKER_NOW })
  await confirmQuote(order.id, WORKER_NOW)
  await addRecipient(order.id, RECIPIENT)
  const { depositReference } = await issueDepositReference(order.id)
  await confirmDeposit(order.id, { depositReference, usdAmount })
  return getOrder(order.id)
}

const legsOf = (orderId: string) =>
  db.select().from(settlements).where(eq(settlements.orderId, orderId))

const eventsOf = (orderId: string) =>
  db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)).orderBy(asc(orderEvents.createdAt))

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

// ─── Happy path ────────────────────────────────────────────────────────────

describe('settleOnce — happy path', () => {
  it('order settled, tx_hash bound correctly, order_events fully traced', async () => {
    const order = await orderReadyToSettle('100')
    const fake = createFakeStellar()

    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    expect(result.kind).toBe('settled')
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.ledgerSeq).toBeGreaterThan(0)

    const after = await getOrder(order.id)
    expect(after.status).toBe('settled')

    const legs = await legsOf(order.id)
    expect(legs).toHaveLength(1)
    expect(legs[0].status).toBe('confirmed')
    expect(legs[0].txHash).toBe(result.txHash)
    expect(legs[0].ledgerSeq).toBe(result.ledgerSeq)
    expect(legs[0].confirmedAt).toBeInstanceOf(Date)
    // Invariant #4 in `src/db/schema.ts`: memo = EXACTLY the reference_id.
    expect(legs[0].memo).toBe(order.referenceId)
    // netUsd = 100 - 1% = 99, exactly the number the quote promised the customer.
    expect(legs[0].amount).toBe('99.0000000')
    expect(legs[0].horizonResponse).toBeTruthy()

    // The ledger records EXACTLY ONE payment.
    expect(fake.payments).toHaveLength(1)

    const events = await eventsOf(order.id)
    const tail = events.slice(-2)
    expect(tail.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
      'settlement_ready->settling',
      'settling->settled',
    ])
    // Both traces bind back to the tx hash, and no access token leaked in.
    expect(tail[0].externalRef).toBe(result.txHash)
    expect(tail[1].externalRef).toBe(result.txHash)
    expect(tail.every((e) => e.actor === 'worker')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(order.accessToken)
  })

  it('writes the DB BEFORE submitting — the leg exists at the moment of the submit', async () => {
    const order = await orderReadyToSettle('50')
    const seen: { status: string; txHash: string }[] = []

    const fake = createFakeStellar()
    // Intercept inside submit to inspect the DB: if the order were wrong, there would be no row here yet.
    const port = {
      ...fake.port,
      submitSignedXdr: async (xdr: string) => {
        const rows = await legsOf(order.id)
        for (const r of rows) seen.push({ status: r.status, txHash: r.txHash })
        return fake.port.submitSignedXdr(xdr)
      },
    }

    const result = await settleOnce(order.id, { db, stellar: port, lock: openLock })

    expect(result.kind).toBe('settled')
    expect(seen).toHaveLength(1)
    expect(seen[0].status).toBe('submitted')
    expect(seen[0].txHash).toBe(result.txHash)
  })

  it('settlementAmountOf subtracts the fee exactly as the quote does', () => {
    expect(settlementAmountOf({ usdAmount: '100.0000000', feeUsd: '1.0000000' })).toBe('99.0000000')
    expect(settlementAmountOf({ usdAmount: '250.0000000', feeUsd: '2.5000000' })).toBe('247.5000000')
  })
})

// ─── Submit timeout ────────────────────────────────────────────────────────

describe('settleOnce — submit times out, then the poll finds the tx', () => {
  it('confirmed, and NO second leg', async () => {
    const order = await orderReadyToSettle('100')

    const fake = createFakeStellar({
      onSubmit: ({ txHash }) => {
        // Horizon swallowed the request: the tx STILL made it into a ledger, we just do not know it.
        fake.putOnLedger(txHash)
        return {
          ok: false,
          txHash,
          error: {
            kind: 'timeout',
            retryable: true,
            resolution: 'poll',
            message: 'Horizon gave no definitive answer (504).',
            status: 504,
          },
        }
      },
    })

    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    expect(result.kind).toBe('settled')
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settled')

    // Exactly one build, exactly one leg — a timeout must NOT produce a new tx.
    expect(fake.count('build')).toBe(1)
    expect(fake.count('poll')).toBe(1)
    const legs = await legsOf(order.id)
    expect(legs).toHaveLength(1)
    expect(legs[0].status).toBe('confirmed')
  })

  it('polled to the end of the timebounds without finding it ⇒ leg failed, order still alive for a new leg', async () => {
    const order = await orderReadyToSettle('100')

    const fake = createFakeStellar({
      onSubmit: ({ txHash }) => ({
        ok: false,
        txHash,
        error: {
          kind: 'timeout',
          retryable: true,
          resolution: 'poll',
          message: 'Horizon gave no definitive answer.',
          status: 504,
        },
      }),
      onPoll: () => ({ found: false, reason: 'deadline' }),
      // The deadline is already in the past ⇒ settleOnce is allowed to conclude.
      timeboundsMs: -1000,
    })

    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    expect(result.kind).toBe('retry')
    const legs = await legsOf(order.id)
    expect(legs).toHaveLength(1)
    expect(legs[0].status).toBe('failed')
    expect(legs[0].failureReason).toContain('timebounds_expired_not_on_ledger')
    // The money never left the wallet ⇒ the order stays `settling`, not wrongly rejected.
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settling')
    expect(fake.payments).toHaveLength(0)
  })
})

// ─── tx_bad_seq ────────────────────────────────────────────────────────────

describe('settleOnce — tx_bad_seq', () => {
  it('POLLS THE OLD HASH BEFORE doing anything else', async () => {
    const order = await orderReadyToSettle('100')

    const fake = createFakeStellar({
      onSubmit: ({ txHash }) => ({
        ok: false,
        txHash,
        error: {
          kind: 'tx_bad_seq',
          retryable: true,
          resolution: 'rebuild',
          message: 'tx_bad_seq',
          status: 400,
          resultCodes: { transaction: 'tx_bad_seq' },
        },
      }),
      timeboundsMs: -1000,
    })

    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    // The call order is this test's main proposition.
    expect(fake.calls.map((c) => c.op)).toEqual(['build', 'submit', 'poll'])
    // Polls exactly the OLD HASH, not some other hash.
    expect(fake.calls[2].txHash).toBe(fake.calls[0].txHash)
    // Only when the poll finds nothing may the way be opened for a new leg.
    expect(result.kind).toBe('retry')
    expect(result.reason).toBe('tx_bad_seq_not_on_ledger')
    expect(fake.count('build')).toBe(1)
  })

  it('bad_seq but the old hash IS on the ledger ⇒ confirmed, absolutely no rebuild', async () => {
    const order = await orderReadyToSettle('100')

    const fake = createFakeStellar({
      onSubmit: ({ txHash }) => {
        // The real situation: the old tx made it into a ledger, which is why the sequence is off.
        fake.putOnLedger(txHash, 987_654)
        return {
          ok: false,
          txHash,
          error: {
            kind: 'tx_bad_seq',
            retryable: true,
            resolution: 'rebuild',
            message: 'tx_bad_seq',
            status: 400,
            resultCodes: { transaction: 'tx_bad_seq' },
          },
        }
      },
    })

    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    expect(result.kind).toBe('settled')
    expect(result.ledgerSeq).toBe(987_654)
    expect(fake.count('build')).toBe(1)
    const legs = await legsOf(order.id)
    expect(legs).toHaveLength(1)
    expect(legs[0].status).toBe('confirmed')
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settled')
  })
})

// ─── Permanent failures ────────────────────────────────────────────────────

describe('settleOnce — permanent failures', () => {
  it('insufficient balance ⇒ leg failed + order rejected with a reason', async () => {
    const order = await orderReadyToSettle('100')

    const fake = createFakeStellar({
      onSubmit: ({ txHash }) => ({
        ok: false,
        txHash,
        error: {
          kind: 'tx_insufficient_balance',
          retryable: false,
          resolution: 'fail',
          message: 'Insufficient balance / trustline',
          status: 400,
          resultCodes: { transaction: 'tx_failed', operations: ['op_underfunded'] },
        },
      }),
    })

    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    expect(result.kind).toBe('failed')
    const after = await getOrder(order.id)
    expect(after.status).toBe('rejected')

    const legs = await legsOf(order.id)
    expect(legs[0].status).toBe('failed')
    expect(legs[0].failureReason).toBe('submit_tx_insufficient_balance')

    const last = (await eventsOf(order.id)).at(-1)!
    expect(last.toStatus).toBe('rejected')
    expect((last.detail as Record<string, unknown>).settlementFailure).toBe(
      'submit_tx_insufficient_balance',
    )
  })

  it('retry budget exhausted ⇒ order rejected instead of spinning forever', async () => {
    const order = await orderReadyToSettle('100')
    // Three legs already failed — exactly MAX_SETTLEMENT_ATTEMPTS.
    for (let i = 0; i < 3; i += 1) {
      const txHash = `${'a'.repeat(60)}${String(1000 + i)}`
      await settlementsRepo.insertSubmitted(db, {
        orderId: order.id,
        txHash,
        signedXdr: fakeXdr(txHash, Date.now() - 1000, 1),
        sourceAccount: 'GTREASURYFAKE',
        destinationAccount: 'GPAYOUTFAKE',
        assetCode: 'USDC',
        assetIssuer: 'GISSUERFAKE',
        amount: '99.0000000',
        memo: order.referenceId,
      })
      await settlementsRepo.markFailed(db, txHash, 'timebounds_expired_not_on_ledger')
    }

    const fake = createFakeStellar({ forbidBuild: true })
    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    expect(result.kind).toBe('failed')
    expect(result.reason).toBe('settlement_attempts_exhausted')
    expect(await getOrder(order.id).then((o) => o.status)).toBe('rejected')
  })
})

// ─── States that are not the worker's job ──────────────────────────────────

describe('settleOnce — skipping', () => {
  it('an order not yet at settlement_ready is left untouched', async () => {
    const order = await createOrder({ usdAmount: '100', now: WORKER_NOW })
    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })

    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    expect(result.kind).toBe('skipped')
    expect(result.reason).toBe('status_not_settleable:quoted')
    expect(await legsOf(order.id)).toHaveLength(0)
  })

  it('a nonexistent order ⇒ skipped, no throw', async () => {
    const fake = createFakeStellar({ forbidBuild: true })
    const result = await settleOnce('00000000-0000-0000-0000-000000000000', {
      db,
      stellar: fake.port,
      lock: openLock,
    })
    expect(result.kind).toBe('skipped')
    expect(result.reason).toBe('order_not_found')
  })
})

// ─── Global serialization ──────────────────────────────────────────────────

describe('worker — two orders at once', () => {
  it('processes SEQUENTIALLY: no sequence contention, no tx_bad_seq, two separate payments', async () => {
    const a = await orderReadyToSettle('100')
    const b = await orderReadyToSettle('200')

    // A delay big enough that, if run in parallel, B's build would certainly
    // land between A's build and submit — and the fake would return tx_bad_seq
    // just like the real thing.
    const fake = createFakeStellar({ buildDelayMs: 15, submitDelayMs: 15 })

    const report = await runOnce({
      db,
      stellar: fake.port,
      lock: openLock,
      logger: silentLogger,
      referenceLike: WORKER_REF_LIKE,
    })

    expect(report.picked).toBe(2)
    expect(report.outcomes.map((o) => o.kind)).toEqual(['settled', 'settled'])

    // Serialization proof #1: two network calls never overlap.
    expect(fake.maxConcurrent).toBe(1)
    // Serialization proof #2: build/submit interleave perfectly, not build,build,submit,submit.
    expect(fake.calls.map((c) => c.op)).toEqual(['build', 'submit', 'build', 'submit'])
    // Serialization proof #3: the shared sequence is consumed exactly twice, no drift.
    expect(fake.accountSequence()).toBe(102)
    expect(fake.payments).toHaveLength(2)

    for (const order of [a, b]) {
      expect(await getOrder(order.id).then((o) => o.status)).toBe('settled')
      expect(await legsOf(order.id)).toHaveLength(1)
    }
  })

  it('running in PARALLEL really does break — this is why the serialization constraint exists', async () => {
    const a = await orderReadyToSettle('100')
    const b = await orderReadyToSettle('200')
    const fake = createFakeStellar({ buildDelayMs: 15, submitDelayMs: 15 })

    // Deliberately violating the constraint — AND deliberately dropping the
    // treasury lock (`openLock`) — to prove it is not decoration. The version
    // with the real lock is in `lock.test.ts`: same scenario, the lock holds,
    // and only one tx is sent.
    const results = await Promise.all([
      settleOnce(a.id, { db, stellar: fake.port, lock: openLock }),
      settleOnce(b.id, { db, stellar: fake.port, lock: openLock }),
    ])

    expect(fake.maxConcurrent).toBeGreaterThan(1)
    // Two txs contending for one sequence ⇒ only one gets into a ledger.
    expect(fake.payments).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'settled')).toHaveLength(1)
  })
})

// ─── Atomicity: settled and the tx hash live or die together ───────────────

describe('confirmLeg — one single transaction', () => {
  /**
   * Set up the exact lost-race scene: the leg is on the ledger, but the order
   * row in the DB is NO LONGER in `settling` (someone moved it first).
   * `transitionOrder` will throw, and the question is whether `markConfirmed`
   * rolls back with it.
   */
  async function raceAtConfirm() {
    const order = await orderReadyToSettle('100')
    const txHash = 'c'.repeat(63) + '1'
    await settlementsRepo.insertSubmitted(db, {
      orderId: order.id,
      txHash,
      signedXdr: fakeXdr(txHash, Date.now() + 120_000, 101),
      sourceAccount: 'GTREASURYFAKE',
      destinationAccount: 'GPAYOUTFAKE',
      assetCode: 'USDC',
      assetIssuer: 'GISSUERFAKE',
      amount: '99.0000000',
      memo: order.referenceId,
    })
    const fake = createFakeStellar()
    fake.putOnLedger(txHash, 424_242)
    const leg = (await legsOf(order.id))[0]
    return { order, txHash, fake, leg }
  }

  it('transitionOrder throws ⇒ markConfirmed ROLLS BACK with it', async () => {
    const { order, txHash, fake, leg } = await raceAtConfirm()

    // The `order.status` passed in is 'settling', but the DB sits at
    // 'settlement_ready' ⇒ transitionOrder's optimistic guard matches no row ⇒
    // InvalidTransitionError.
    await expect(
      resumeSubmittedLeg({ ...order, status: 'settling' }, leg, { db, stellar: fake.port }),
    ).rejects.toThrow(InvalidTransitionError)

    // This is the main proposition: NO half-states. The leg must still be `submitted`.
    const after = (await legsOf(order.id))[0]
    expect(after.status).toBe('submitted')
    expect(after.ledgerSeq).toBeNull()
    expect(after.confirmedAt).toBeNull()
    expect(after.horizonResponse).toBeNull()

    // And the order was not pushed to settled.
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settlement_ready')
    // No 'settled' order_events row was written.
    expect((await eventsOf(order.id)).some((e) => e.toStatus === 'settled')).toBe(false)
  })

  it('on the normal path both commit together', async () => {
    const order = await orderReadyToSettle('100')
    const fake = createFakeStellar()

    const result = await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    expect(result.kind).toBe('settled')
    const leg = (await legsOf(order.id))[0]
    // Two faces of the same fact, read from two tables, must agree.
    expect(leg.status).toBe('confirmed')
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settled')
    expect(leg.ledgerSeq).toBe(result.ledgerSeq)
  })
})

// ─── reject_reason read straight off the column ────────────────────────────

describe('reject_reason', () => {
  it('an order-level permanent failure ⇒ reject_reason column = settlement_failed', async () => {
    const order = await orderReadyToSettle('100')
    const fake = createFakeStellar({
      onSubmit: ({ txHash }) => ({
        ok: false,
        txHash,
        error: {
          kind: 'unknown',
          retryable: false,
          resolution: 'fail',
          message: 'Corridor misconfigured: operations=[op_no_trust]',
          status: 400,
          resultCodes: { transaction: 'tx_failed', operations: ['op_no_trust'] },
        },
      }),
    })

    await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    const after = await getOrder(order.id)
    expect(after.status).toBe('rejected')
    // The evidence pack reads THIS column directly, without digging into jsonb.
    expect(after.rejectReason).toBe('settlement_failed')

    // The detailed Horizon code is still there, in the place meant for it.
    const last = (await eventsOf(order.id)).at(-1)!
    expect(last.toStatus).toBe('rejected')
    const detail = last.detail as Record<string, unknown>
    expect(detail.settlementFailure).toBe('submit_unknown')
    expect(detail.rejectReason).toBe('settlement_failed')
  })

  it('a leg whose timebounds expired does NOT use that code — the order is not rejected', async () => {
    const order = await orderReadyToSettle('100')
    const fake = createFakeStellar({
      onSubmit: ({ txHash }) => ({
        ok: false,
        txHash,
        error: {
          kind: 'timeout',
          retryable: true,
          resolution: 'poll',
          message: '504',
          status: 504,
        },
      }),
      onPoll: () => ({ found: false, reason: 'deadline' }),
      timeboundsMs: -1000,
    })

    await settleOnce(order.id, { db, stellar: fake.port, lock: openLock })

    const after = await getOrder(order.id)
    expect(after.status).toBe('settling')
    expect(after.rejectReason).toBeNull()
  })
})

// ─── ledger_seq: null, never 0 ─────────────────────────────────────────────

describe('ledger_seq when Horizon returns no ledger number', () => {
  it('writes NULL, not 0, and logs a warning', async () => {
    const order = await orderReadyToSettle('100')
    const warns: string[] = []
    const recorder = {
      info: () => {},
      warn: (event: string) => warns.push(event),
      error: () => {},
    }

    const fake = createFakeStellar({
      // 200 but no `ledger` ⇒ settleOnce goes back and asks by polling.
      onSubmit: ({ txHash }) => ({ ok: true, txHash, rawResponse: { successful: true } }),
      // The poll finds the tx but also has no ledger number.
      onPoll: () => ({ found: true, txSuccessful: true, rawResponse: { successful: true } }),
    })

    const result = await settleOnce(order.id, {
      db,
      stellar: fake.port,
      lock: openLock,
      logger: recorder,
    })

    expect(result.kind).toBe('settled')
    expect(result.ledgerSeq).toBeNull()

    const leg = (await legsOf(order.id))[0]
    expect(leg.status).toBe('confirmed')
    // A 0 in evidence is a WRONG number. An empty cell tells the reader to look it up.
    expect(leg.ledgerSeq).toBeNull()
    expect(leg.horizonResponse).toEqual({ successful: true })

    expect(warns).toContain('settle.confirm_without_ledger_seq')
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settled')
  })
})
