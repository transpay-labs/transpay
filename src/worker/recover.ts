/**
 * RECOVER — clean up after a previous run that was killed mid-flight.
 *
 * Runs ONCE at startup, before the loop picks up any new order. What it looks
 * for is two kinds of wound:
 *
 *   A. a `submitted` settlement — the DB knows a tx_hash but nobody has
 *      confirmed a ledger. The tx may have reached a ledger (death after
 *      submit), or may never have reached the network (death between build and
 *      submit). Seen from the outside those two are IDENTICAL.
 *   B. a `settling` order — a state that says "money is being sent" while
 *      nobody is sending it.
 *
 * The absolute rule here: **POLL ONLY, NEVER REBUILD, NEVER SUBMIT**.
 *
 * Why no rebuild: the old hash stays valid until its timebounds expire.
 * Building a new tx while the old one is still alive is a straight line to two
 * payments for one order.
 * Why no resubmit either: recover is the OBSERVATION step. It asks the ledger a
 * single question — "is this hash there yet?" — and records the answer. Every
 * active decision is left to the main loop, once the situation is clear.
 *
 * After recover markFailed a leg whose timebounds expired, the order stays in
 * `settling` and the main loop opens a new leg. That is a legitimate retry: the
 * old tx is past its maxTime, so it can never reach a ledger, and the money
 * never left the wallet.
 *
 * Recover also goes through the treasury lock (see `lock.ts`). It does not
 * submit, but it does CONCLUDE — markConfirmed / markFailed. Two instances
 * concluding about the same leg are two instances that can conclude the
 * OPPOSITE of each other: one sees the deadline has passed and fails the leg,
 * the other sees the tx on the ledger at just that moment. The lock turns "who
 * is right" into a question nobody has to ask.
 */
import { eq } from 'drizzle-orm'
import { db as liveDb } from '@/src/db/client'
import type { Db } from '@/src/db/client'
import { settlementsRepo } from '@/src/db/repo'
import { settlements, transferOrders } from '@/src/db/schema'
import { transitionOrder } from '@/src/domain/state'
import { createAdvisoryLock } from './lock'
import type { SettlementLock } from './lock'
import { silentLogger } from './log'
import type { Logger } from './log'
import { liveStellarPort } from './ports'
import type { StellarPort } from './ports'
import { loadOrder, resumeSubmittedLeg } from './settle'
import type { SettleDeps, SettleOutcome, TransferOrder } from './settle'

export interface RecoverDeps extends SettleDeps {
  /** Filter by reference_id (SQL LIKE) — tests use it to isolate their namespace. */
  referenceLike?: string
}

export interface RecoverReport {
  /** true when another instance holds the treasury lock ⇒ recover yields, never waits. */
  lockUnavailable: boolean
  scanned: number
  settled: number
  failed: number
  pending: number
  /** `settling` orders with no active leg left — for the main loop to open a new one. */
  orphans: number
  outcomes: SettleOutcome[]
}

/** Merge both sources (submitted legs, settling orders) into a single order list. */
async function collectStuckOrders(db: Db, referenceLike?: string): Promise<TransferOrder[]> {
  const byId = new Map<string, TransferOrder>()

  const settling = await db
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.status, 'settling'))
  for (const o of settling) byId.set(o.id, o)

  const withSubmittedLeg = await db
    .select({ order: transferOrders })
    .from(settlements)
    .innerJoin(transferOrders, eq(transferOrders.id, settlements.orderId))
    .where(eq(settlements.status, 'submitted'))
  for (const row of withSubmittedLeg) byId.set(row.order.id, row.order)

  const all = [...byId.values()]
  const filtered = referenceLike
    ? all.filter((o) => matchesLike(o.referenceId, referenceLike))
    : all
  return filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/** SQL LIKE, done in JS because the list is already merged from two queries. `%` and `_`. */
