/**
 * Integration test — needs a real Postgres.
 * Focus: the status chain leaves evidence, and D2's three negative cases.
 */
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/src/db/client'
import { depositReferences, orderEvents, recipients } from '@/src/db/schema'
import {
  AmountMismatchError,
  DuplicateDepositReferenceError,
  InvalidTransitionError,
  OrderMismatchError,
  QuoteExpiredError,
} from '@/src/domain/errors'
import {
  addRecipient,
  confirmDeposit,
  confirmQuote,
  createOrder,
  getOrder,
  issueDepositReference,
} from '@/src/domain/orders'
import { transitionOrder } from '@/src/domain/state'
import { ACCESS_TOKEN_LENGTH, REFERENCE_ID_PATTERN } from '@/src/domain/types'
import { cleanupTestData, closeDb, ensureSchema } from './db-setup'

/** A 2099 date so test data never mixes with real evidence; the quote is always live. */
const FUTURE = new Date('2099-01-02T09:00:00.000Z')
/** A 2019 date so the quote is certainly expired relative to `new Date()`. */
const PAST = new Date('2019-03-04T09:00:00.000Z')

const RECIPIENT = {
  fullName: 'Maria Santos',
  bankName: 'BDO Unibank',
  accountNumber: '00123456789',
  bankCode: 'BNORPHMM',
}

const eventsOf = (orderId: string) =>
  db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt))

/** Drive an order to awaiting_deposit and return its deposit reference. */
async function orderAwaitingDeposit(usdAmount = '100') {
  const order = await createOrder({ usdAmount, now: FUTURE })
  await confirmQuote(order.id, FUTURE)
  await addRecipient(order.id, RECIPIENT)
  const { depositReference } = await issueDepositReference(order.id)
  return { orderId: order.id, depositReference, usdAmount }
}

beforeAll(async () => {
  await ensureSchema()
  await cleanupTestData()
})

afterAll(async () => {
  await cleanupTestData()
  await closeDb()
})

describe('createOrder', () => {
  it('allocates reference + access token + quote, stops at quoted', async () => {
    const order = await createOrder({ usdAmount: '100', now: FUTURE })

    expect(order.status).toBe('quoted')
    expect(order.referenceId).toMatch(REFERENCE_ID_PATTERN)
    expect(order.referenceId.startsWith('TP-PHP-20990102-')).toBe(true)
    expect(order.accessToken).toHaveLength(ACCESS_TOKEN_LENGTH)
    expect(order.usdAmount).toBe('100.0000000')
    expect(order.feeUsd).toBe('1.0000000')
    expect(order.phpEstimate).toBe('5593.50')
    expect(order.fxRate).toBe('56.5000000')
    expect(order.quoteExpiresAt).toBeInstanceOf(Date)

    const events = await eventsOf(order.id)
    expect(events).toHaveLength(1)
    expect(events[0].fromStatus).toBe('draft')
    expect(events[0].toStatus).toBe('quoted')
    expect(events[0].externalRef).toBe(order.referenceId)
  })

  it('references increment, access tokens never collide', async () => {
    const a = await createOrder({ usdAmount: '10', now: FUTURE })
    const b = await createOrder({ usdAmount: '10', now: FUTURE })
    expect(Number(b.referenceId.slice(-4))).toBe(Number(a.referenceId.slice(-4)) + 1)
    expect(a.accessToken).not.toBe(b.accessToken)
  })

  it('the access token does NOT leak into order_events', async () => {
    const order = await createOrder({ usdAmount: '55.5', now: FUTURE })
    const events = await eventsOf(order.id)
    const dump = JSON.stringify(events)
    expect(dump).not.toContain(order.accessToken)
  })

  it('an amount <= 0 is blocked before any DB write', async () => {
    await expect(createOrder({ usdAmount: '0', now: FUTURE })).rejects.toThrowError(RangeError)
  })
})

