/**
 * MAPS HORIZON ERRORS → a meaningful union type.
 *
 * The crux of the whole settlement module: telling apart
 *   - TRANSIENT errors → retryable (build a fresh tx)
 *   - PERMANENT errors → mark the settlement failed
 *   - TIMEOUT          → do NEITHER. The tx may already be in the ledger.
 *                        You must poll the same old tx hash until timebounds elapse.
 *
 * Getting this wrong = sending the money twice.
 */

export const SETTLEMENT_ERROR_KINDS = [
  'tx_bad_seq',
  'tx_too_late',
  'tx_insufficient_balance',
  'timeout',
  'unknown',
] as const
export type SettlementErrorKind = (typeof SETTLEMENT_ERROR_KINDS)[number]

/**
 * What the caller has to do next:
 *   'rebuild' — build a new tx (new sequence), write the DB, then submit again
 *   'poll'    — do NOT submit again. Poll the same old hash until timebounds elapse.
 *   'fail'    — conclude failure and mark the settlement failed.
 */
export type SettlementErrorResolution = 'rebuild' | 'poll' | 'fail'

export interface SettlementError {
  kind: SettlementErrorKind
  /** Transient (true) or permanent (false). timeout is transient but its resolution = 'poll'. */
  retryable: boolean
  resolution: SettlementErrorResolution
  /** A message safe to store in settlements.failure_reason. */
  message: string
  /** Horizon's HTTP status, if any. */
  status?: number
  /** extras.result_codes from Horizon — evidence for when someone digs back in. */
  resultCodes?: { transaction?: string; operations?: string[] }
  /** Horizon's original JSON body, kept verbatim for the evidence record. */
  raw?: unknown
}

/** Shape of the errors the Horizon SDK throws (v13: NetworkError with .response.data). */
interface HorizonErrorLike {
  message?: string
  response?: {
    status?: number
    statusText?: string
    data?: {
      status?: number
      title?: string
      detail?: string
      extras?: {
        result_codes?: { transaction?: string; operations?: string[] }
        result_xdr?: string
      }
    }
  }
}

function asHorizonError(err: unknown): HorizonErrorLike {
  return (typeof err === 'object' && err !== null ? err : {}) as HorizonErrorLike
}

/** Transaction result codes treated as expired / too late. */
const TOO_LATE = new Set(['tx_too_late', 'tx_bad_minseq_age_or_gap'])
/** Codes treated as insufficient funds / limit exhausted. */
const INSUFFICIENT = new Set(['tx_insufficient_balance'])
const INSUFFICIENT_OPS = new Set(['op_underfunded', 'op_line_full'])
/** Corridor misconfiguration (missing trustline, wrong destination) — permanent, needs a manual fix. */
const MISCONFIGURED_OPS = new Set(['op_no_trust', 'op_no_destination', 'op_not_authorized'])

function isTimeoutish(err: unknown, status?: number): boolean {
  if (status === 504 || status === 502 || status === 503) return true
  const e = err as { code?: string; name?: string; message?: string }
  const code = e?.code ?? ''
  if (['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) return true
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return true
  return /timeout|timed out|socket hang up|network error|fetch failed/i.test(e?.message ?? '')
}

/**
 * Normalizes any Horizon / network error into a SettlementError.
 * Never throws — always returns some kind, at worst 'unknown'.
 */
export function classifyHorizonError(err: unknown): SettlementError {
  const h = asHorizonError(err)
  const status = h.response?.status ?? h.response?.data?.status
  const data = h.response?.data
  const resultCodes = data?.extras?.result_codes
  const txCode = resultCodes?.transaction
  const opCodes = resultCodes?.operations ?? []

  // Timeout / lost network: conclude NOTHING about the ledger. Poll instead.
  if (isTimeoutish(err, status)) {
    return {
      kind: 'timeout',
      retryable: true,
      resolution: 'poll',
      message: `Horizon gave no definitive answer (${status ?? 'network'}). The tx may already be in the ledger — poll the hash, do NOT submit again.`,
      status,
      resultCodes,
      raw: data ?? String((err as Error)?.message ?? err),
    }
  }

  // tx_bad_seq: someone else consumed the sequence. Building a fresh tx is safe
  // ONLY once the old tx is known not to be in the ledger — the caller must poll the old hash first.
  if (txCode === 'tx_bad_seq') {
    return {
      kind: 'tx_bad_seq',
      retryable: true,
      resolution: 'rebuild',
      message: 'tx_bad_seq — sequence mismatch. Poll the old hash first; if it is not there, build a new leg.',
      status,
      resultCodes,
      raw: data,
    }
  }

  if (txCode && TOO_LATE.has(txCode)) {
    return {
      kind: 'tx_too_late',
      retryable: false,
      resolution: 'fail',
      message: `${txCode} — past timebounds, this tx can never enter the ledger. Mark it failed, then open a new leg.`,
      status,
      resultCodes,
      raw: data,
    }
  }

  if ((txCode && INSUFFICIENT.has(txCode)) || opCodes.some((c) => INSUFFICIENT_OPS.has(c))) {
    return {
      kind: 'tx_insufficient_balance',
      retryable: false,
      resolution: 'fail',
      message: `Insufficient balance / trustline: transaction=${txCode ?? '-'} operations=[${opCodes.join(',')}]. Top up the treasury, then try a new leg.`,
      status,
      resultCodes,
      raw: data,
    }
  }

  const badOps = opCodes.filter((c) => MISCONFIGURED_OPS.has(c))
  if (badOps.length > 0) {
    return {
      kind: 'unknown',
      retryable: false,
      resolution: 'fail',
      message: `Corridor misconfigured: operations=[${badOps.join(',')}]. Check the payout account's USDC trustline and the issuer in .env — retrying will not help.`,
      status,
      resultCodes,
      raw: data,
    }
  }

  const detail = data?.detail ?? data?.title ?? h.message ?? String(err)
  return {
    kind: 'unknown',
    // 5xx not caught above → treat as transient; 4xx → permanent.
    retryable: typeof status === 'number' ? status >= 500 : false,
    resolution: typeof status === 'number' && status >= 500 ? 'poll' : 'fail',
    message: `Unrecognized Horizon error (${status ?? '-'}): ${detail}${txCode ? ` [${txCode}]` : ''}`,
    status,
    resultCodes,
    raw: data ?? detail,
  }
}

/** Errors thrown by the settlement module itself (input validation), not by the network. */
export class SettlementValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementValidationError'
  }
}
