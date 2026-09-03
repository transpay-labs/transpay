/**
 * BUSINESS OPERATIONS on a transfer order. One function = one transaction.
 *
 * Conventions throughout:
 *   - A status change ALWAYS goes through transitionOrder ⇒ there is always a
 *     matching order_events row.
 *   - The negative cases (D2) do more than throw: the order has to come to rest
 *     at 'rejected' with a reject_reason. Because throwing inside a transaction
 *     rolls it back, the reject is written in a SEPARATE transaction after the
 *     business transaction has finished cleanly.
 *   - The access token is only ever generated and written to transfer_orders,
 *     never into order_events / detail / logs.
 */
import { eq } from 'drizzle-orm'
import { db } from '@/src/db/client'
import { depositReferences, recipients, transferOrders } from '@/src/db/schema'
import { generateDepositReference } from '@/src/domain/deposit'
import {
  AmountMismatchError,
  DuplicateDepositReferenceError,
  OrderMismatchError,
  QuoteExpiredError,
} from '@/src/domain/errors'
import type { DomainError } from '@/src/domain/errors'
import { normalizeAmount, toUnits } from '@/src/domain/money'
import { computeQuote, isQuoteExpired } from '@/src/domain/quote'
import { allocateReferenceId } from '@/src/domain/reference'
import { canTransition, transitionOrder } from '@/src/domain/state'
import type { Executor } from '@/src/domain/state'
import { generateAccessToken } from '@/src/domain/token'
import { ACTIVE_CORRIDOR, STELLAR_DECIMALS } from '@/src/domain/types'
import type { Corridor } from '@/src/domain/types'

export type TransferOrder = typeof transferOrders.$inferSelect

const DEFAULT_ACTOR = 'user'

// ─── Shared helpers ────────────────────────────────────────────────────────

/** Read an order, locking the row if inside a transaction. Missing ⇒ OrderMismatch. */
async function loadOrder(tx: Executor, orderId: string, lock = true): Promise<TransferOrder> {
  const q = tx.select().from(transferOrders).where(eq(transferOrders.id, orderId)).limit(1)
  const rows = lock ? await q.for('update') : await q
  const order = rows[0]
  if (!order) throw new OrderMismatchError(orderId, 'order does not exist')
  return order
}

/** Read an order outside a transaction — used for the value returned after commit. */
export async function getOrder(orderId: string): Promise<TransferOrder> {
  return loadOrder(db, orderId, false)
}

/**
 * Write status 'rejected' + reject_reason in its own transaction.
 * If the order is already in a status that can no longer be rejected
 * (terminal), skip it — the error still propagates, we just don't overwrite
 * history.
 */
async function rejectOrder(orderId: string, err: DomainError, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ status: transferOrders.status })
      .from(transferOrders)
      .where(eq(transferOrders.id, orderId))
      .limit(1)
      .for('update')
    const current = rows[0]?.status
    if (!current || !canTransition(current, 'rejected')) return
    await transitionOrder(tx, {
      orderId,
      from: current,
      to: 'rejected',
      actor,
      detail: err.detail,
      rejectReason: err.rejectReason,
    })
  })
}

// ─── createOrder ───────────────────────────────────────────────────────────

export interface CreateOrderInput {
  usdAmount: string | number
  corridor?: Corridor
  /** Injected time so tests reproduce; defaults to now. */
  now?: Date
  actor?: string
}

