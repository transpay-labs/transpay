/**
 * REPO — transfer_orders. Typed queries for the layers above (route handlers,
 * worker, evidence generation scripts). Holds no business rules; the state machine
 * and the constraints live in `src/domain/types.ts` and in the DB.
 */
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { depositReferences, recipients, transferOrders } from '../schema'

export type TransferOrder = typeof transferOrders.$inferSelect
export type NewTransferOrder = typeof transferOrders.$inferInsert
export type Recipient = typeof recipients.$inferSelect

// ─── Single-row reads ──────────────────────────────────────────────────────

export async function findById(db: Db, id: string): Promise<TransferOrder | null> {
  const [row] = await db.select().from(transferOrders).where(eq(transferOrders.id, id)).limit(1)
  return row ?? null
}

export async function findByReferenceId(db: Db, referenceId: string): Promise<TransferOrder | null> {
  const [row] = await db
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.referenceId, referenceId))
    .limit(1)
  return row ?? null
}

/**
 * Look up by URL access key. Used only to authorize reading one order —
 * access_token is NEVER written into a memo, a log, or evidence.
 */
export async function findByAccessToken(db: Db, accessToken: string): Promise<TransferOrder | null> {
  const [row] = await db
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.accessToken, accessToken))
    .limit(1)
  return row ?? null
}

/** Order together with its recipient — used by the detail screen. */
export async function findWithRecipient(
  db: Db,
  id: string,
): Promise<{ order: TransferOrder; recipient: Recipient | null } | null> {
  const [row] = await db
    .select({ order: transferOrders, recipient: recipients })
    .from(transferOrders)
    .leftJoin(recipients, eq(recipients.orderId, transferOrders.id))
    .where(eq(transferOrders.id, id))
    .limit(1)
  return row ? { order: row.order, recipient: row.recipient } : null
}

// ─── Evidence D1 ───────────────────────────────────────────────────────────

/** One row of the D1 results table (10 runs: quote → confirm → reference). */
export type OrderEvidenceRow = {
  referenceId: string
  corridor: string
  status: string
  usdAmount: string
  phpEstimate: string | null
  fxRate: string | null
  feeUsd: string | null
  quotedAt: Date | null
  quoteExpiresAt: Date | null
  confirmedAt: Date | null
  recipientName: string | null
  recipientBank: string | null
  recipientAccount: string | null
  depositReference: string | null
  depositConfirmedAt: Date | null
  createdAt: Date
}

/**
 * Every field the D1 results table needs. Deliberately does NOT select access_token —
 * the evidence pack is what reviewers get, and the token must not leak into it.
 */
export async function listForEvidence(db: Db, limit = 100): Promise<OrderEvidenceRow[]> {
  return db
    .select({
      referenceId: transferOrders.referenceId,
      corridor: transferOrders.corridor,
      status: transferOrders.status,
      usdAmount: transferOrders.usdAmount,
      phpEstimate: transferOrders.phpEstimate,
      fxRate: transferOrders.fxRate,
      feeUsd: transferOrders.feeUsd,
      quotedAt: transferOrders.quotedAt,
      quoteExpiresAt: transferOrders.quoteExpiresAt,
      confirmedAt: transferOrders.confirmedAt,
      recipientName: recipients.fullName,
      recipientBank: recipients.bankName,
      recipientAccount: recipients.accountNumber,
      depositReference: depositReferences.depositReference,
      depositConfirmedAt: depositReferences.confirmedAt,
      createdAt: transferOrders.createdAt,
    })
    .from(transferOrders)
    .leftJoin(recipients, eq(recipients.orderId, transferOrders.id))
    .leftJoin(depositReferences, eq(depositReferences.orderId, transferOrders.id))
    .orderBy(desc(transferOrders.createdAt))
    .limit(limit)
}
