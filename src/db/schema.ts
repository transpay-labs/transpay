/**
 * SCHEMA — the source of truth for every order state.
 *
 * Invariants (Docs / Transfer Order — State Model):
 *   1. A mock deposit reference ≠ settlement, it is only a trigger.
 *   2. Only the ledger can move settling → settled.
 *   3. 1 order ⇒ at most 1 live settlement leg.
 *   4. The tx memo = exactly reference_id, nothing appended.
 *   5. Every state transition records evidence.
 *   6. Write tx_hash to the DB BEFORE submitting.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  MEMO_MAX_BYTES,
  ORDER_STATUSES,
  REFERENCE_ID_SQL_PATTERN,
  SETTLEMENT_STATUSES,
  CORRIDORS,
} from '@/src/domain/types'

export const orderStatus = pgEnum('order_status', ORDER_STATUSES)
export const settlementStatus = pgEnum('settlement_status', SETTLEMENT_STATUSES)
export const corridor = pgEnum('corridor', CORRIDORS)

// ─── transfer_orders ───────────────────────────────────────────────────────

export const transferOrders = pgTable(
  'transfer_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Public, and carried in the tx memo. Reviewers reconcile against this string. */
    referenceId: text('reference_id').notNull(),

    /** URL access key. NEVER reaches the ledger, logs, or evidence. */
    accessToken: text('access_token').notNull(),

    corridor: corridor('corridor').notNull(),
    status: orderStatus('status').notNull().default('draft'),

    usdAmount: numeric('usd_amount', { precision: 20, scale: 7 }).notNull(),
    phpEstimate: numeric('php_estimate', { precision: 20, scale: 2 }),
    fxRate: numeric('fx_rate', { precision: 20, scale: 7 }),
    feeUsd: numeric('fee_usd', { precision: 20, scale: 7 }),

    quotedAt: timestamp('quoted_at', { withTimezone: true }),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),

    rejectReason: text('reject_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('transfer_orders_reference_id_key').on(t.referenceId),
    uniqueIndex('transfer_orders_access_token_key').on(t.accessToken),
    index('transfer_orders_status_idx').on(t.status),
    check('reference_id_format', sql`${t.referenceId} ~ ${sql.raw(`'${REFERENCE_ID_SQL_PATTERN}'`)}`),
    // Redundant in logic (the regex already blocks it) but kept so a schema reader sees WHY
    // reference_id is length-capped: it has to fit inside Stellar's MEMO_TEXT.
    check('reference_id_fits_memo', sql`octet_length(${t.referenceId}) <= ${sql.raw(String(MEMO_MAX_BYTES))}`),
    check('usd_amount_positive', sql`${t.usdAmount} > 0`),
    // The corridor inside reference_id must match the corridor column. Without this check
    // an order with corridor='PHP' could still carry reference 'TP-VND-...' — and that wrong
    // string goes straight into the memo on the ledger, corrupting the evidence forever.
    check(
      'reference_id_matches_corridor',
      sql`${t.referenceId} LIKE 'TP-' || ${t.corridor}::text || '-%'`,
    ),
  ],
)

// ─── recipients ────────────────────────────────────────────────────────────

export const recipients = pgTable(
  'recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => transferOrders.id, { onDelete: 'cascade' }),

    fullName: text('full_name').notNull(),
    bankName: text('bank_name').notNull(),
    accountNumber: text('account_number').notNull(),
    /** PHP: domestic bank code. Left as text because Phase 1 does not validate against real banks. */
    bankCode: text('bank_code'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('recipients_order_id_key').on(t.orderId)],
)

// ─── deposit_references ────────────────────────────────────────────────────

/**
 * Mock USD deposit reference. This is NOT a settlement — confirming it only pushes
 * the order to settlement_ready for the worker to pick up.
 */
export const depositReferences = pgTable(
  'deposit_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => transferOrders.id, { onDelete: 'cascade' }),

    /** Deposit instruction string (mock). Distinct from the order's reference_id. */
    depositReference: text('deposit_reference').notNull(),
    expectedUsdAmount: numeric('expected_usd_amount', { precision: 20, scale: 7 }).notNull(),

    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Starting mark for the SOW's "average time to settlement bind". */

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('deposit_references_reference_key').on(t.depositReference),
    uniqueIndex('deposit_references_order_id_key').on(t.orderId),
  ],
)

// ─── settlements ───────────────────────────────────────────────────────────

export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => transferOrders.id, { onDelete: 'restrict' }),

    /** Computed from the signed XDR and written here BEFORE submitting to Horizon. */
    txHash: text('tx_hash').notNull(),
    /** Signed XDR — fallback evidence for when the testnet reset wipes Horizon. */
    signedXdr: text('signed_xdr').notNull(),

    status: settlementStatus('status').notNull().default('submitted'),

    sourceAccount: text('source_account').notNull(),
    destinationAccount: text('destination_account').notNull(),
    assetCode: text('asset_code').notNull(),
    assetIssuer: text('asset_issuer').notNull(),
    amount: numeric('amount', { precision: 20, scale: 7 }).notNull(),
    /** Exactly equal to transfer_orders.reference_id. */
    memo: text('memo').notNull(),

    ledgerSeq: integer('ledger_seq'),
    /** Full Horizon response at confirmation — evidence that survives the reset. */
    horizonResponse: jsonb('horizon_response'),

    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
  },
  (t) => [
    uniqueIndex('settlements_tx_hash_key').on(t.txHash),
    // 1 order ⇒ at most 1 LIVE settlement. A tx that failed permanently (past its
    // timebounds) may be retried with a new leg. This is exactly D2's duplicate
    // settlement barrier — no separate app logic does this job.
    uniqueIndex('settlements_active_order_key')
      .on(t.orderId)
      .where(sql`status <> 'failed'`),
    check('memo_fits', sql`octet_length(${t.memo}) <= ${sql.raw(String(MEMO_MAX_BYTES))}`),
  ],
)

// ─── reference_counters ────────────────────────────────────────────────────

/** Hands out SEQ4 atomically per (corridor, UTC day). No races. */
export const referenceCounters = pgTable(
  'reference_counters',
  {
    corridor: corridor('corridor').notNull(),
    day: date('day').notNull(),
    nextSeq: integer('next_seq').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.corridor, t.day] })],
)

// ─── order_events ──────────────────────────────────────────────────────────

/** Invariant #5: every state transition is recorded together with its evidence. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => transferOrders.id, { onDelete: 'cascade' }),

    fromStatus: orderStatus('from_status'),
    toStatus: orderStatus('to_status').notNull(),
    /** Who/what triggered it: 'user' | 'worker' | 'script:evidence-d2' ... */
    actor: text('actor').notNull(),
    /** External reference: a reference ID or a tx hash. */
    externalRef: text('external_ref'),
    detail: jsonb('detail'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('order_events_order_id_idx').on(t.orderId, t.createdAt)],
)