/** draft -> quoted. Allocates reference ID, access token and quote in one tx. */
export async function createOrder(input: CreateOrderInput): Promise<TransferOrder> {
  const now = input.now ?? new Date()
  const corridor = input.corridor ?? ACTIVE_CORRIDOR
  const actor = input.actor ?? DEFAULT_ACTOR
  const quote = computeQuote(input.usdAmount, now)

  return db.transaction(async (tx) => {
    const referenceId = await allocateReferenceId(tx, corridor, now)

    const [inserted] = await tx
      .insert(transferOrders)
      .values({
        referenceId,
        accessToken: generateAccessToken(),
        corridor,
        usdAmount: normalizeAmount(input.usdAmount, STELLAR_DECIMALS),
        fxRate: quote.fxRate,
        feeUsd: quote.feeUsd,
        phpEstimate: quote.phpEstimate,
        quotedAt: quote.quotedAt,
        quoteExpiresAt: quote.quoteExpiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    await transitionOrder(tx, {
      orderId: inserted.id,
      from: 'draft',
      to: 'quoted',
      actor,
      externalRef: referenceId,
      // Quote figures only — NO access token here.
      detail: { fxRate: quote.fxRate, feeUsd: quote.feeUsd, phpEstimate: quote.phpEstimate },
    })

    return loadOrder(tx, inserted.id, false)
  })
}

// ─── confirmQuote ──────────────────────────────────────────────────────────

/** quoted -> confirmed. Expired quote ⇒ order goes to 'expired' and we throw. */
export async function confirmQuote(
  orderId: string,
  now: Date = new Date(),
  actor: string = DEFAULT_ACTOR,
): Promise<TransferOrder> {
  const expired = await db.transaction(async (tx) => {
    const order = await loadOrder(tx, orderId)
    if (isQuoteExpired(order, now)) return order

    await transitionOrder(tx, {
      orderId,
      from: 'quoted',
      to: 'confirmed',
      actor,
      externalRef: order.referenceId,
    })
    await tx.update(transferOrders).set({ confirmedAt: now }).where(eq(transferOrders.id, orderId))
    return null
  })

  if (expired) {
    const err = new QuoteExpiredError(orderId, expired.quoteExpiresAt, now)
    if (canTransition(expired.status, 'expired')) {
      await db.transaction((tx) =>
        transitionOrder(tx, {
          orderId,
          from: expired.status,
          to: 'expired',
          actor,
          externalRef: expired.referenceId,
          detail: err.detail,
          rejectReason: err.rejectReason,
        }),
      )
    }
    throw err
  }

  return getOrder(orderId)
}

// ─── addRecipient ──────────────────────────────────────────────────────────

export interface RecipientInput {
  fullName: string
  bankName: string
  accountNumber: string
  bankCode?: string | null
}

/** confirmed -> recipient_added. An order has exactly one recipient. */
export async function addRecipient(
  orderId: string,
  recipient: RecipientInput,
  actor: string = DEFAULT_ACTOR,
): Promise<TransferOrder> {
  return db.transaction(async (tx) => {
    const order = await loadOrder(tx, orderId)

    await tx.insert(recipients).values({
      orderId,
      fullName: recipient.fullName,
      bankName: recipient.bankName,
      accountNumber: recipient.accountNumber,
      bankCode: recipient.bankCode ?? null,
    })

    await transitionOrder(tx, {
      orderId,
      from: 'confirmed',
      to: 'recipient_added',
      actor,
      externalRef: order.referenceId,
      // Don't log the full account number into evidence.
      detail: { bankName: recipient.bankName, bankCode: recipient.bankCode ?? null },
    })

    return loadOrder(tx, orderId, false)
  })
}

// ─── issueDepositReference ─────────────────────────────────────────────────

export interface DepositInstruction {
  order: TransferOrder
  depositReference: string
  expectedUsdAmount: string
}

/** recipient_added -> awaiting_deposit. Mints the mock deposit string (never on the ledger). */
export async function issueDepositReference(
  orderId: string,
  actor: string = DEFAULT_ACTOR,
): Promise<DepositInstruction> {
  return db.transaction(async (tx) => {
    const order = await loadOrder(tx, orderId)
    const depositReference = generateDepositReference(order)

    await tx.insert(depositReferences).values({
      orderId,
      depositReference,
      expectedUsdAmount: order.usdAmount,
    })

    await transitionOrder(tx, {
      orderId,
      from: 'recipient_added',
      to: 'awaiting_deposit',
      actor,
      externalRef: depositReference,
      detail: { expectedUsdAmount: order.usdAmount },
    })

    return {
      order: await loadOrder(tx, orderId, false),
      depositReference,
      expectedUsdAmount: order.usdAmount,
    }
  })
}

// ─── confirmDeposit ────────────────────────────────────────────────────────

export interface ConfirmDepositInput {
  depositReference: string
  usdAmount: string | number
}

/**
 * awaiting_deposit -> settlement_ready.
 *
 * Three branches, kept strictly apart — a harmless replay must NOT kill an
 * order that is doing fine:
 *
 *   A. Identical replay (same reference, same order, same amount, reference
 *      already confirmed): IDEMPOTENT. Return the current order, change no
 *      status, write no new order_events. A user double-clicking or a client
 *      retrying over the network must leave no trace in the evidence pack.
 *   B. Reference already CONSUMED by another order: DuplicateDepositReferenceError.
 *      This is D2's real negative case — one deposit, two orders.
 *   C. Reference does not exist / unconsumed but owned by another order:
 *      OrderMismatchError. Amount differs: AmountMismatchError.
 *
 * Branches B and C move the order to 'rejected' with a reject_reason before
 * throwing. The last guard is still the partial unique index on
 * settlements.order_id: whichever branch fires, a second live settlement leg
 * is impossible.
 */
export async function confirmDeposit(
  orderId: string,
  input: ConfirmDepositInput,
  actor: string = DEFAULT_ACTOR,
): Promise<TransferOrder> {
  const failure = await db.transaction<DomainError | null>(async (tx) => {
    await loadOrder(tx, orderId)

    const [row] = await tx
      .select()
      .from(depositReferences)
      .where(eq(depositReferences.depositReference, input.depositReference))
      .limit(1)
      .for('update')

    if (!row) {
      return new OrderMismatchError(orderId, 'deposit reference does not exist', {
        depositReference: input.depositReference,
      })
    }

    if (row.orderId !== orderId) {
      // Branch B: another order already consumed this reference.
      if (row.confirmedAt) {
        return new DuplicateDepositReferenceError(
          input.depositReference,
          row.confirmedAt,
          row.orderId,
        )
      }
      // Branch C: the reference is real, but it isn't this order's.
      return new OrderMismatchError(orderId, 'deposit reference belongs to a different order', {
        depositReference: input.depositReference,
        ownerOrderId: row.orderId,
      })
    }

    const expected = toUnits(row.expectedUsdAmount, STELLAR_DECIMALS)
    const actual = toUnits(input.usdAmount, STELLAR_DECIMALS)

    // Branch A: this very order already consumed this reference at this exact amount ⇒ no-op.
    if (row.confirmedAt && expected === actual) return null

    if (expected !== actual) {
      return new AmountMismatchError(
        normalizeAmount(row.expectedUsdAmount, STELLAR_DECIMALS),
        normalizeAmount(input.usdAmount, STELLAR_DECIMALS),
      )
    }

    const confirmedAt = new Date()
    await tx
      .update(depositReferences)
      .set({ confirmedAt })
      .where(eq(depositReferences.id, row.id))

    await transitionOrder(tx, {
      orderId,
      from: 'awaiting_deposit',
      to: 'settlement_ready',
      actor,
      externalRef: input.depositReference,
      detail: { usdAmount: normalizeAmount(input.usdAmount, STELLAR_DECIMALS) },
    })

    return null
  })

  if (failure) {
    await rejectOrder(orderId, failure, actor)
    throw failure
  }

  return getOrder(orderId)
}