function matchesLike(value: string, pattern: string): boolean {
  const rx = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`,
  )
  return rx.test(value)
}

/**
 * Scan and conclude each unfinished order. Sequential — same reason as the main
 * loop: the treasury sequence is a shared resource.
 */
export async function recoverPending(deps: RecoverDeps = {}): Promise<RecoverReport> {
  const db: Db = deps.db ?? liveDb
  const logger: Logger = deps.logger ?? silentLogger
  const stellar: StellarPort = deps.stellar ?? liveStellarPort
  const lock: SettlementLock = deps.lock ?? createAdvisoryLock({ db: deps.db })
  const actor = deps.actor ?? 'worker:recover'

  const stuck = await collectStuckOrders(db, deps.referenceLike)
  const report: RecoverReport = {
    lockUnavailable: false,
    scanned: stuck.length,
    settled: 0,
    failed: 0,
    pending: 0,
    orphans: 0,
    outcomes: [],
  }

  if (stuck.length === 0) {
    logger.info('recover.clean', {})
    return report
  }

  // Ask for the lock only when there is real work — a clean DB burns no connection.
  const handle = await lock.acquire()
  if (!handle) {
    logger.warn('recover.lock_unavailable', { stuck: stuck.length, lock: lock.describe() })
    report.lockUnavailable = true
    report.scanned = 0
    return report
  }

  logger.info('recover.start', { stuck: stuck.length })

  try {
    await scanAll()
  } finally {
    await handle.release()
  }

  logger.info('recover.done', {
    scanned: report.scanned,
    settled: report.settled,
    failed: report.failed,
    pending: report.pending,
    orphans: report.orphans,
  })

  return report

  /** The scan pass, sequential — same reason as the main loop. */
  async function scanAll(): Promise<void> {
    for (const order of stuck) {
      if (deps.signal?.aborted) {
        logger.warn('recover.aborted', { remaining: stuck.length - report.outcomes.length })
        break
      }

      const fresh = (await loadOrder(db, order.id)) ?? order
      const active = await settlementsRepo.findActiveByOrderId(db, fresh.id)

      // The ledger confirmed it, only the status row is missing. `confirmLeg`
      // puts both writes in one transaction, so this version can no longer
      // create that situation; this branch cleans up rows from an older
      // version / a manual reconcile. No need to ask the network.
      if (active?.status === 'confirmed') {
        if (fresh.status === 'settling') {
          await db.transaction((tx) =>
            transitionOrder(tx, {
              orderId: fresh.id,
              from: 'settling',
              to: 'settled',
              actor,
              externalRef: active.txHash,
              detail: { ledgerSeq: active.ledgerSeq, resumedFrom: 'recover:confirmed_settlement' },
            }),
          )
        }
        logger.info('recover.settled_from_confirmed_leg', {
          orderId: fresh.id,
          referenceId: fresh.referenceId,
          txHash: active.txHash,
        })
        report.settled += 1
        report.outcomes.push({
          kind: 'settled',
          orderId: fresh.id,
          referenceId: fresh.referenceId,
          txHash: active.txHash,
          ledgerSeq: active.ledgerSeq,
          reason: 'recover_already_confirmed',
        })
        continue
      }

      // The order says `settling` but no active leg is left (the previous one
      // failed). Not recover's job — the main loop will open a new leg.
      if (!active) {
        logger.warn('recover.orphan_settling_order', {
          orderId: fresh.id,
          referenceId: fresh.referenceId,
        })
        report.orphans += 1
        report.outcomes.push({
          kind: 'pending',
          orderId: fresh.id,
          referenceId: fresh.referenceId,
          txHash: null,
          ledgerSeq: null,
          reason: 'orphan_settling_no_active_leg',
        })
        continue
      }

      logger.info('recover.polling', {
        orderId: fresh.id,
        referenceId: fresh.referenceId,
        txHash: active.txHash,
      })

      // resubmit: false — recover only OBSERVES. And resumeSubmittedLeg has no
      // path that calls buildSettlementTx, so "no rebuild" is a structural
      // invariant rather than a promise.
      const result = await resumeSubmittedLeg(
        fresh,
        active,
        { db, stellar, logger, actor, signal: deps.signal, now: deps.now },
        { resubmit: false },
      )

      report.outcomes.push(result)
      if (result.kind === 'settled') report.settled += 1
      else if (result.kind === 'retry' || result.kind === 'failed') report.failed += 1
      else report.pending += 1
    }
  }
}
