/**
 * SETTLE ONE ORDER — the heart of the worker.
 *
 * The order of steps is mandatory, and is the entire reason the worker exists:
 *
 *     buildSettlementTx        (build + sign + hash, NO network yet)
 *       → insertSubmitted      (WRITE THE DB FIRST: tx_hash + signed_xdr)
 *       → transitionOrder      (settlement_ready → settling)
 *       → submitSignedXdr      (only now push it to Horizon)
 *       → pollTransaction      (until it is seen or the timebounds expire)
 *       → markConfirmed + transitionOrder (settling → settled), ONE transaction
 *
 * Four facts verified with real transactions on testnet; the design below
 * follows each one closely:
 *
 *   1. Horizon is IDEMPOTENT for the exact old signed XDR ⇒ on resume, RESUBMIT
 *      THE OLD XDR. Never rebuild to "try again". Rebuild = two payments.
 *   2. `tx_bad_seq` is a trap: the sequence mismatch may be because the old tx
 *      ALREADY made it into a ledger.
 *      ⇒ POLL THE OLD HASH FIRST. Only once it is certainly absent may a new
 *      leg be opened.
 *   3. The treasury sequence is shared across EVERY order ⇒ the worker submits
 *      GLOBALLY SEQUENTIALLY. That constraint is enforced in index.ts (one
 *      order at a time).
 *   4. `deadlineMsFromXdr(signed_xdr)` tells how long polling must still go on
 *      after the worker was killed mid-flight.
 *
 * Outcome classification (important — this is where money is easiest to lose):
 *   - `settled` : the ledger confirmed it. Only the ledger can open this state.
 *   - `retry`   : the LEG is broken but the ORDER is still alive (the tx can
 *                 certainly never reach a ledger any more). markFailed the leg,
 *                 the order stays in `settling`, the next pass builds a new leg.
 *                 The money never left the wallet.
 *   - `failed`  : permanently broken at the ORDER level (misconfiguration,
 *                 insufficient balance, tx included in a ledger but result
 *                 failed, retry budget exhausted) ⇒ `rejected`.
 *   - `pending` : no conclusion possible yet (flaky network, shutdown). Change
 *                 NOTHING, retry next pass. Silence is the right answer here.
 *   - `skipped` : the order is not the worker's job.
 */
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import { db as liveDb } from '@/src/db/client'
import type { Db } from '@/src/db/client'
import { isSettlementConflict, settlementsRepo } from '@/src/db/repo'
import type { Settlement } from '@/src/db/repo/settlements'
import { settlements, transferOrders } from '@/src/db/schema'
import { InvalidTransitionError } from '@/src/domain/errors'
import { fromUnits, toUnits } from '@/src/domain/money'
import { transitionOrder } from '@/src/domain/state'
import { STELLAR_DECIMALS } from '@/src/domain/types'
import type { OrderStatus } from '@/src/domain/types'
import { SettlementValidationError } from '@/src/stellar/errors'
import { BAD_SEQ_POLL_WINDOW_MS, BATCH_SIZE, MAX_SETTLEMENT_ATTEMPTS, TIMEBOUNDS_SEC } from './config'
import { createAdvisoryLock } from './lock'
import type { SettlementLock } from './lock'
import { silentLogger } from './log'
import type { Logger } from './log'
import { liveStellarPort } from './ports'
import type { StellarPort } from './ports'

export type TransferOrder = typeof transferOrders.$inferSelect

export type SettleOutcomeKind = 'settled' | 'retry' | 'failed' | 'pending' | 'skipped'

/** Result of one processing pass. Deliberately flat: logs directly, asserts directly. */
export interface SettleOutcome {
  kind: SettleOutcomeKind
  orderId: string
  referenceId: string | null
  txHash: string | null
  ledgerSeq: number | null
  /** A short, stable code, safe to write into evidence. */
  reason: string
  /** Extra detail for the log — already passed through redact in the logger layer. */
  detail?: Record<string, unknown>
}

export interface SettleDeps {
  db?: Db
  stellar?: StellarPort
  /**
   * Global serialization lock on the treasury. Defaults to a real advisory lock
   * on Postgres — see `lock.ts` for why this constraint cannot live inside the
   * process.
   */
  lock?: SettlementLock
  logger?: Logger
  /** Written into order_events.actor. */
  actor?: string
  /** Cancels polling on shutdown. An aborted poll ⇒ `pending`, NEVER concluded failed. */
  signal?: AbortSignal
  /** Time injection for tests. */
  now?: () => number
}

