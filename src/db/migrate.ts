/**
 * Apply the SQL migrations in src/db/migrations.
 *
 * The connection is retried, because `docker compose up -d` returns as soon as
 * the container has been created — which is before Postgres is accepting
 * connections. Running this command right after it used to die with
 * `Error: read ECONNRESET`. The README now says `docker compose up -d --wait`,
 * which fixes the same problem from the other side; this retry means the script
 * is not brittle when someone leaves the flag out.
 *
 * Only connection-level failures are retried. A migration that is genuinely
 * broken must still fail immediately and loudly.
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set — see .env.example')

const TIMEOUT_MS = Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 60_000)
const STEP_MS = 2_000

/** Codes a Postgres that is still booting produces. Anything else is a real error. */
const STARTUP_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECTION_REFUSED',
  'CONNECT_TIMEOUT',
  '57P03', // cannot_connect_now — the server is starting up
  '53300', // too_many_connections — also transient while it settles
])

function isStillStartingUp(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' && STARTUP_CODES.has(code)
}

const client = postgres(url, { max: 1, onnotice: () => {} })

let attempt = 0
const deadline = Date.now() + TIMEOUT_MS

for (;;) {
  attempt++
  try {
    await migrate(drizzle(client), { migrationsFolder: './src/db/migrations' })
    break
  } catch (err) {
    if (!isStillStartingUp(err) || Date.now() >= deadline) {
      await client.end({ timeout: 5 }).catch(() => {})
      throw err
    }
    console.log(
      `db:migrate: the database is not accepting connections yet ` +
        `(attempt ${attempt}: ${(err as Error).message}) — retrying in ${STEP_MS / 1000}s`,
    )
    await new Promise((r) => setTimeout(r, STEP_MS))
  }
}

await client.end()

console.log(attempt === 1 ? 'migrations applied' : `migrations applied (after ${attempt} attempts)`)
