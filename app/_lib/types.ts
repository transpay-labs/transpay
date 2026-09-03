/**
 * TYPES SHARED between the route handlers and the UI.
 *
 * This file imports NOTHING from `src/` — a client component can import it
 * without pulling the db client or the stellar sdk into the browser bundle.
 *
 * Invariant: there is no `accessToken` field here. The token appears exactly
 * once, in the body of POST /api/orders (the CreateOrderResponse type).
 */
import type { OrderStatus } from '@/src/domain/types'

export type { OrderStatus }

export interface PublicRecipient {
  fullName: string
  bankName: string
  bankCode: string | null
  /** Last 4 digits only — the full account number never leaves the server. */
  accountNumberMasked: string
}

export interface PublicDeposit {
  depositReference: string
  expectedUsdAmount: string
  confirmedAt: string | null
}

export interface PublicSettlement {
  txHash: string
  status: 'submitted' | 'confirmed' | 'failed'
  memo: string
  amount: string
  assetCode: string
  ledgerSeq: number | null
  submittedAt: string
  confirmedAt: string | null
  failureReason: string | null
  /** stellar.expert testnet link — what reviewers click. */
  explorerUrl: string
}

export interface PublicOrder {
  /** Public, and also the memo on the ledger. */
  referenceId: string
  corridor: string
  status: OrderStatus
  usdAmount: string
  feeUsd: string | null
  netUsd: string | null
  fxRate: string | null
  phpEstimate: string | null
  quotedAt: string | null
  quoteExpiresAt: string | null
  confirmedAt: string | null
  rejectReason: string | null
  createdAt: string
  updatedAt: string
  recipient: PublicRecipient | null
  deposit: PublicDeposit | null
  settlement: PublicSettlement | null
}

/** The ONLY response that carries the access token. */
export interface CreateOrderResponse {
  order: PublicOrder
  accessToken: string
}

export interface OrderResponse {
  order: PublicOrder
}

export interface ApiErrorBody {
  error: string
  message: string
  /** Only on a 409 caused by a status mismatch — lets the UI resync. */
  currentStatus?: OrderStatus
  /** Only on a 400 raised by Zod. */
  issues?: { path: string; message: string }[]
}