interface Ctx {
  db: Db
  stellar: StellarPort
  lock: SettlementLock
  logger: Logger
  actor: string
  signal?: AbortSignal
  now: () => number
}

function ctxOf(deps: SettleDeps): Ctx {
  return {
    db: deps.db ?? liveDb,
    stellar: deps.stellar ?? liveStellarPort,
    lock: deps.lock ?? createAdvisoryLock({ db: deps.db }),
    logger: deps.logger ?? silentLogger,
    actor: deps.actor ?? 'worker',
    signal: deps.signal,
    now: deps.now ?? Date.now,
  }
}

const outcome = (
  kind: SettleOutcomeKind,
  order: Pick<TransferOrder, 'id' | 'referenceId'>,
  reason: string,
  extra: Partial<SettleOutcome> = {},
): SettleOutcome => ({
  kind,
  orderId: order.id,
  referenceId: order.referenceId,
  txHash: null,
  ledgerSeq: null,
  reason,
  ...extra,
})

// ─── The amount that goes on the ledger ────────────────────────────────────

/**
 * The USDC actually sent = usd_amount − fee_usd.
 *
 * This is the quote's `netUsd` — the comment in `src/domain/quote.ts` calls it
 * "the part actually converted and put on the ledger", and php_estimate is
 * computed from that same number. Sending the gross overpays by exactly the fee.
 */
export function settlementAmountOf(order: Pick<TransferOrder, 'usdAmount' | 'feeUsd'>): string {
  const gross = toUnits(order.usdAmount, STELLAR_DECIMALS)
  const fee = order.feeUsd ? toUnits(order.feeUsd, STELLAR_DECIMALS) : 0n
  const net = gross - fee
  if (net <= 0n) {
    throw new SettlementValidationError(
      `Settlement amount must be > 0: usd_amount=${order.usdAmount} fee_usd=${order.feeUsd ?? '0'}`,
    )
  }
  return fromUnits(net, STELLAR_DECIMALS)
}

// ─── Recording the outcome ─────────────────────────────────────────────────

/**
 * The ledger confirmed it ⇒ close out both tables IN ONE TRANSACTION.
 *
 * `settlements.status='confirmed'` and `transfer_orders.status='settled'` are
 * two faces of ONE fact: "this tx made it into a ledger". Letting them commit
 * apart opens a window in which the evidence pack reads two different answers
 * to the same question — and D2 is precisely the deliverable about binding
 * state to a tx hash. They live together or die together; there is no third
 * option.
 *
 * `transitionOrder` throwing (lost race) ⇒ `markConfirmed` rolls back too.
 * Temporarily losing a `confirmed` row is not losing evidence: the hash has
 * been in the DB since before the submit, and the next run polls it out again.
 *
 * If `ledgerSeq === null`, write NULL, not 0. The column is nullable; a wrong
 * ledger number is worse than an empty cell, because an empty cell tells the
 * reader to look it up again.
 */
async function confirmLeg(
  ctx: Ctx,
  order: TransferOrder,
  txHash: string,
  ledgerSeq: number | null,
  rawResponse: unknown,
): Promise<SettleOutcome> {
  if (ledgerSeq === null) {
    ctx.logger.warn('settle.confirm_without_ledger_seq', { orderId: order.id, txHash })
  }

  await ctx.db.transaction(async (tx) => {
    await settlementsRepo.markConfirmed(tx, txHash, ledgerSeq, rawResponse ?? null)
    if (order.status === 'settling') {
      await transitionOrder(tx, {
        orderId: order.id,
        from: 'settling',
        to: 'settled',
        actor: ctx.actor,
        externalRef: txHash,
        detail: { ledgerSeq },
      })
    }
  })

  ctx.logger.info('settle.settled', { orderId: order.id, referenceId: order.referenceId, txHash, ledgerSeq })
  return outcome('settled', order, 'ledger_confirmed', { txHash, ledgerSeq })
}

/**
 * The leg is broken but the ORDER is still salvageable: the tx can certainly
 * never reach a ledger any more (timebounds expired, or bad_seq with the hash
 * absent from the ledger). The money never left the wallet ⇒ markFailed the leg
 * and leave the order in `settling`; the partial unique index ignores `failed`
 * rows, so the next pass can build a new leg.
 */
