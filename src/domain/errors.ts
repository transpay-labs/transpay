/**
 * TYPED ERRORS for the domain layer.
 *
 * Every error already carries a `RejectReason` (types.ts) so the layer above
 * can write it straight into `transfer_orders.reject_reason` instead of
 * re-mapping loose strings. Never put an access token into `message` or
 * `detail` — it must not leak into logs or evidence.
 */
import type { OrderStatus, RejectReason } from '@/src/domain/types'

export abstract class DomainError extends Error {
  /** Reason written to transfer_orders.reject_reason. */
  abstract readonly rejectReason: RejectReason
  /** Accompanying data, written to order_events.detail. */
  readonly detail: Record<string, unknown>

  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = new.target.name
    this.detail = detail
  }
}

/**
 * Invalid status transition — either it breaks the ALLOWED_TRANSITIONS table,
 * or the status in the DB is no longer `from` (someone moved first — lost race).
 */
export class InvalidTransitionError extends DomainError {
  readonly rejectReason: RejectReason = 'invalid_transition'
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    /** Status actually read from the DB; null when the order does not exist. */
    readonly actual: OrderStatus | null = from,
  ) {
    super(
      actual === from
        ? `Invalid status transition: ${from} -> ${to}`
        : `Status changed before the transition: expected ${from}, actual ${actual ?? 'order not found'} (was moving to ${to})`,
      { from, to, actual },
    )
  }
}

/** Quote is past `quote_expires_at` — no more confirming. */
export class QuoteExpiredError extends DomainError {
  readonly rejectReason: RejectReason = 'quote_expired'
  constructor(
    readonly orderId: string,
    readonly quoteExpiresAt: Date | null,
    readonly now: Date,
  ) {
    super(`Quote for order ${orderId} ${quoteExpiresAt ? `expired at ${quoteExpiresAt.toISOString()}` : 'was never issued'}`, {
      orderId,
      quoteExpiresAt: quoteExpiresAt?.toISOString() ?? null,
      now: now.toISOString(),
    })
  }
}

/**
 * Deposit reference has already been CONSUMED by another order.
 *
 * This is the genuine negative case: one deposit must not bind to two orders.
 * An identical replay from the VERY order that consumed it never reaches here —
 * that one is an idempotent no-op (see confirmDeposit).
 */
export class DuplicateDepositReferenceError extends DomainError {
  readonly rejectReason: RejectReason = 'duplicate_deposit_reference'
  constructor(
    readonly depositReference: string,
    readonly confirmedAt: Date | null,
    /** The order that consumed this reference earlier. */
    readonly ownerOrderId: string | null = null,
  ) {
    super(
      `Deposit reference ${depositReference} was already confirmed by ${ownerOrderId ? `order ${ownerOrderId}` : 'another order'} at ${confirmedAt?.toISOString() ?? 'an unknown time'}`,
      {
        depositReference,
        confirmedAt: confirmedAt?.toISOString() ?? null,
        ownerOrderId,
      },
    )
  }
}

/** Deposited amount differs from the amount that was quoted. */
export class AmountMismatchError extends DomainError {
  readonly rejectReason: RejectReason = 'mismatched_amount'
  constructor(
    readonly expectedUsdAmount: string,
    readonly actualUsdAmount: string,
  ) {
    super(`Amount mismatch: expected ${expectedUsdAmount} USD, received ${actualUsdAmount} USD`, {
      expectedUsdAmount,
      actualUsdAmount,
    })
  }
}

/** Deposit reference does not belong to this order (or the order is missing). */
export class OrderMismatchError extends DomainError {
  readonly rejectReason: RejectReason = 'mismatched_order'
  constructor(
    readonly orderId: string,
    readonly reason: string,
    detail: Record<string, unknown> = {},
  ) {
    super(`Order ${orderId} mismatch: ${reason}`, { orderId, reason, ...detail })
  }
}
