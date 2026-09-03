/**
 * GLOBAL SERIALIZATION LOCK — tested against a real Postgres.
 *
 * This is the only test that uses the real `createAdvisoryLock` instead of
 * `openLock`: its whole point is to prove the constraint survives ACROSS
 * processes, i.e. that it lives in the DB and not in a JavaScript variable.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/src/db/client'
import { settlements } from '@/src/db/schema'
import {
  addRecipient,
  confirmDeposit,
  confirmQuote,
  createOrder,
  getOrder,
  issueDepositReference,
} from '@/src/domain/orders'
import { LOCK_NAMESPACE, createAdvisoryLock, createMemoryLock, lockKeyForTreasury } from '../lock'
import { recoverPending } from '../recover'
import { settleOnce } from '../settle'
import { createFakeStellar } from './fake-stellar'
import { WORKER_NOW, cleanupWorkerData, closeDb, ensureSchema } from './worker-db'

/** The test's own key — never touches the real treasury's lock. */
const TEST_KEY: [number, number] = [LOCK_NAMESPACE, 2098_0001]

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

describe('lockKeyForTreasury', () => {
  it('is deterministic, and a different treasury ⇒ a different key', () => {
    const a = lockKeyForTreasury('GCCJ53QSTGTHHZ2J5RCI4BBX42RVNRKP76OHCSCJ23TXDHHQISRQGMQW')
    const b = lockKeyForTreasury('GB4UDMOLHCCDK4A3F6PPRCCZXV5P46QFSMMYD7RLVIRPLRGXWAN2VE77')

    expect(a).toEqual(lockKeyForTreasury('GCCJ53QSTGTHHZ2J5RCI4BBX42RVNRKP76OHCSCJ23TXDHHQISRQGMQW'))
    expect(a[0]).toBe(LOCK_NAMESPACE)
    expect(b[0]).toBe(LOCK_NAMESPACE)
    expect(a[1]).not.toBe(b[1])
    // Must fit Postgres int4, otherwise `::int4` blows up.
    for (const k of [...a, ...b]) {
      expect(Number.isInteger(k)).toBe(true)
      expect(k).toBeGreaterThanOrEqual(-(2 ** 31))
      expect(k).toBeLessThan(2 ** 31)
    }
  })
})

describe('createAdvisoryLock', () => {
  it('the second holder does NOT get it and does NOT wait; once released it can', async () => {
    // Two independent lock objects = two worker "instances", same key.
    const instanceA = createAdvisoryLock({ db, key: TEST_KEY })
    const instanceB = createAdvisoryLock({ db, key: TEST_KEY })

    const held = await instanceA.acquire()
    expect(held).not.toBeNull()

    const t0 = Date.now()
    const denied = await instanceB.acquire()
    // Returns immediately, no queueing.
    expect(denied).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)

    await held!.release()

    const afterRelease = await instanceB.acquire()
    expect(afterRelease).not.toBeNull()
    await afterRelease!.release()
  })

  it('different keys do not block each other', async () => {
    const a = createAdvisoryLock({ db, key: TEST_KEY })
    const b = createAdvisoryLock({ db, key: [LOCK_NAMESPACE, 2098_0002] })

    const ha = await a.acquire()
    const hb = await b.acquire()
    expect(ha).not.toBeNull()
    expect(hb).not.toBeNull()
    await ha!.release()
    await hb!.release()
  })
})