async function failLegKeepOrder(
  ctx: Ctx,
  order: TransferOrder,
  txHash: string,
  reason: string,
): Promise<SettleOutcome> {
  await settlementsRepo.markFailed(ctx.db, txHash, reason)
  ctx.logger.warn('settle.leg_failed_retryable', {
    orderId: order.id,
    referenceId: order.referenceId,
    txHash,
    reason,
  })
  return outcome('retry', order, reason, { txHash })
}

/**
 * Permanently broken at the ORDER level. markFailed the leg (if there is one)
 * then push the order to `rejected`, both in ONE transaction — same reason as
 * `confirmLeg`.
 *
 * `reject_reason` = `'settlement_failed'` (the code in the contract), while the
 * detailed string goes into `order_events.detail.settlementFailure`. The
 * evidence pack reads the failure class straight off the
 * `transfer_orders.reject_reason` column instead of digging into jsonb; only
 * someone who needs the EXACT Horizon code reads detail.
 *
 * This code is NOT used for a leg whose timebounds expired — there the money
 * never left the wallet, so the order stays in `settling` and the worker opens
 * a new leg (see `failLegKeepOrder`).
 */
async function rejectOrder(
  ctx: Ctx,
  order: TransferOrder,
  txHash: string | null,
  reason: string,
  detail: Record<string, unknown> = {},
): Promise<SettleOutcome> {
  const current = await loadOrder(ctx.db, order.id)
  const from: OrderStatus = current?.status ?? order.status

  await ctx.db.transaction(async (tx) => {
    if (txHash) await settlementsRepo.markFailed(tx, txHash, reason)
    if (from === 'settlement_ready' || from === 'settling') {
      await transitionOrder(tx, {
        orderId: order.id,
        from,
        to: 'rejected',
        actor: ctx.actor,
        externalRef: txHash,
        detail: { ...detail, settlementFailure: reason },
        rejectReason: 'settlement_failed',
      })
    }
  })

  ctx.logger.error('settle.order_rejected', {
    orderId: order.id,
    referenceId: order.referenceId,
    txHash,
    reason,
    ...detail,
  })
  return outcome('failed', order, reason, { txHash, detail })
}

// ─── DB reads ──────────────────────────────────────────────────────────────

export async function loadOrder(db: Db, orderId: string): Promise<TransferOrder | null> {
  const [row] = await db.select().from(transferOrders).where(eq(transferOrders.id, orderId)).limit(1)
  return row ?? null
}

/** Legs the order has consumed, failed ones included — to stop infinite retries. */
async function countLegs(db: Db, orderId: string): Promise<number> {
  const rows = await db.select({ id: settlements.id }).from(settlements).where(eq(settlements.orderId, orderId))
  return rows.length
}

export interface CandidateFilter {
  limit?: number
  /** Filter by reference_id (SQL LIKE) — tests use it to isolate their namespace. */
  referenceLike?: string
}

/**
 * Orders the worker must pick up:
 *   - `settlement_ready`: no leg yet, one has to be built.
 *   - `settling`        : in flight (an active leg, or an old leg just failed).
 * Ordered by created_at so older orders are served first.
 */
export async function listCandidateOrders(db: Db, filter: CandidateFilter = {}): Promise<TransferOrder[]> {
  const settleable = inArray(transferOrders.status, ['settlement_ready', 'settling'] satisfies OrderStatus[])
  const where = filter.referenceLike
    ? and(settleable, like(transferOrders.referenceId, filter.referenceLike))
    : settleable

  return db
    .select()
    .from(transferOrders)
    .where(where)
    .orderBy(asc(transferOrders.createdAt))
    .limit(filter.limit ?? BATCH_SIZE)
}

// ─── Resume: the leg already exists, NEVER rebuild ─────────────────────────

export interface ResumeOptions {
  /**
   * Allow resubmitting the EXACT old signed XDR before polling.
   *
   * Safe because Horizon is idempotent for an identical XDR (verified: the
   * second submit returns 200, same ledger, same hash, no second payment). Used
   * on the normal path so we need not wait out the timebounds when the tx in
   * fact never reached the network at all.
   *
   * `recover` at startup deliberately leaves it `false`: observe only, never act.
   */
  resubmit?: boolean
}

/**
 * Handle a leg sitting in `submitted`. This is the only path by which a leg
 * already written to the DB reaches a conclusion — and it NEVER calls
 * buildSettlementTx.
 */
