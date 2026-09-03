/**
 * SERVER-ONLY (imported by route handlers only — the `server-only` package is
 * not a dependency, so this is a convention; leave it as is). Looks up an order
 * by access token and builds the public payload.
 *
 * Two invariants for this file:
 *   1. Look up an order ONLY by access_token. There is no path that looks one
 *      up by reference_id — references are sequential, hence guessable.
 *   2. The returned payload lists every field by hand (never spreads the row),
 *      so access_token cannot leak out when the schema gains a column.
 */
import { eq } from 'drizzle-orm'
import { db } from '@/src/db/client'
import { ordersRepo, settlementsRepo } from '@/src/db/repo'
import type { TransferOrder } from '@/src/db/repo'
import { depositReferences } from '@/src/db/schema'
import { fromUnits, toUnits } from '@/src/domain/money'
import { STELLAR_DECIMALS } from '@/src/domain/types'
import { HttpError, notFound } from './http'
import type { PublicOrder, PublicSettlement } from './types'

/** Testnet explorer link — inlined here so the web layer need not import
 *  `src/stellar/config`, which throws at import time if Stellar env is absent. */
export function stellarExpertTxUrl(txHash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${txHash}`
}

/** Keep the last 4 digits. The full account number never leaves the server. */
function maskAccount(accountNumber: string): string {
  const tail = accountNumber.slice(-4)
  return accountNumber.length <= 4 ? tail : `••••${tail}`
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)

/** usdAmount - feeUsd. Recomputed from the DB, never taken from the client. */
function netUsd(order: TransferOrder): string | null {
  if (!order.feeUsd) return null
  return fromUnits(
    toUnits(order.usdAmount, STELLAR_DECIMALS) - toUnits(order.feeUsd, STELLAR_DECIMALS),
    STELLAR_DECIMALS,
  )
}

/** Look up an order by access token. A wrong token and a missing order both give 404. */
export async function requireOrderByToken(token: string): Promise<TransferOrder> {
  const order = await ordersRepo.findByAccessToken(db, token)
  if (!order) throw notFound()
  return order
}

/** This order's own deposit reference (issued at the deposit-reference step). */
export async function findDepositRow(orderId: string) {
  const [row] = await db
    .select()
    .from(depositReferences)
    .where(eq(depositReferences.orderId, orderId))
    .limit(1)
  return row ?? null
}

/** Same as above but required — used at the confirm-deposit step. */
export async function requireDepositReference(orderId: string): Promise<string> {
  const row = await findDepositRow(orderId)
  if (!row) {
    throw new HttpError(
      409,
      'deposit_reference_missing',
      'This transaction has not been issued a deposit reference yet.',
    )
  }
  return row.depositReference
}

function toPublicSettlement(
  s: Awaited<ReturnType<typeof settlementsRepo.findActiveByOrderId>>,
): PublicSettlement | null {
  if (!s) return null
  return {
    txHash: s.txHash,
    status: s.status,
    memo: s.memo,
    amount: s.amount,
    assetCode: s.assetCode,
    ledgerSeq: s.ledgerSeq,
    submittedAt: s.submittedAt.toISOString(),
    confirmedAt: iso(s.confirmedAt),
    failureReason: s.failureReason,
    explorerUrl: stellarExpertTxUrl(s.txHash),
  }
}

/**
 * Build the public payload from an order that has already been looked up.
 *
 * Re-reads the order from the DB via findWithRecipient to fetch the recipient in
 * the same round trip; if the order was deleted in the meantime, treat it as 404.
 */
export async function toPublicOrder(order: TransferOrder): Promise<PublicOrder> {
  const [withRecipient, deposit, settlement] = await Promise.all([
    ordersRepo.findWithRecipient(db, order.id),
    findDepositRow(order.id),
    settlementsRepo.findActiveByOrderId(db, order.id),
  ])
  if (!withRecipient) throw notFound()

  const o = withRecipient.order
  const r = withRecipient.recipient

  return {
    referenceId: o.referenceId,
    corridor: o.corridor,
    status: o.status,
    usdAmount: o.usdAmount,
    feeUsd: o.feeUsd,
    netUsd: netUsd(o),
    fxRate: o.fxRate,
    phpEstimate: o.phpEstimate,
    quotedAt: iso(o.quotedAt),
    quoteExpiresAt: iso(o.quoteExpiresAt),
    confirmedAt: iso(o.confirmedAt),
    rejectReason: o.rejectReason,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    recipient: r
      ? {
          fullName: r.fullName,
          bankName: r.bankName,
          bankCode: r.bankCode,
          accountNumberMasked: maskAccount(r.accountNumber),
        }
      : null,
    deposit: deposit
      ? {
          depositReference: deposit.depositReference,
          expectedUsdAmount: deposit.expectedUsdAmount,
          confirmedAt: iso(deposit.confirmedAt),
        }
      : null,
    settlement: toPublicSettlement(settlement),
  }
}
