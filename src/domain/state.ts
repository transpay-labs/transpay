/**
 * STATE MACHINE for a transfer order.
 *
 * The transition table lives in types.ts (ALLOWED_TRANSITIONS) — this file only
 * reads it, and must never copy it. The DB adds a second guard via a CHECK
 * constraint.
 *
 * Principle #5: every transition writes one order_events row.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '@/src/db/client'
import { orderEvents, transferOrders } from '@/src/db/schema'
import { InvalidTransitionError } from '@/src/domain/errors'
import { ALLOWED_TRANSITIONS, TERMINAL_STATUSES } from '@/src/domain/types'
import type { OrderStatus, RejectReason } from '@/src/domain/types'

/** Drizzle transaction handle — derived from `db` itself so the types can't drift. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]
/**
 * Where a statement runs: pool or transaction. Taken structurally (Pick) rather
 * than as a `Db | DbTx` union — unioning the two drizzle types leaves TS unable
 * to call the methods.
 */
export type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

export interface TransitionInput {
  orderId: string
  from: OrderStatus
  to: OrderStatus
  /** Who or what triggered it: 'user' | 'worker' | 'script:evidence-d2' ... */
  actor: string
  /** Reference ID or tx hash — NOT the access token. */
  externalRef?: string | null
  detail?: Record<string, unknown> | null
  /** Only meaningful when `to` = 'rejected' | 'expired'. */
  rejectReason?: RejectReason | null
}

/** Whether `from` is allowed to move to `to` per the contract table. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/** Terminal status — nowhere left to go. */
export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** Like canTransition, but throws instead of returning false. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}

/**
 * Move an order to a new status inside a transaction.
 *
 * Optimistic guard: the UPDATE carries `status = from` in its WHERE. No row
 * touched ⇒ the current status is no longer `from` (someone moved first) ⇒
 * throw, never overwrite silently.
 */
export async function transitionOrder(tx: Executor, input: TransitionInput): Promise<void> {
  const { orderId, from, to, actor, externalRef = null, detail = null, rejectReason = null } = input

  assertTransition(from, to)

  const updated = await tx
    .update(transferOrders)
    .set({
      status: to,
      updatedAt: new Date(),
      ...(rejectReason ? { rejectReason } : {}),
    })
    .where(and(eq(transferOrders.id, orderId), eq(transferOrders.status, from)))
    .returning({ id: transferOrders.id })

  if (updated.length === 0) {
    // Read back so we report the real status — this information goes into evidence.
    const rows = await tx
      .select({ status: transferOrders.status })
      .from(transferOrders)
      .where(eq(transferOrders.id, orderId))
      .limit(1)
    throw new InvalidTransitionError(from, to, rows[0]?.status ?? null)
  }

  await tx.insert(orderEvents).values({
    orderId,
    fromStatus: from,
    toStatus: to,
    actor,
    externalRef,
    detail: rejectReason ? { ...(detail ?? {}), rejectReason } : detail,
  })
}