export async function resumeSubmittedLeg(
  order: TransferOrder,
  settlement: Settlement,
  deps: SettleDeps = {},
  options: ResumeOptions = {},
): Promise<SettleOutcome> {
  const ctx = ctxOf(deps)
  const txHash = settlement.txHash

  // The deadline is re-read FROM signed_xdr — the only source still correct
  // after a worker restart. Two ways that read comes back with nothing, and
  // both land on the same fallback: the XDR parses but carries no maxTime
  // (unbounded tx), or the parse throws outright (logged just below as
  // `settle.deadline_parse_failed`). Either way, derive the deadline from
  // submitted_at instead of polling forever.
  let deadlineMs: number | null = null
  try {
    deadlineMs = await ctx.stellar.deadlineMsFromXdr(settlement.signedXdr)
  } catch (err) {
    ctx.logger.warn('settle.deadline_parse_failed', { orderId: order.id, txHash, err })
  }
  deadlineMs ??= settlement.submittedAt.getTime() + TIMEBOUNDS_SEC * 1000

  if (options.resubmit) {
    // The exact old XDR, no rebuild ⇒ same hash, no second leg.
    const res = await ctx.stellar.submitSignedXdr(settlement.signedXdr)
    if (res.ok) {
      return confirmLeg(ctx, order, txHash, res.ledgerSeq ?? null, res.rawResponse)
    }
    ctx.logger.warn('settle.resubmit_not_ok', {
      orderId: order.id,
      txHash,
      kind: res.error?.kind,
      resolution: res.error?.resolution,
    })
    // Every error here (tx_bad_seq included) falls through to the poll below —
    // exactly the rule "poll the old hash before doing anything else".
  }

  const poll = await ctx.stellar.pollTransaction(txHash, deadlineMs, {
    signal: ctx.signal,
  })

  if (poll.found) {
    if (poll.txSuccessful === false) {
      return rejectOrder(ctx, order, txHash, 'tx_included_but_failed', {
        ledgerSeq: poll.ledgerSeq ?? null,
      })
    }
    return confirmLeg(ctx, order, txHash, poll.ledgerSeq ?? null, poll.rawResponse)
  }

  if (poll.reason === 'aborted') {
    ctx.logger.info('settle.poll_aborted', { orderId: order.id, txHash })
    return outcome('pending', order, 'poll_aborted', { txHash })
  }

  // Polling stopped before the timebounds expired (lookup error) ⇒ NO conclusion yet.
  if (ctx.now() < deadlineMs) {
    return outcome('pending', order, `poll_inconclusive:${poll.reason ?? 'unknown'}`, {
      txHash,
      detail: { lastError: poll.lastError?.kind ?? null },
    })
  }

  // Timebounds expired and the ledger has no such hash ⇒ this tx can never get
  // in. The money never left the wallet: fail the leg, keep the order so the
  // next pass opens a new one.
  return failLegKeepOrder(ctx, order, txHash, 'timebounds_expired_not_on_ledger')
}

// ─── The main path ─────────────────────────────────────────────────────────

/**
 * Handle EXACTLY ONE order. Pure in this sense: every side effect goes through
 * `deps`, so tests can inject fakes and the evidence script reproduces the
 * worker exactly.
 *
 * Calling this concurrently for several orders is WRONG — the treasury sequence
 * is shared, and two racing orders mean one of them eats tx_bad_seq. index.ts
 * is what holds that serialization constraint.
 */
export async function settleOnce(orderId: string, deps: SettleDeps = {}): Promise<SettleOutcome> {
  const ctx = ctxOf(deps)
  const order = await loadOrder(ctx.db, orderId)
  if (!order) {
    return {
      kind: 'skipped',
      orderId,
      referenceId: null,
      txHash: null,
      ledgerSeq: null,
      reason: 'order_not_found',
    }
  }

  if (order.status !== 'settlement_ready' && order.status !== 'settling') {
    return outcome('skipped', order, `status_not_settleable:${order.status}`)
  }

  // Do the cheap reads first, then ask for the lock — no burning a connection
  // on an order that is not our job.
  const handle = await ctx.lock.acquire()
  if (!handle) {
    // Another instance is settling. SKIP this pass, do not queue: queueing
    // means holding a connection for as long as the other instance polls
    // Horizon, and by our turn the order state is stale. Change nothing ⇒
    // retry next pass.
    ctx.logger.info('settle.lock_unavailable', {
      orderId: order.id,
      referenceId: order.referenceId,
      lock: ctx.lock.describe(),
    })
    return outcome('pending', order, 'treasury_lock_unavailable')
  }

  try {
    return await settleLocked(ctx, order, deps)
  } finally {
    await handle.release()
  }
}