describe('happy path lifecycle', () => {
  it('quoted -> settlement_ready, one order_events row per step', async () => {
    const order = await createOrder({ usdAmount: '250', now: FUTURE })

    const confirmed = await confirmQuote(order.id, FUTURE)
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.confirmedAt).toBeInstanceOf(Date)

    const withRecipient = await addRecipient(order.id, RECIPIENT)
    expect(withRecipient.status).toBe('recipient_added')
    const savedRecipients = await db.select().from(recipients).where(eq(recipients.orderId, order.id))
    expect(savedRecipients).toHaveLength(1)

    const instruction = await issueDepositReference(order.id)
    expect(instruction.order.status).toBe('awaiting_deposit')
    expect(instruction.expectedUsdAmount).toBe('250.0000000')
    // The deposit reference DIFFERS from reference_id and never goes on the ledger.
    expect(instruction.depositReference).not.toBe(order.referenceId)
    expect(REFERENCE_ID_PATTERN.test(instruction.depositReference)).toBe(false)

    const settled = await confirmDeposit(order.id, {
      depositReference: instruction.depositReference,
      usdAmount: '250',
    })
    expect(settled.status).toBe('settlement_ready')
    expect(settled.rejectReason).toBeNull()

    const [dep] = await db
      .select()
      .from(depositReferences)
      .where(eq(depositReferences.orderId, order.id))
    expect(dep.confirmedAt).toBeInstanceOf(Date)

    const events = await eventsOf(order.id)
    expect(events.map((e) => e.toStatus)).toEqual([
      'quoted',
      'confirmed',
      'recipient_added',
      'awaiting_deposit',
      'settlement_ready',
    ])
    expect(events.map((e) => e.fromStatus)).toEqual([
      'draft',
      'quoted',
      'confirmed',
      'recipient_added',
      'awaiting_deposit',
    ])
    for (const e of events) expect(e.actor).toBe('user')
  })
})

describe('negative case — expired quote', () => {
  it('confirmQuote past the deadline ⇒ QuoteExpiredError, order goes expired with a reason', async () => {
    const order = await createOrder({ usdAmount: '100', now: PAST })

    await expect(confirmQuote(order.id, new Date())).rejects.toThrowError(QuoteExpiredError)

    const after = await getOrder(order.id)
    expect(after.status).toBe('expired')
    expect(after.rejectReason).toBe('quote_expired')
    expect(after.confirmedAt).toBeNull()

    const events = await eventsOf(order.id)
    expect(events.at(-1)?.toStatus).toBe('expired')
    expect(events.at(-1)?.detail).toMatchObject({ rejectReason: 'quote_expired' })
  })
})

describe('negative case — confirmDeposit', () => {
  it('amount mismatch ⇒ AmountMismatchError, order rejected/mismatched_amount', async () => {
    const { orderId, depositReference } = await orderAwaitingDeposit('100')

    await expect(
      confirmDeposit(orderId, { depositReference, usdAmount: '99.9999999' }),
    ).rejects.toThrowError(AmountMismatchError)

    const after = await getOrder(orderId)
    expect(after.status).toBe('rejected')
    expect(after.rejectReason).toBe('mismatched_amount')

    const [dep] = await db
      .select()
      .from(depositReferences)
      .where(eq(depositReferences.orderId, orderId))
    expect(dep.confirmedAt).toBeNull() // no binding when the amount differs

    const events = await eventsOf(orderId)
    expect(events.at(-1)?.toStatus).toBe('rejected')
    expect(events.at(-1)?.detail).toMatchObject({
      rejectReason: 'mismatched_amount',
      expectedUsdAmount: '100.0000000',
      actualUsdAmount: '99.9999999',
    })
  })

  it('IDENTICAL replay ⇒ idempotent: order stays settlement_ready, no extra event', async () => {
    const { orderId, depositReference } = await orderAwaitingDeposit('120')

    const first = await confirmDeposit(orderId, { depositReference, usdAmount: '120' })
    expect(first.status).toBe('settlement_ready')

    const eventsAfterFirst = await eventsOf(orderId)
    const [depAfterFirst] = await db
      .select()
      .from(depositReferences)
      .where(eq(depositReferences.orderId, orderId))

    // User double-click / client network retry: must leave no trace at all.
    const second = await confirmDeposit(orderId, { depositReference, usdAmount: '120' })
    expect(second.status).toBe('settlement_ready')
    expect(second.rejectReason).toBeNull()
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime())

    const eventsAfterSecond = await eventsOf(orderId)
    expect(eventsAfterSecond).toHaveLength(eventsAfterFirst.length)
    expect(eventsAfterSecond.at(-1)?.toStatus).toBe('settlement_ready')

    const [depAfterSecond] = await db
      .select()
      .from(depositReferences)
      .where(eq(depositReferences.orderId, orderId))
    expect(depAfterSecond.confirmedAt?.getTime()).toBe(depAfterFirst.confirmedAt?.getTime())
  })

  it('replay with the same reference but a DIFFERENT amount ⇒ still AmountMismatchError', async () => {
    const { orderId, depositReference } = await orderAwaitingDeposit('130')
    await confirmDeposit(orderId, { depositReference, usdAmount: '130' })

    await expect(
      confirmDeposit(orderId, { depositReference, usdAmount: '131' }),
    ).rejects.toThrowError(AmountMismatchError)

    const after = await getOrder(orderId)
    expect(after.status).toBe('rejected')
    expect(after.rejectReason).toBe('mismatched_amount')
  })

  it('reference already consumed by ANOTHER order ⇒ DuplicateDepositReferenceError', async () => {
    const a = await orderAwaitingDeposit('100')
    const b = await orderAwaitingDeposit('100')

    // A consumes its own reference first.
    expect((await confirmDeposit(a.orderId, { depositReference: a.depositReference, usdAmount: '100' })).status)
      .toBe('settlement_ready')

    // B reuses that exact reference: one deposit cannot bind two orders.
    await expect(
      confirmDeposit(b.orderId, { depositReference: a.depositReference, usdAmount: '100' }),
    ).rejects.toThrowError(DuplicateDepositReferenceError)

    const afterB = await getOrder(b.orderId)
    expect(afterB.status).toBe('rejected')
    expect(afterB.rejectReason).toBe('duplicate_deposit_reference')
    expect((await eventsOf(b.orderId)).at(-1)?.detail).toMatchObject({
      rejectReason: 'duplicate_deposit_reference',
      ownerOrderId: a.orderId,
    })

    // A is left untouched.
    const afterA = await getOrder(a.orderId)
    expect(afterA.status).toBe('settlement_ready')
    expect(afterA.rejectReason).toBeNull()
  })

  it('a reference owned by another order but NOT yet consumed ⇒ OrderMismatchError', async () => {
    const a = await orderAwaitingDeposit('100')
    const b = await orderAwaitingDeposit('100')

    await expect(
      confirmDeposit(b.orderId, { depositReference: a.depositReference, usdAmount: '100' }),
    ).rejects.toThrowError(OrderMismatchError)

    const afterB = await getOrder(b.orderId)
    expect(afterB.status).toBe('rejected')
    expect(afterB.rejectReason).toBe('mismatched_order')

    const afterA = await getOrder(a.orderId)
    expect(afterA.status).toBe('awaiting_deposit')
    expect(afterA.rejectReason).toBeNull()
  })

  it('nonexistent reference ⇒ OrderMismatchError', async () => {
    const { orderId } = await orderAwaitingDeposit('100')
    await expect(
      confirmDeposit(orderId, { depositReference: 'DEP-DOES-NOT-EXIST', usdAmount: '100' }),
    ).rejects.toThrowError(OrderMismatchError)
    expect((await getOrder(orderId)).status).toBe('rejected')
  })
})

