/**
 * SETTLEMENT WORKER — the loop.
 *
 *   recover once  →  [ scan DB → process each order SEQUENTIALLY → sleep ] repeat
 *
 * AN ARCHITECTURAL CONSTRAINT, NOT AN OPTIMISATION: only one order is submitted
 * at a time. The treasury sequence is a resource shared by EVERY order — the
 * partial unique index only blocks duplicate legs within the SAME order, while
 * two different orders submitting at once still contend for the sequence and
 * one of them eats `tx_bad_seq`. Hence no Promise.all here, no worker pool, no
 * concurrency knob. Going faster requires centralised sequence management, not
 * parallelism.
 *
 * In-process serialization is not enough: two instances are two processes. The
 * advisory lock on the treasury (see `lock.ts`) is the constraint every
 * instance can see — an instance that cannot take the lock skips that pass
 * rather than queueing.
 *
 * Graceful shutdown: SIGINT/SIGTERM sets a flag, the order IN FLIGHT is
 * finished (which can take until its timebounds expire if it is polling) and
 * only then do we exit. Cutting mid-flight leaves behind exactly what recover
 * has to clean up — avoid it where it can be avoided. Only a second signal
 * aborts the poll: by then the tx_hash is in the DB, so the next startup can
 * still reconcile it.
 */
import { pathToFileURL } from 'node:url'
import { db as liveDb } from '@/src/db/client'
import type { Db } from '@/src/db/client'
import { BATCH_SIZE, POLL_INTERVAL_MS } from './config'
import { createAdvisoryLock } from './lock'
import type { SettlementLock } from './lock'
import { consoleLogger } from './log'
import type { Logger } from './log'
import { liveStellarPort } from './ports'
import type { StellarPort } from './ports'
import { recoverPending } from './recover'
import { listCandidateOrders, settleOnce } from './settle'
import type { SettleOutcome } from './settle'

export interface WorkerDeps {
  db?: Db
  stellar?: StellarPort
  /** Global serialization lock. Defaults to a real advisory lock on Postgres. */
  lock?: SettlementLock
  logger?: Logger
  actor?: string
  signal?: AbortSignal
  now?: () => number
  /** Filter reference_id (SQL LIKE) — tests use it to isolate their namespace. */
  referenceLike?: string
  limit?: number
}

export interface RunOnceReport {
  picked: number
  outcomes: SettleOutcome[]
}

/**
 * One scan pass. Processes SEQUENTIALLY, never in parallel — see the note at
 * the top of this file. Split out of the infinite loop so tests and the
 * evidence script can call it.
 */
export async function runOnce(deps: WorkerDeps = {}): Promise<RunOnceReport> {
  const db = deps.db ?? liveDb
  const logger = deps.logger ?? consoleLogger
  // One lock object for the whole pass: the key is derived once, then cached.
  const lock = deps.lock ?? createAdvisoryLock({ db: deps.db })
  const orders = await listCandidateOrders(db, {
    limit: deps.limit ?? BATCH_SIZE,
    referenceLike: deps.referenceLike,
  })

  const outcomes: SettleOutcome[] = []
  for (const order of orders) {
    if (deps.signal?.aborted) {
      logger.info('worker.batch_interrupted', { remaining: orders.length - outcomes.length })
      break
    }

    // The `await` inside the for loop is DELIBERATE — see the note at the top.
    try {
      const result = await settleOnce(order.id, {
        db,
        stellar: deps.stellar,
        lock,
        logger,
        actor: deps.actor,
        signal: deps.signal,
        now: deps.now,
      })
      outcomes.push(result)
    } catch (err) {
      // An unforeseen error (the DB going down mid-flight, ...). Change no
      // further state: the order is untouched, recover / the next pass deals with it.
      logger.error('worker.settle_threw', {
        orderId: order.id,
        referenceId: order.referenceId,
        err,
      })
      outcomes.push({
        kind: 'pending',
        orderId: order.id,
        referenceId: order.referenceId,
        txHash: null,
        ledgerSeq: null,
        reason: 'unexpected_error',
      })
    }
  }

  return { picked: orders.length, outcomes }
}

// ─── The real loop ─────────────────────────────────────────────────────────

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

export interface LoopOptions extends WorkerDeps {
  intervalMs?: number
  /** Stop after N passes — used by smoke tests. undefined = run forever. */
  maxIterations?: number
  /** Soft stop flag: read before/after each pass, the in-flight order still finishes. */
  shouldStop?: () => boolean
}

export async function runLoop(options: LoopOptions = {}): Promise<void> {
  const logger = options.logger ?? consoleLogger
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const lock = options.lock ?? createAdvisoryLock({ db: options.db })
  let iteration = 0

  // Recover FIRST. Picking up new orders while the old wounds are still
  // unreconciled is the surest way to end up with two active legs for one order.
  logger.info('worker.recover_start', {})
  await recoverPending({
    db: options.db,
    stellar: options.stellar,
    lock,
    logger,
    actor: options.actor ? `${options.actor}:recover` : 'worker:recover',
    signal: options.signal,
    now: options.now,
    referenceLike: options.referenceLike,
  })

  for (;;) {
    if (options.shouldStop?.()) {
      logger.info('worker.stopping', { iteration })
      return
    }
    if (options.maxIterations !== undefined && iteration >= options.maxIterations) return

    iteration += 1
    const report = await runOnce({ ...options, lock })
    if (report.picked > 0) {
      logger.info('worker.batch_done', {
        iteration,
        picked: report.picked,
        kinds: report.outcomes.map((o) => o.kind),
      })
    }

    // Stop RIGHT after the last order is done — no extra sleep tick.
    if (options.shouldStop?.()) {
      logger.info('worker.stopping', { iteration })
      return
    }

    await sleep(intervalMs, options.signal)
  }
}

// ─── Entrypoint ────────────────────────────────────────────────────────────

/**
 * `pnpm worker`. Importing this file from a test does NOT run the loop — only
 * invoking node directly on it does.
 */
async function main(): Promise<void> {
  const logger = consoleLogger
  let stopping = false
  const forceAbort = new AbortController()

  const onSignal = (sig: string) => {
    if (!stopping) {
      stopping = true
      logger.info('worker.shutdown_requested', { signal: sig, note: 'finishing the in-flight order' })
      return
    }
    // Second signal: the operator does not want to wait any longer. Abort the
    // poll — safe because the tx_hash is already in the DB, and recover will
    // reconcile it on the next startup.
    logger.warn('worker.force_abort', { signal: sig })
    forceAbort.abort()
  }

  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  logger.info('worker.start', {
    intervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    pid: process.pid,
  })

  try {
    await runLoop({
      logger,
      stellar: liveStellarPort,
      signal: forceAbort.signal,
      shouldStop: () => stopping,
    })
    logger.info('worker.stopped', {})
    process.exit(0)
  } catch (err) {
    logger.error('worker.crashed', { err })
    process.exit(1)
  }
}

/** Runs only when node/tsx is invoked DIRECTLY on this file, never on import. */
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) void main()