/**
 * The body of `settleOnce`, running IF AND ONLY IF the treasury lock is held.
 * Everything that touches the sequence — build, submit, resubmit — lives here.
 */
async function settleLocked(
  ctx: Ctx,
  order: TransferOrder,
  deps: SettleDeps,
): Promise<SettleOutcome> {
  const active = await settlementsRepo.findActiveByOrderId(ctx.db, order.id)

  // Leg confirmed but the order not settled yet. `confirmLeg` puts both writes
  // in one transaction, so this version can no longer produce that state; this
  // branch is here to clean up rows left by an older version or a manual
  // reconcile. The ledger already confirmed ⇒ finish the move, no network.
  if (active?.status === 'confirmed') {
    if (order.status === 'settling') {
      await ctx.db.transaction((tx) =>
        transitionOrder(tx, {
          orderId: order.id,
          from: 'settling',
          to: 'settled',
          actor: ctx.actor,
          externalRef: active.txHash,
          detail: { ledgerSeq: active.ledgerSeq, resumedFrom: 'confirmed_settlement' },
        }),
      )
      ctx.logger.info('settle.settled_from_confirmed_leg', { orderId: order.id, txHash: active.txHash })
    }
    return outcome('settled', order, 'already_confirmed', {
      txHash: active.txHash,
      ledgerSeq: active.ledgerSeq,
    })
  }

  // An active leg: RESUME. Never build a new one under any circumstances.
  if (active) {
    return resumeSubmittedLeg(order, active, { ...deps, ...ctx }, { resubmit: true })
  }

  // No active leg ⇒ open a new one. Stop infinite retries first.
  const legs = await countLegs(ctx.db, order.id)
  if (legs >= MAX_SETTLEMENT_ATTEMPTS) {
    return rejectOrder(ctx, order, null, 'settlement_attempts_exhausted', {
      attempts: legs,
      maxAttempts: MAX_SETTLEMENT_ATTEMPTS,
    })
  }

  return buildAndSubmit(ctx, order)
}

