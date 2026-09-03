/**
 * THE STELLAR PORT — the only boundary between the worker and the network.
 *
 * The worker does not import `@/src/stellar` directly. Why:
 *   1. Unit tests must run WITHOUT touching the network and without a real
 *      secret — they inject a fake implementation through this interface.
 *   2. The real implementation loads the module via dynamic import, so
 *      CORRIDOR_TREASURY_SECRET is read only when the worker actually runs.
 *
 * These four methods are EXACTLY the four things the Stellar lane verified with
 * real transactions. Do not add a "rebuildAndSubmit" method or anything like
 * it: rebuilding is the road to double-send, it has to be an explicit decision
 * made in settle.ts.
 */
import type { PollResult } from '@/src/stellar/horizon'
import type { BuildSettlementParams, BuiltSettlementTx, SubmitResult } from '@/src/stellar/settlement'

export type { PollResult, BuildSettlementParams, BuiltSettlementTx, SubmitResult }

export interface PollOptions {
  intervalMs?: number
  signal?: AbortSignal
}

export interface StellarPort {
  /** Build + sign + hash. Does NOT touch ledger state (only reads the sequence). */
  buildSettlementTx(params: BuildSettlementParams): Promise<BuiltSettlementTx>
  /** Push the signed XDR to Horizon. Idempotent for the EXACT old XDR (verified). */
  submitSignedXdr(signedXdr: string): Promise<SubmitResult>
  /** Poll until the hash is seen or the deadline passes. */
  pollTransaction(txHash: string, deadlineMs: number, opts?: PollOptions): Promise<PollResult>
  /** Re-read timebounds.maxTime from signed_xdr — used after a worker restart. */
  deadlineMsFromXdr(signedXdr: string): Promise<number | null>
}

/** Load `@/src/stellar` once, lazily — importing it reads the secret and builds Horizon. */
let stellarModule: Promise<typeof import('@/src/stellar')> | null = null
const stellar = () => (stellarModule ??= import('@/src/stellar'))

/** The real implementation. Deliberately thin: every decision lives in settle.ts. */
export const liveStellarPort: StellarPort = {
  async buildSettlementTx(params) {
    return (await stellar()).buildSettlementTx(params)
  },
  async submitSignedXdr(signedXdr) {
    return (await stellar()).submitSignedXdr(signedXdr)
  },
  async pollTransaction(txHash, deadlineMs, opts) {
    return (await stellar()).pollTransaction(txHash, deadlineMs, opts)
  },
  async deadlineMsFromXdr(signedXdr) {
    return (await stellar()).deadlineMsFromXdr(signedXdr)
  },
}
