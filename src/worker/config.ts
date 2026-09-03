/**
 * WORKER LOOP PARAMETERS.
 *
 * Deliberately does NOT import `@/src/stellar/config`: that file loads the
 * treasury keypair and builds the Horizon server at import time. The worker
 * loop only needs a few numbers, and unit tests must run without a real key.
 */
import 'dotenv/config'

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`)
  return Math.floor(n)
}

/** How often the DB is scanned for new orders. Also the default Horizon poll interval. */
export const POLL_INTERVAL_MS = positiveInt('SETTLEMENT_POLL_INTERVAL_MS', 3000)

/** The tx timebounds validity — used to derive a deadline when signed_xdr has no maxTime. */
export const TIMEBOUNDS_SEC = positiveInt('SETTLEMENT_TIMEBOUNDS_SEC', 180)

/** Orders fetched per pass. Still processed SEQUENTIALLY, one at a time. */
export const BATCH_SIZE = positiveInt('SETTLEMENT_BATCH_SIZE', 10)

/**
 * Maximum legs for one order. Each leg whose timebounds expire without reaching
 * a ledger is a legitimate retry, but retries must not be unbounded: once the
 * budget is spent the order goes to `rejected` for a real person to look at,
 * instead of spinning silently.
 */
export const MAX_SETTLEMENT_ATTEMPTS = positiveInt('SETTLEMENT_MAX_ATTEMPTS', 3)

/**
 * Poll window when `tx_bad_seq` comes back.
 *
 * bad_seq kills THAT SUBMIT definitively — the sequence it was signed with is
 * spent, so resubmitting this XDR can never work. The ORDER stays retryable,
 * which is why the error carries `retryable: true, resolution: 'rebuild'`: the
 * way out is a new leg, not this one.
 *
 * Rebuild is still not the first move. The sequence may be off precisely
 * because the OLD tx (same hash) already made it into a ledger and consumed
 * it — rebuilding before checking that pays twice. So poll the old hash first;
 * if it did land, that is already over and there is nothing left to wait for,
 * so a short window beats sitting out the full 180s. Short, but never skipped:
 * this is the double-send trap.
 */
export const BAD_SEQ_POLL_WINDOW_MS = positiveInt('SETTLEMENT_BAD_SEQ_POLL_MS', 5000)