/** build → write the DB → transition → submit. This order must not change. */
async function buildAndSubmit(ctx: Ctx, order: TransferOrder): Promise<SettleOutcome> {
  // ── 1. build + sign + hash. Nothing has left this process yet.
  let built
  try {
    built = await ctx.stellar.buildSettlementTx({
      amount: settlementAmountOf(order),
      // Invariant #4 in `src/db/schema.ts`: memo = EXACTLY the reference_id, nothing added.
      memo: order.referenceId,
    })
  } catch (err) {
    if (err instanceof SettlementValidationError) {
      // Bad input (amount/memo) — retrying cannot save it.
      return rejectOrder(ctx, order, null, 'build_validation_failed', { message: err.message })
    }
    // Reading the sequence from Horizon failed / flaky network: nothing written yet.
    ctx.logger.warn('settle.build_failed', { orderId: order.id, err })
    return outcome('pending', order, 'build_failed')
  }

  // ── 2. WRITE THE DB BEFORE SUBMITTING. From here on, every ambiguous
  //      situation reduces to one question: "is this hash on the ledger yet?".
  try {
    await settlementsRepo.insertSubmitted(ctx.db, {
      orderId: order.id,
      txHash: built.txHash,
      signedXdr: built.signedXdr,
      sourceAccount: built.source,
      destinationAccount: built.destination,
      assetCode: built.assetCode,
      assetIssuer: built.assetIssuer,
      amount: built.amount,
      memo: built.memo,
    })
  } catch (err) {
    if (isSettlementConflict(err)) {
      // Someone slipped in between findActive and insert. The DB blocked it —
      // as intended. Nothing was submitted; the next pass resumes the winner's leg.
      ctx.logger.warn('settle.insert_conflict', { orderId: order.id, kind: err.kind })
      return outcome('pending', order, `insert_conflict:${err.kind}`, { txHash: built.txHash })
    }
    throw err
  }

  // ── 3. settlement_ready → settling. If the order is already `settling` (the
  //      previous leg expired), skip: settling → settling is not in the table.
  if (order.status === 'settlement_ready') {
    try {
      await ctx.db.transaction((tx) =>
        transitionOrder(tx, {
          orderId: order.id,
          from: 'settlement_ready',
          to: 'settling',
          actor: ctx.actor,
          externalRef: built.txHash,
          detail: { amount: built.amount, memo: built.memo, maxTimeSec: built.maxTimeSec },
        }),
      )
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        // Lost the race at the order level. NOT submitted ⇒ absolutely safe to fail the leg.
        await settlementsRepo.markFailed(ctx.db, built.txHash, 'transition_lost_race_before_submit')
        return outcome('pending', order, 'transition_lost_race', { txHash: built.txHash })
      }
      throw err
    }
  }

  const settling: TransferOrder = { ...order, status: 'settling' }

  // ── 4. Only now push it to the network.
  const res = await ctx.stellar.submitSignedXdr(built.signedXdr)

  if (res.ok) {
    if (typeof res.ledgerSeq === 'number') {
      return confirmLeg(ctx, settling, built.txHash, res.ledgerSeq, res.rawResponse)
    }
    // 200 but no ledger number: ask the ledger to be sure.
    return pollThenDecide(ctx, settling, built.txHash, built.deadlineMs, 'submit_ok_without_ledger')
  }

  const err = res.error
  const kind = err?.kind ?? 'unknown'

  // ── tx_bad_seq: A TRAP. The sequence mismatch may be because the OLD tx
  //    already made it into a ledger. Poll the old hash BEFORE doing anything
  //    else. Only once it is certainly absent from the ledger may the leg be
  //    failed to open a new one.
  if (kind === 'tx_bad_seq') {
    const window = Math.min(built.deadlineMs, ctx.now() + BAD_SEQ_POLL_WINDOW_MS)
    const poll = await ctx.stellar.pollTransaction(built.txHash, window, { signal: ctx.signal })
    if (poll.found) {
      ctx.logger.warn('settle.bad_seq_but_on_ledger', { orderId: order.id, txHash: built.txHash })
      if (poll.txSuccessful === false) {
        return rejectOrder(ctx, settling, built.txHash, 'tx_included_but_failed', {
          ledgerSeq: poll.ledgerSeq ?? null,
        })
      }
      return confirmLeg(ctx, settling, built.txHash, poll.ledgerSeq ?? null, poll.rawResponse)
    }
    if (poll.reason === 'aborted') {
      return outcome('pending', settling, 'poll_aborted', { txHash: built.txHash })
    }
    // Certainly not on the ledger ⇒ only now may a new leg be opened (next pass).
    return failLegKeepOrder(ctx, settling, built.txHash, 'tx_bad_seq_not_on_ledger')
  }

  // ── timeout / 5xx: do NOT conclude, do NOT resubmit. Just poll.
  if (err?.resolution === 'poll') {
    return pollThenDecide(ctx, settling, built.txHash, built.deadlineMs, `submit_${kind}`)
  }

  // ── The rest are permanent errors per classifyHorizonError (insufficient
  //    balance, bad trustline, unclear 4xx). Horizon rejected the tx ⇒ it never
  //    reaches a ledger.
  return rejectOrder(ctx, settling, built.txHash, `submit_${kind}`, {
    message: err?.message ?? 'submit failed for an unknown reason',
    status: err?.status ?? null,
    resultCodes: err?.resultCodes ?? null,
  });
}

/** Poll to the deadline, then conclude. Shared by timeout and 200-without-ledger. */
async function pollThenDecide(
  ctx: Ctx,
  order: TransferOrder,
  txHash: string,
  deadlineMs: number,
  reasonPrefix: string,
): Promise<SettleOutcome> {
  const poll = await ctx.stellar.pollTransaction(txHash, deadlineMs, { signal: ctx.signal })

  if (poll.found) {
    if (poll.txSuccessful === false) {
      return rejectOrder(ctx, order, txHash, 'tx_included_but_failed', { ledgerSeq: poll.ledgerSeq ?? null })
    }
    return confirmLeg(ctx, order, txHash, poll.ledgerSeq ?? null, poll.rawResponse)
  }

  if (poll.reason === 'aborted') {
    return outcome('pending', order, 'poll_aborted', { txHash })
  }

  if (ctx.now() < deadlineMs) {
    return outcome('pending', order, `${reasonPrefix}:poll_inconclusive`, { txHash })
  }

  return failLegKeepOrder(ctx, order, txHash, `${reasonPrefix}:timebounds_expired_not_on_ledger`)
}
