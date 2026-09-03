/**
 * SETTLEMENT LEG — build/sign/hash kept SEPARATE from submit.
 *
 * The mandatory sequence (invariant #6 in src/db/schema.ts):
 *
 *     buildSettlementTx()  → txHash + signedXdr      (no money sent yet)
 *     write settlements row → tx_hash, signed_xdr    (the DB knows first)
 *     submitSignedXdr()    → push it to Horizon
 *     pollTransaction()    → confirm it reached the ledger
 *
 * WHY they are separate: when Horizon returns a 504 we do NOT know whether the tx made
 * it into the ledger. If the tx were only created at that moment there would be nothing
 * to look up, and a blind retry = sending the money twice. With the hash already in the
 * DB, every ambiguous situation is settled by one question to Horizon: "is this hash in
 * the ledger?".
 */
import { Account, BASE_FEE, Memo, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { MEMO_MAX_BYTES, STELLAR_DECIMALS } from '@/src/domain/types'
import {
  ASSET_CODE,
  ASSET_ISSUER,
  NETWORK_PASSPHRASE,
  SETTLEMENT_ASSET,
  TIMEBOUNDS_SEC,
  horizonServer,
} from './config'
import { PAYOUT_PUBLIC, TREASURY_PUBLIC, treasuryKeypair } from './accounts'
import { SettlementValidationError, classifyHorizonError, type SettlementError } from './errors'

/** Fee at 10x base — testnet is never congested, this is just safety margin. */
const FEE_STROOPS = String(Number(BASE_FEE) * 10)

export interface BuildSettlementParams {
  /** The USDC amount to send, as a decimal string. Normalized to 7 digits. */
  amount: string
  /** Exactly transfer_orders.reference_id, nothing appended (invariant #4). */
  memo: string
  /** The tx's validity window in seconds. Defaults to SETTLEMENT_TIMEBOUNDS_SEC. */
  timeboundsSec?: number
  /**
   * The source account's CURRENT sequence (the tx will use sequence + 1, matching the
   * semantics of `new Account()`). Pass it in to build fully offline. Leave it out and
   * it is read from Horizon — read-only, it does NOT change ledger state.
   */
  accountSequence?: string
}

/** Every field needed to write a `settlements` row directly. */
export interface BuiltSettlementTx {
  /** Hash computed FROM THE SIGNED XDR — written to the DB before submitting. */
  txHash: string
  signedXdr: string
  source: string
  destination: string
  assetCode: string
  assetIssuer: string
  /** Amount normalized to 7 decimal digits — exactly what lands on the ledger. */
  amount: string
  memo: string
  /** Unix seconds. Past this mark the tx can never enter the ledger. */
  maxTimeSec: number
  /** Absolute deadline (ms) to hand to pollTransaction. */
  deadlineMs: number
  /** THE TX's sequence (= accountSequence + 1). Used to debug tx_bad_seq. */
  txSequence: string
}

export interface SubmitResult {
  ok: boolean
  txHash: string
  /** Available immediately if Horizon returns 200. On timeout it is undefined — poll. */
  ledgerSeq?: number
  /** Horizon's original response (when ok). */
  rawResponse?: unknown
  /** Present when ok === false. */
  error?: SettlementError
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalizes an amount to Stellar's exact 7 decimal digits without using floats.
 * Dropping significant digits is a bug (it loses the customer's money), so this throws
 * instead of rounding.
 */
export function formatStellarAmount(amount: string): string {
  const raw = String(amount).trim()
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new SettlementValidationError(`Invalid amount: "${amount}" (only positive decimal numbers, no sign or exponent).`)
  }
  const [intPart, fracRaw = ''] = raw.split('.')
  if (fracRaw.length > STELLAR_DECIMALS && /[1-9]/.test(fracRaw.slice(STELLAR_DECIMALS))) {
    throw new SettlementValidationError(
      `Amount "${amount}" has more than ${STELLAR_DECIMALS} significant decimal digits — Stellar cannot represent it, and rounding would lose money.`,
    )
  }
  const frac = fracRaw.slice(0, STELLAR_DECIMALS).padEnd(STELLAR_DECIMALS, '0')
  const normalized = `${intPart.replace(/^0+(?=\d)/, '')}.${frac}`
  if (Number(normalized) <= 0) {
    throw new SettlementValidationError(`Amount must be > 0, got "${amount}".`)
  }
  return normalized
}

/** MEMO_TEXT is measured in BYTES, not characters. */
export function assertMemoFits(memo: string): string {
  const bytes = Buffer.byteLength(memo, 'utf8')
  if (bytes === 0) throw new SettlementValidationError('Empty memo — a settlement must be bindable back to its reference_id.')
  if (bytes > MEMO_MAX_BYTES) {
    throw new SettlementValidationError(
      `Memo "${memo}" is ${bytes} bytes, over MEMO_TEXT's MEMO_MAX_BYTES=${MEMO_MAX_BYTES}.`,
    )
  }
  return memo
}

// ─── Step 1: build + sign + hash ───────────────────────────────────────────

/**
 * Build → sign → hash. Does NOT submit.
 *
 * Touches the network exactly once, read-only: fetching the treasury's sequence.
 * Pass `accountSequence` in to skip that read entirely.
 *
 * The caller MUST write `txHash` + `signedXdr` to the DB before calling
 * `submitSignedXdr`.
 */
export async function buildSettlementTx(params: BuildSettlementParams): Promise<BuiltSettlementTx> {
  const amount = formatStellarAmount(params.amount)
  const memo = assertMemoFits(params.memo)
  const timeboundsSec = params.timeboundsSec ?? TIMEBOUNDS_SEC
  if (!Number.isFinite(timeboundsSec) || timeboundsSec <= 0) {
    throw new SettlementValidationError(`timeboundsSec must be > 0, got ${timeboundsSec}.`)
  }

  // Sequence supplied by the caller ⇒ fully offline build. Without it, read from
  // Horizon — read-only, no ledger state changes.
  const account = params.accountSequence
    ? new Account(TREASURY_PUBLIC, params.accountSequence)
    : await horizonServer.loadAccount(TREASURY_PUBLIC)

  const maxTimeSec = Math.floor(Date.now() / 1000) + timeboundsSec

  const tx = new TransactionBuilder(account, {
    fee: FEE_STROOPS,
    networkPassphrase: NETWORK_PASSPHRASE,
    // TEXT memo — reviewers reconcile the memo on the ledger against reference_id.
    memo: Memo.text(memo),
  })
    .addOperation(
      Operation.payment({
        destination: PAYOUT_PUBLIC,
        asset: SETTLEMENT_ASSET,
        amount,
      }),
    )
    // maxTime is what turns "we don't know where the tx is" into a finite question:
    // past this mark, if Horizon still cannot see the hash ⇒ definitively failed.
    .setTimebounds(0, maxTimeSec)
    .build()

  tx.sign(treasuryKeypair)

  return {
    txHash: tx.hash().toString('hex'),
    signedXdr: tx.toXDR(),
    source: TREASURY_PUBLIC,
    destination: PAYOUT_PUBLIC,
    assetCode: ASSET_CODE,
    assetIssuer: ASSET_ISSUER,
    amount,
    memo,
    maxTimeSec,
    deadlineMs: maxTimeSec * 1000,
    txSequence: tx.sequence,
  }
}

// ─── Step 2: submit ────────────────────────────────────────────────────────

/**
 * Pushes the signed XDR to Horizon. Call this AFTER txHash is already in the DB.
 *
 * Does not throw: every error is classified into a SettlementError so the caller can
 * decide rebuild / poll / fail. For `timeout` specifically, never submit again.
 */
export async function submitSignedXdr(signedXdr: string): Promise<SubmitResult> {
  let tx: Transaction
  try {
    tx = new Transaction(signedXdr, NETWORK_PASSPHRASE)
  } catch (e) {
    throw new SettlementValidationError(`signedXdr could not be parsed: ${(e as Error).message}`)
  }
  const txHash = tx.hash().toString('hex')

  try {
    const res = await horizonServer.submitTransaction(tx)
    return {
      ok: true,
      txHash,
      ledgerSeq: typeof res.ledger === 'number' ? res.ledger : undefined,
      rawResponse: res,
    }
  } catch (err) {
    return { ok: false, txHash, error: classifyHorizonError(err) }
  }
}

/** Re-derives the hash from a signed XDR — used to reconcile the DB against evidence. */
export function txHashFromXdr(signedXdr: string): string {
  return new Transaction(signedXdr, NETWORK_PASSPHRASE).hash().toString('hex')
}

/**
 * Recovers the deadline (timebounds.maxTime) from a signed XDR.
 *
 * The `settlements` table has no maxTime column, so after the worker restarts midway
 * this is the only way to know how much longer to poll — all it needs is `signed_xdr`
 * already in the DB. No maxTime ⇒ the tx never expires, so this returns null and the
 * caller must set its own limit.
 */
export function deadlineMsFromXdr(signedXdr: string): number | null {
  const tx = new Transaction(signedXdr, NETWORK_PASSPHRASE)
  const maxTime = tx.timeBounds?.maxTime
  if (!maxTime || maxTime === '0') return null
  return Number(maxTime) * 1000
}
