/**
 * Build the schema for integration tests.
 *
 * The real migrations come from another lane (src/db/migrations). Tests must not
 * depend on whether those have run, so here we rebuild exactly the tables we
 * need with idempotent DDL (CREATE ... IF NOT EXISTS). If the migrations ran
 * first, every statement here is a no-op.
 *
 * Test data is isolated by DATE: every order/counter in the tests uses a day in
 * 2099 or 2019, so it never touches another lane's evidence data.
 */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { db } from '@/src/db/client'
import {
  CORRIDORS,
  MEMO_MAX_BYTES,
  ORDER_STATUSES,
  REFERENCE_ID_SQL_PATTERN,
  SETTLEMENT_STATUSES,
} from '@/src/domain/types'

const enumDdl = (name: string, values: readonly string[]) =>
  `DO $$ BEGIN CREATE TYPE ${name} AS ENUM (${values.map((v) => `'${v}'`).join(', ')});` +
  ` EXCEPTION WHEN duplicate_object THEN NULL; END $$;`

const STATEMENTS: string[] = [
  enumDdl('order_status', ORDER_STATUSES),
  enumDdl('settlement_status', SETTLEMENT_STATUSES),
  enumDdl('corridor', CORRIDORS),

  `CREATE TABLE IF NOT EXISTS transfer_orders (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     reference_id text NOT NULL,
     access_token text NOT NULL,
     corridor corridor NOT NULL,
     status order_status NOT NULL DEFAULT 'draft',
     usd_amount numeric(20,7) NOT NULL,
     php_estimate numeric(20,2),
     fx_rate numeric(20,7),
     fee_usd numeric(20,7),
     quoted_at timestamptz,
     quote_expires_at timestamptz,
     confirmed_at timestamptz,
     reject_reason text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT reference_id_format CHECK (reference_id ~ '${REFERENCE_ID_SQL_PATTERN}'),
     CONSTRAINT reference_id_fits_memo CHECK (octet_length(reference_id) <= ${MEMO_MAX_BYTES}),
     CONSTRAINT usd_amount_positive CHECK (usd_amount > 0),
     CONSTRAINT reference_id_matches_corridor CHECK (reference_id LIKE 'TP-' || corridor::text || '-%')
   );`,
  // CREATE TABLE IF NOT EXISTS cannot patch a table left over from an old migration.
  `DO $$ BEGIN
     ALTER TABLE transfer_orders ADD CONSTRAINT reference_id_matches_corridor
       CHECK (reference_id LIKE 'TP-' || corridor::text || '-%');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS transfer_orders_reference_id_key ON transfer_orders (reference_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS transfer_orders_access_token_key ON transfer_orders (access_token);`,
  `CREATE INDEX IF NOT EXISTS transfer_orders_status_idx ON transfer_orders (status);`,

  `CREATE TABLE IF NOT EXISTS recipients (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     order_id uuid NOT NULL REFERENCES transfer_orders(id) ON DELETE CASCADE,
     full_name text NOT NULL,
     bank_name text NOT NULL,
     account_number text NOT NULL,
     bank_code text,
     created_at timestamptz NOT NULL DEFAULT now()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS recipients_order_id_key ON recipients (order_id);`,

  `CREATE TABLE IF NOT EXISTS deposit_references (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     order_id uuid NOT NULL REFERENCES transfer_orders(id) ON DELETE CASCADE,
     deposit_reference text NOT NULL,
     expected_usd_amount numeric(20,7) NOT NULL,
     confirmed_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS deposit_references_reference_key ON deposit_references (deposit_reference);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS deposit_references_order_id_key ON deposit_references (order_id);`,

  `CREATE TABLE IF NOT EXISTS settlements (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     order_id uuid NOT NULL REFERENCES transfer_orders(id) ON DELETE RESTRICT,
     tx_hash text NOT NULL,
     signed_xdr text NOT NULL,
     status settlement_status NOT NULL DEFAULT 'submitted',
     source_account text NOT NULL,
     destination_account text NOT NULL,
     asset_code text NOT NULL,
     asset_issuer text NOT NULL,
     amount numeric(20,7) NOT NULL,
     memo text NOT NULL,
     ledger_seq integer,
     horizon_response jsonb,
     submitted_at timestamptz NOT NULL DEFAULT now(),
     confirmed_at timestamptz,
     failure_reason text,
     CONSTRAINT memo_fits CHECK (octet_length(memo) <= ${MEMO_MAX_BYTES})
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS settlements_tx_hash_key ON settlements (tx_hash);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS settlements_active_order_key ON settlements (order_id) WHERE status <> 'failed';`,

  `CREATE TABLE IF NOT EXISTS reference_counters (
     corridor corridor NOT NULL,
     day date NOT NULL,
     next_seq integer NOT NULL DEFAULT 1,
     PRIMARY KEY (corridor, day)
   );`,

  `CREATE TABLE IF NOT EXISTS order_events (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     order_id uuid NOT NULL REFERENCES transfer_orders(id) ON DELETE CASCADE,
     from_status order_status,
     to_status order_status NOT NULL,
     actor text NOT NULL,
     external_ref text,
     detail jsonb,
     created_at timestamptz NOT NULL DEFAULT now()
   );`,
  `CREATE INDEX IF NOT EXISTS order_events_order_id_idx ON order_events (order_id, created_at);`,
]

let ready: Promise<void> | null = null

/**
 * Run the DDL on a connection of its own, with server notices silenced.
 *
 * Every statement above is idempotent, so on a database that already has the
 * schema Postgres answers each one with
 * `NOTICE: relation "..." already exists, skipping` — dozens of lines that look
 * like errors in the test output but are exactly the intended no-op. `onnotice`
 * can only be set when a client is created, and the application's pool
 * (src/db/client.ts) must keep its default behaviour, so schema setup gets its
 * own short-lived client and closes it again.
 */
async function applyDdl(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set — see .env.example')

  const client = postgres(url, { max: 1, onnotice: () => {} })
  try {
    for (const stmt of STATEMENTS) await client.unsafe(stmt)
  } finally {
    await client.end({ timeout: 5 })
  }
}

export function ensureSchema(): Promise<void> {
  ready ??= applyDdl()
  return ready
}

/** Years reserved for tests — never collides with another lane's real data. */
export const TEST_YEARS = ['2099', '2019'] as const

/** Wipe every trace of the tests (children follow via ON DELETE CASCADE). */
export async function cleanupTestData(): Promise<void> {
  await db.execute(sql.raw(`DELETE FROM transfer_orders WHERE reference_id ~ '^TP-(PHP|VND)-(2099|2019)'`))
  await db.execute(sql.raw(`DELETE FROM reference_counters WHERE to_char(day, 'YYYY') IN ('2099', '2019')`))
}

/** Close the pool so vitest can exit instead of hanging on an open handle. */
export async function closeDb(): Promise<void> {
  const client = (db as unknown as { $client?: { end?: (opts?: unknown) => Promise<void> } }).$client
  await client?.end?.({ timeout: 5 })
}
