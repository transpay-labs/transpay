/**
 * REPO — settlements.
 *
 * The mandatory order (invariant #6): compute tx_hash from the signed XDR → WRITE
 * THE DB → only then submit to Horizon. If the process dies midway, the DB still
 * holds the tx_hash to reconcile against, and the DB constraint still forbids a
 * second leg for the same order.
 *
 * Every function here takes an `Executor`, not a `Db`: both a pool and a transaction
 * handle work. That is not convenience — `markConfirmed` MUST run in the same
 * transaction as `transitionOrder(settling → settled)`. The `settled` status and the
 * tx_hash are one single fact; letting them commit separately opens a window where
 * the order is settled but the leg is not yet confirmed (or vice versa), and D2's
 * evidence pack then reads two different answers to the same question.
 */
import { and, desc, eq, ne } from 'drizzle-orm'
import type { Executor } from '@/src/domain/state'
import { settlements, transferOrders } from '../schema'
import { CONSTRAINTS, SettlementConflictError, isUniqueViolation } from './errors'

export type Settlement = typeof settlements.$inferSelect

export type InsertSubmittedInput = {
  orderId: string
  txHash: string
  signedXdr: string
  sourceAccount: string
  destinationAccount: string
  assetCode: string
  assetIssuer: string
  /** Decimal string with 7 fractional digits — Stellar uses 7 decimals. */
  amount: string
  /** EXACTLY transfer_orders.reference_id, nothing appended (invariant #4). */
  memo: string
}

/**
 * Writes the leg in status `submitted` BEFORE submitting it to the network.
 *
 * Throws `SettlementConflictError` when the DB rejects a duplicate — upper layers can
 * tell that apart from any other DB error (other errors are rethrown untouched). NO app
 * logic checks "is there a settlement already": that is the job of the partial unique
 * index `settlements_active_order_key`, atomic even when two workers race.
 */
export async function insertSubmitted(db: Executor, input: InsertSubmittedInput): Promise<Settlement> {
  try {
    const [row] = await db.insert(settlements).values({ ...input, status: 'submitted' }).returning()
    return row
  } catch (e) {
    if (isUniqueViolation(e, CONSTRAINTS.settlementsTxHash)) {
      throw new SettlementConflictError('duplicate_tx_hash', CONSTRAINTS.settlementsTxHash, { cause: e })
    }
    if (isUniqueViolation(e, CONSTRAINTS.settlementsActiveOrder)) {
      throw new SettlementConflictError('active_settlement', CONSTRAINTS.settlementsActiveOrder, { cause: e })
    }
    throw e
  }
}

/** The ledger has confirmed — only here may an order be considered settled. */
export async function markConfirmed(
  db: Executor,
  txHash: string,
  /**
   * `null` when Horizon confirms but returns no ledger number. Write null, NOT 0:
   * the evidence pack is the entire deliverable, and a wrong ledger number is worse
   * than an empty cell — an empty cell tells the reader to go look it up.
   */
  ledgerSeq: number | null,
  horizonResponse: unknown,
): Promise<Settlement | null> {
  const [row] = await db
    .update(settlements)
    .set({ status: 'confirmed', ledgerSeq, horizonResponse, confirmedAt: new Date() })
    .where(eq(settlements.txHash, txHash))
    .returning()
  return row ?? null
}

/**
 * Permanent failure (timebounds elapsed / Horizon rejected it). After this the order
 * may have a new leg — the partial unique index ignores `failed` rows.
 */
export async function markFailed(db: Executor, txHash: string, reason: string): Promise<Settlement | null> {
  const [row] = await db
    .update(settlements)
    .set({ status: 'failed', failureReason: reason })
    .where(eq(settlements.txHash, txHash))
    .returning()
  return row ?? null
}

/** An order's live leg (submitted or confirmed). At most 1 — guaranteed by the DB. */
export async function findActiveByOrderId(db: Executor, orderId: string): Promise<Settlement | null> {
  const [row] = await db
    .select()
    .from(settlements)
    .where(and(eq(settlements.orderId, orderId), ne(settlements.status, 'failed')))
    .limit(1)
  return row ?? null
}

export async function findByTxHash(db: Executor, txHash: string): Promise<Settlement | null> {
  const [row] = await db.select().from(settlements).where(eq(settlements.txHash, txHash)).limit(1)
  return row ?? null
}

/** Every leg of an order, failed ones included — proves a retry was legitimate. */
export async function listByOrderId(db: Executor, orderId: string): Promise<Settlement[]> {
  return db
    .select()
    .from(settlements)
    .where(eq(settlements.orderId, orderId))
    .orderBy(desc(settlements.submittedAt))
}

// ─── Evidence D2 ───────────────────────────────────────────────────────────

/** One row of the D2 results table (a settlement leg on the ledger). */
export type SettlementEvidenceRow = {
  referenceId: string
  txHash: string
  status: string
  memo: string
  sourceAccount: string
  destinationAccount: string
  assetCode: string
  assetIssuer: string
  amount: string
  ledgerSeq: number | null
  submittedAt: Date
  confirmedAt: Date | null
  failureReason: string | null
}

export async function listForEvidence(db: Executor, limit = 100): Promise<SettlementEvidenceRow[]> {
  return db
    .select({
      referenceId: transferOrders.referenceId,
      txHash: settlements.txHash,
      status: settlements.status,
      memo: settlements.memo,
      sourceAccount: settlements.sourceAccount,
      destinationAccount: settlements.destinationAccount,
      assetCode: settlements.assetCode,
      assetIssuer: settlements.assetIssuer,
      amount: settlements.amount,
      ledgerSeq: settlements.ledgerSeq,
      submittedAt: settlements.submittedAt,
      confirmedAt: settlements.confirmedAt,
      failureReason: settlements.failureReason,
    })
    .from(settlements)
    .innerJoin(transferOrders, eq(transferOrders.id, settlements.orderId))
    .orderBy(desc(settlements.submittedAt))
    .limit(limit)
}