describe('optimistic guard against races', () => {
  it('two concurrent confirmQuote calls: exactly one wins', async () => {
    const order = await createOrder({ usdAmount: '77', now: FUTURE })

    const results = await Promise.allSettled([
      confirmQuote(order.id, FUTURE),
      confirmQuote(order.id, FUTURE),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidTransitionError)

    expect((await getOrder(order.id)).status).toBe('confirmed')
    // Race won or lost, evidence still holds exactly one row for this step.
    const events = await eventsOf(order.id)
    expect(events.filter((e) => e.toStatus === 'confirmed')).toHaveLength(1)
  })

  it('transitionOrder with the wrong `from` ⇒ InvalidTransitionError, DB unchanged', async () => {
    const order = await createOrder({ usdAmount: '88', now: FUTURE })

    await expect(
      db.transaction((tx) =>
        transitionOrder(tx, {
          orderId: order.id,
          from: 'confirmed',
          to: 'recipient_added',
          actor: 'test',
        }),
      ),
    ).rejects.toThrowError(InvalidTransitionError)

    expect((await getOrder(order.id)).status).toBe('quoted')
    expect(await eventsOf(order.id)).toHaveLength(1)
  })

  it('a transition outside ALLOWED_TRANSITIONS is blocked immediately, DB untouched', async () => {
    const order = await createOrder({ usdAmount: '99', now: FUTURE })
    await expect(
      db.transaction((tx) =>
        transitionOrder(tx, { orderId: order.id, from: 'quoted', to: 'settled', actor: 'test' }),
      ),
    ).rejects.toThrowError(InvalidTransitionError)
    expect((await getOrder(order.id)).status).toBe('quoted')
  })
})

describe('transfer_orders holds its schema invariants', () => {
  it('reference_id always fits the 28-byte memo', async () => {
    const order = await createOrder({ usdAmount: '1', now: FUTURE })
    expect(Buffer.byteLength(order.referenceId, 'utf8')).toBeLessThanOrEqual(28)
  })
})