describe('settleOnce under the lock', () => {
  it('lock unavailable ⇒ pending, NO network call, NO leg written', async () => {
    const order = await orderReadyToSettle('100')

    // Another instance is holding the lock.
    const other = createAdvisoryLock({ db, key: TEST_KEY })
    const held = await other.acquire()
    expect(held).not.toBeNull()

    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })
    const result = await settleOnce(order.id, {
      db,
      stellar: fake.port,
      lock: createAdvisoryLock({ db, key: TEST_KEY }),
    })

    expect(result.kind).toBe('pending')
    expect(result.reason).toBe('treasury_lock_unavailable')
    // Nothing changed at all — retrying on the next pass is enough.
    expect(fake.calls).toHaveLength(0)
    expect(await legsOf(order.id)).toHaveLength(0)
    expect(await getOrder(order.id).then((o) => o.status)).toBe('settlement_ready')

    await held!.release()
  })

  it('releases the lock even when settle throws', async () => {
    const order = await orderReadyToSettle('100')
    const lock = createAdvisoryLock({ db, key: TEST_KEY })

    const fake = createFakeStellar()
    // Throw from `submit`: a failing build is treated as transient and
    // swallowed into `pending`, so it cannot exercise the `finally` path.
    const exploding = {
      ...fake.port,
      submitSignedXdr: async () => {
        throw new Error('boom mid-flight')
      },
    }

    await expect(settleOnce(order.id, { db, stellar: exploding, lock })).rejects.toThrow('boom mid-flight')

    // If `finally` did not run, this call returns null and the test goes red.
    const after = await createAdvisoryLock({ db, key: TEST_KEY }).acquire()
    expect(after).not.toBeNull()
    await after!.release()
  })

  it('two instances racing on the SAME key: exactly one settles, no sequence contention', async () => {
    const a = await orderReadyToSettle('100')
    const b = await orderReadyToSettle('200')

    // A slow fake so the two calls certainly overlap in time.
    const fake = createFakeStellar({ buildDelayMs: 30, submitDelayMs: 30 })

    const [ra, rb] = await Promise.all([
      settleOnce(a.id, { db, stellar: fake.port, lock: createAdvisoryLock({ db, key: TEST_KEY }) }),
      settleOnce(b.id, { db, stellar: fake.port, lock: createAdvisoryLock({ db, key: TEST_KEY }) }),
    ])

    const kinds = [ra.kind, rb.kind].sort()
    expect(kinds).toEqual(['pending', 'settled'])

    const skipped = [ra, rb].find((r) => r.kind === 'pending')!
    expect(skipped.reason).toBe('treasury_lock_unavailable')

    // The crux: NO tx_bad_seq, because only one tx gets built+submitted.
    expect(fake.maxConcurrent).toBe(1)
    expect(fake.calls.map((c) => c.op)).toEqual(['build', 'submit'])
    expect(fake.payments).toHaveLength(1)

    // The order that was yielded stays intact for the next pass to handle.
    const skippedOrder = await getOrder(skipped.orderId)
    expect(skippedOrder.status).toBe('settlement_ready')
    expect(await legsOf(skipped.orderId)).toHaveLength(0)
  })
})

describe('recoverPending under the lock', () => {
  it('lock unavailable ⇒ yields entirely, concludes nothing about any leg', async () => {
    const order = await orderReadyToSettle('100')
    // There is work for recover: one submitted leg.
    const { settlementsRepo } = await import('@/src/db/repo')
    const txHash = 'b'.repeat(64)
    await settlementsRepo.insertSubmitted(db, {
      orderId: order.id,
      txHash,
      signedXdr: `FAKEXDR:${Date.now() - 1000}:101:${txHash}`,
      sourceAccount: 'GTREASURYFAKE',
      destinationAccount: 'GPAYOUTFAKE',
      assetCode: 'USDC',
      assetIssuer: 'GISSUERFAKE',
      amount: '99.0000000',
      memo: order.referenceId,
    })

    const other = createAdvisoryLock({ db, key: TEST_KEY })
    const held = await other.acquire()

    const fake = createFakeStellar({ forbidBuild: true, forbidSubmit: true })
    const report = await recoverPending({
      db,
      stellar: fake.port,
      lock: createAdvisoryLock({ db, key: TEST_KEY }),
    })

    expect(report.lockUnavailable).toBe(true)
    expect(report.scanned).toBe(0)
    // No poll, no conclusion — the leg is left intact for the lock holder.
    expect(fake.calls).toHaveLength(0)
    expect(await legsOf(order.id).then((r) => r[0].status)).toBe('submitted')

    await held!.release()
  })
})

describe('createMemoryLock', () => {
  it('has the same try-lock semantics as the advisory lock, for tests without a DB', async () => {
    const lock = createMemoryLock()
    const first = await lock.acquire()
    expect(first).not.toBeNull()
    expect(lock.held()).toBe(true)
    expect(await lock.acquire()).toBeNull()
    await first!.release()
    expect(lock.held()).toBe(false)
    expect(await lock.acquire()).not.toBeNull()
  })
})
