/**
 * Isolation of the worker lane's test data.
 *
 * The other lanes share the `transpay_fresh` DB and clean up by year 2099/2019
 * (see `src/domain/__tests__/db-setup.ts`). The worker takes YEAR 2098 as its
 * own namespace so no test file ever deletes another file's rows.
 *
 * A note on cleanup: `settlements.order_id` is ON DELETE RESTRICT, so
 * settlements must be deleted BEFORE transfer_orders — that same constraint is
 * what protects evidence from an accidental delete in production.
 */
import { sql } from 'drizzle-orm'
import { db } from '@/src/db/client'
import { ensureSchema } from '@/src/domain/__tests__/db-setup'

/** The year reserved for the worker's tests. */
export const WORKER_TEST_YEAR = '2098'
/** Every test order carries a reference of the form TP-PHP-2098xxxx-nnnn. */
export const WORKER_REF_LIKE = `TP-PHP-${WORKER_TEST_YEAR}%`
const WORKER_REF_REGEX = `^TP-(PHP|VND)-${WORKER_TEST_YEAR}`

/** The namespace's fixed date — quotes are always still valid against `new Date()`. */
export const WORKER_NOW = new Date(`${WORKER_TEST_YEAR}-04-05T08:00:00.000Z`)

export { ensureSchema }

export async function cleanupWorkerData(): Promise<void> {
  await db.execute(
    sql.raw(
      `DELETE FROM settlements WHERE order_id IN (SELECT id FROM transfer_orders WHERE reference_id ~ '${WORKER_REF_REGEX}')`,
    ),
  )
  await db.execute(sql.raw(`DELETE FROM transfer_orders WHERE reference_id ~ '${WORKER_REF_REGEX}'`))
  await db.execute(
    sql.raw(`DELETE FROM reference_counters WHERE to_char(day, 'YYYY') = '${WORKER_TEST_YEAR}'`),
  )
}

/** Close the pool so vitest can exit. */
export async function closeDb(): Promise<void> {
  const client = (db as unknown as { $client?: { end?: (opts?: unknown) => Promise<void> } }).$client
  await client?.end?.({ timeout: 5 })
}
