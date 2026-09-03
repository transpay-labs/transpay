/**
 * GLOBAL SERIALIZATION LOCK — `pg_try_advisory_lock` on the treasury.
 *
 * The loop in `index.ts` only guarantees serialization inside ONE process. Two
 * instances running by accident (an overlapping deploy, a reviewer opening one
 * more terminal, a systemd restart while the old process is not dead yet) puts
 * us straight back in the sequence-contention problem — and sequence
 * contention is the road to double-send. That constraint has to live where
 * every instance can see it, which means inside Postgres.
 *
 * Three design choices, each for a reason:
 *
 *   1. `try`, not `wait`. A second instance that cannot take the lock SKIPS
 *      that pass and goes back to sleep instead of queueing. Queueing means
 *      holding a connection for as long as the other instance polls Horizon
 *      (up to 180s), and by the time our turn comes the order state is stale.
 *
 *   2. A session lock (`pg_advisory_lock`) on a DEDICATED CONNECTION, not a
 *      transaction lock. The lock has to survive across the network calls to
 *      Horizon; keeping a Postgres transaction open that long is idle-in-
 *      transaction, which blocks vacuum and pins a snapshot for nothing.
 *      postgres-js's `reserve()` hands out a dedicated connection, so `unlock`
 *      is guaranteed to run on the very connection that ran `lock` — through
 *      the pool there is no such guarantee.
 *
 *   3. The two-int32 form (`pg_try_advisory_lock(int4, int4)`) rather than the
 *      bigint one. The first half is the TransPay namespace, the second is
 *      derived from the treasury public key: two different corridors lock
 *      independently, and another app in the SAME database stays out of our
 *      lock space. Only the same database — an app in a different one could
 *      never have collided with us whatever key we chose; see the scope note
 *      below.
 *
 * WHAT THIS LOCK DOES NOT COVER: an advisory lock is scoped to the database it
 * is taken in. It stops a second worker on the SAME database; it does nothing
 * about a second worker on a DIFFERENT one, even one signing from the same
 * treasury. Not theory: production on Railway Postgres and local runs on local
 * Postgres once shared a treasury, and the lock held on one side was completely
 * invisible to the other — both were free to race for the sequence. That is why
 * every environment now gets its own corridor (README limitation 5). The lock
 * cannot enforce that separation, and nothing in this file can.
 */
import { createHash } from 'node:crypto'
import { db as liveDb } from '@/src/db/client'
import type { Db } from '@/src/db/client'

/** The lock is held. `release` must be called in a `finally`. */
export interface LockHandle {
  release(): Promise<void>
}

export interface SettlementLock {
  /** Try to take the lock ONCE. Cannot take it ⇒ `null`, NO waiting. */
  acquire(): Promise<LockHandle | null>
  /** For logs/debug only — never used for logic. */
  describe(): string
}

// ─── Key derivation ────────────────────────────────────────────────────────

/**
 * The TransPay namespace: the first 4 bytes of sha256('transpay:settlement').
 * Fixed — changing it makes the lock useless against an instance still running
 * the old build.
 */
export const LOCK_NAMESPACE = int32From('transpay:settlement')

/** First 4 bytes of sha256(input), read as a signed int32 (exactly PG's int4). */
function int32From(input: string): number {
  return createHash('sha256').update(input).digest().readInt32BE(0)
}

/** The key for one specific treasury. A corridor with a different treasury ⇒ a different key. */
export function lockKeyForTreasury(treasuryPublicKey: string): [number, number] {
  return [LOCK_NAMESPACE, int32From(treasuryPublicKey)]
}

// ─── The real implementation ───────────────────────────────────────────────

/** The minimal postgres-js surface the lock needs. */
type ReservedSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>
  release: () => void
}
type PostgresClient = { reserve: () => Promise<ReservedSql> }

function clientOf(db: Db): PostgresClient {
  const client = (db as unknown as { $client?: unknown }).$client
  if (!client || typeof (client as PostgresClient).reserve !== 'function') {
    throw new Error('DB client does not support reserve() — the advisory lock needs a dedicated connection.')
  }
  return client as PostgresClient
}

export interface AdvisoryLockOptions {
  db?: Db
  /** Override the key. Omitted ⇒ derived from the treasury public key (lazy import). */
  key?: [number, number]
}

/**
 * The real advisory lock on Postgres.
 *
 * The treasury public key is read LAZILY: `@/src/stellar` loads the secret at
 * import time, and tests should not need a secret in order to run.
 */
export function createAdvisoryLock(options: AdvisoryLockOptions = {}): SettlementLock {
  const db = options.db ?? liveDb
  let resolved: Promise<[number, number]> | null = options.key ? Promise.resolve(options.key) : null

  const key = () =>
    (resolved ??= import('@/src/stellar').then((m) => lockKeyForTreasury(m.TREASURY_PUBLIC)))

  return {
    describe: () => (options.key ? `advisory(${options.key[0]},${options.key[1]})` : 'advisory(treasury)'),

    async acquire(): Promise<LockHandle | null> {
      const [a, b] = await key()
      const reserved = await clientOf(db).reserve()

      let locked = false
      try {
        const rows = await reserved`select pg_try_advisory_lock(${a}::int4, ${b}::int4) as locked`
        locked = rows[0]?.locked === true
      } catch (err) {
        reserved.release()
        throw err
      }

      if (!locked) {
        // Another instance is settling. Hand the connection back at once, hold nothing.
        reserved.release()
        return null
      }

      return {
        async release() {
          try {
            await reserved`select pg_advisory_unlock(${a}::int4, ${b}::int4)`
          } finally {
            // Hand the connection back even if unlock failed — when the
            // connection closes Postgres releases the session lock itself, so
            // there is no risk of a permanently stuck lock.
            reserved.release()
          }
        },
      }
    },
  }
}

// ─── Test double ───────────────────────────────────────────────────────────

/**
 * An in-process lock with the exact try-lock semantics. For tests that want to
 * verify the "skip the pass" behaviour without a real connection.
 */
export function createMemoryLock(): SettlementLock & { held: () => boolean } {
  let held = false
  return {
    describe: () => 'memory',
    held: () => held,
    async acquire() {
      if (held) return null
      held = true
      return {
        async release() {
          held = false
        },
      }
    },
  }
}

/** A lock that is always available — for tests where locking is not the subject. */
export const openLock: SettlementLock = {
  describe: () => 'open',
  acquire: async () => ({ release: async () => {} }),
}
