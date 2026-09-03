/**
 * POLLS HORIZON by tx hash.
 *
 * This is the last piece of the double-spend defence: once the hash is in the DB, every
 * ambiguous situation (504, lost network, process dying midway) reduces to one single
 * question — "is this hash in the ledger yet?" — and that question has a finite deadline
 * because the tx set timebounds.maxTime.
 *
 * rawResponse comes from a plain fetch rather than the SDK: the SDK's object carries
 * `_links` with callback functions, which JSON.stringify drops. Evidence needs the full
 * JSON exactly as Horizon returned it — the testnet reset (2026-12-16) will wipe the
 * history, and at that point this blob is the only proof left.
 */
import { HORIZON_URL, POLL_INTERVAL_MS } from './config'
import { classifyHorizonError, type SettlementError } from './errors'

export interface PollResult {
  found: boolean
  ledgerSeq?: number
  /** Verbatim JSON from Horizon. undefined when not found. */
  rawResponse?: unknown
  /** true if it reached the ledger but its result was failed (successful === false). */
  txSuccessful?: boolean
  /** Why polling stopped when found === false. */
  reason?: 'deadline' | 'aborted' | 'error' | 'not_found'
  /** The last error hit while querying Horizon (if any). */
  lastError?: SettlementError
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A single Horizon lookup. Not found ⇒ null. Any error other than 404 ⇒ throw. */
export async function fetchTransaction(txHash: string): Promise<Record<string, unknown> | null> {
  const url = `${HORIZON_URL}/transactions/${txHash}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })

  if (res.status === 404) return null
  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = await res.text().catch(() => '')
    }
    // Throw in the SDK's error shape so classifyHorizonError handles it uniformly.
    throw Object.assign(new Error(`Horizon ${res.status} while looking up tx ${txHash}`), {
      response: { status: res.status, data: body },
    })
  }
  return (await res.json()) as Record<string, unknown>
}

/**
 * Polls until the tx shows up or `deadlineMs` passes (take it from
 * BuiltSettlementTx.deadlineMs = timebounds.maxTime).
 *
 * Past the deadline and still nothing ⇒ the tx can never enter the ledger, so it is
 * safe to mark it failed and open a new leg.
 */
export async function pollTransaction(
  txHash: string,
  deadlineMs: number,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS
  let lastError: SettlementError | undefined

  for (;;) {
    if (opts.signal?.aborted) return { found: false, reason: 'aborted', lastError }

    try {
      const record = await fetchTransaction(txHash)
      if (record) {
        const ledger = record['ledger'] ?? record['ledger_attr']
        return {
          found: true,
          ledgerSeq: typeof ledger === 'number' ? ledger : Number(ledger) || undefined,
          txSuccessful: record['successful'] !== false,
          rawResponse: record,
        }
      }
    } catch (err) {
      // A 5xx or a flaky network is not a conclusion — keep polling until the deadline.
      lastError = classifyHorizonError(err)
      // A permanent error on the LOOKUP itself (404 is handled above) makes further polling pointless.
      if (!lastError.retryable) return { found: false, reason: 'error', lastError }
    }

    // Only once timebounds elapse may we conclude failure — before that the tx can still land.
    if (Date.now() >= deadlineMs) return { found: false, reason: 'deadline', lastError }

    const remaining = deadlineMs - Date.now()
    await sleep(Math.max(250, Math.min(intervalMs, remaining)))
  }
}

/** One-shot lookup, no loop — for the evidence scripts and manual reconciliation. */
export async function lookupTransaction(txHash: string): Promise<PollResult> {
  try {
    const record = await fetchTransaction(txHash)
    if (!record) return { found: false, reason: 'not_found' }
    const ledger = record['ledger']
    return {
      found: true,
      ledgerSeq: typeof ledger === 'number' ? ledger : Number(ledger) || undefined,
      txSuccessful: record['successful'] !== false,
      rawResponse: record,
    }
  } catch (err) {
    return { found: false, reason: 'error', lastError: classifyHorizonError(err) }
  }
}
