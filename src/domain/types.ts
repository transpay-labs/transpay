/**
 * SHARED CONTRACT — every module reads from here.
 *
 * The decisions in this file were settled on 2026-09-03: the order lifecycle,
 * the reference ID format, and the placeholder quote constants.
 *
 * Changing anything here changes the schema, changes the memo on the ledger,
 * and breaks evidence that has already been generated. Treat it as frozen.
 */

// ─── Corridor ──────────────────────────────────────────────────────────────

/** Phase 1 opens PHP only. VND is reserved for a follow-on, NOT implemented now. */
export const CORRIDORS = ['PHP', 'VND'] as const
export type Corridor = (typeof CORRIDORS)[number]

export const ACTIVE_CORRIDOR: Corridor = 'PHP'

// ─── Transfer order lifecycle ──────────────────────────────────────────────

export const ORDER_STATUSES = [
  'draft',
  'quoted',
  'confirmed',
  'recipient_added',
  'awaiting_deposit',
  'settlement_ready',
  'settling',
  'settled',
  'rejected',
  'expired',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/**
 * Table of legal status transitions. This is the entire "state machine" — no
 * XState. Every transition must go through a guard that reads this table, and
 * the DB carries a matching CHECK constraint as the second line of defence.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ['quoted', 'expired'],
  quoted: ['confirmed', 'expired'],
  confirmed: ['recipient_added', 'expired'],
  recipient_added: ['awaiting_deposit', 'expired'],
  awaiting_deposit: ['settlement_ready', 'rejected', 'expired'],
  settlement_ready: ['settling', 'rejected'],
  settling: ['settled', 'rejected'],
  settled: [],
  rejected: [],
  expired: [],
} as const

/** Terminal statuses — nowhere left to go. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ['settled', 'rejected', 'expired']

// ─── Settlement leg ────────────────────────────────────────────────────────

export const SETTLEMENT_STATUSES = ['submitted', 'confirmed', 'failed'] as const
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number]

// ─── Reference ID & memo ───────────────────────────────────────────────────

/** Hard limit of MEMO_TEXT on Stellar. */
export const MEMO_MAX_BYTES = 28

/** `TP-{CORRIDOR}-{YYYYMMDD}-{SEQ4}` — e.g. `TP-PHP-20260907-0001` (20 bytes). */
export const REFERENCE_ID_PATTERN = /^TP-(PHP|VND)-\d{8}-\d{4}$/

/** Regex string reused verbatim in the Postgres CHECK constraint. */
export const REFERENCE_ID_SQL_PATTERN = '^TP-(PHP|VND)-[0-9]{8}-[0-9]{4}$'

/** SEQ4 restarts per (corridor, UTC day). */
export const MAX_SEQ_PER_DAY = 9999

/**
 * Access identifier, KEPT SEPARATE from reference_id.
 * Never appears in a memo, a log, or the evidence pack.
 */
export const ACCESS_TOKEN_LENGTH = 22

// ─── Quote ─────────────────────────────────────────────────────────────────

/**
 * Phase 1 uses a placeholder FX rate, it does NOT call a market rate
 * (out-of-scope #11). The numbers are fixed so ten test runs reproduce.
 */
export const PLACEHOLDER_FX_RATE_USD_PHP = '56.5000000'
export const PLACEHOLDER_FEE_RATE = '0.0100000' // 1% fee placeholder
export const QUOTE_TTL_SECONDS = 15 * 60

// ─── Stellar ───────────────────────────────────────────────────────────────

/** Stellar uses 7 decimal places for every asset. */
export const STELLAR_DECIMALS = 7

// ─── Reject reasons (used by the D2 negative tests) ────────────────────────

export const REJECT_REASONS = [
  'duplicate_deposit_reference',
  'mismatched_amount',
  'mismatched_order',
  'quote_expired',
  /** Lost the race: another process changed the status first. */
  'invalid_transition',
  /**
   * Settlement leg permanently broken: missing balance, wrong trustline, or a
   * tx that reached the ledger but failed. Not used for a leg that ran out of
   * timebounds — there the funds never left the wallet, so the order stays in
   * `settling` and the worker opens a new leg.
   */
  'settlement_failed',
] as const
export type RejectReason = (typeof REJECT_REASONS)[number]
