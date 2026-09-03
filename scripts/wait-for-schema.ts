/**
 * Wait for the schema to appear before the worker enters its loop.
 *
 * Migrations are run by the `web` service at boot (Railway's Postgres only
 * listens on the private network, so it cannot be migrated from outside). The
 * worker can come up before web, and it used to crash with
 * `relation "transfer_orders" does not exist` and then crash-loop until Railway
 * gave up.
 *
 * The worker does NOT run migrations itself: two processes migrating in parallel
 * can collide. It only waits — one job, done plainly.
 */
import 'dotenv/config'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('wait-for-schema: DATABASE_URL is not set')
  process.exit(1)
}

const TIMEOUT_MS = Number(process.env.SCHEMA_WAIT_TIMEOUT_MS ?? 180_000)
const STEP_MS = 3_000
const deadline = Date.now() + TIMEOUT_MS

const sql = postgres(url, { max: 1, onnotice: () => {} })

let attempt = 0
while (Date.now() < deadline) {
  attempt++
  try {
    const [row] = await sql`select to_regclass('public.transfer_orders') is not null as ready`
    if (row?.ready) {
      console.log(`wait-for-schema: schema ready after ${attempt} attempt(s)`)
      await sql.end()
      process.exit(0)
    }
    console.log(`wait-for-schema: table not there yet, waiting for the migration (attempt ${attempt})`)
  } catch (err) {
    // A DB not accepting connections yet is a valid waiting state too, not a fatal error.
    console.log(`wait-for-schema: DB not reachable yet (attempt ${attempt}): ${(err as Error)?.message}`)
  }
  await new Promise((r) => setTimeout(r, STEP_MS))
}

console.error(
  `wait-for-schema: ${TIMEOUT_MS}ms elapsed and the transfer_orders table never appeared. ` +
    'Check the logs of the web service — did the migration run?',
)
await sql.end()
process.exit(1)
