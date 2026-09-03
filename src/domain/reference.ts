/**
 * REFERENCE ID ALLOCATION — `TP-{CORRIDOR}-{YYYYMMDD}-{SEQ4}`, day in UTC.
 *
 * SEQ4 comes from the reference_counters table in exactly one statement
 *   INSERT ... ON CONFLICT (corridor, day) DO UPDATE SET next_seq = next_seq + 1 RETURNING next_seq
 * Atomic at the Postgres layer: two concurrent transactions serialize on the
 * same row, there is no read-modify-write in the app ⇒ no race, no duplicates.
 *
 * The returned string must fit Stellar's MEMO_TEXT (28 bytes) because it IS
 * the memo.
 */
import { sql } from 'drizzle-orm'
import { referenceCounters } from '@/src/db/schema'
import type { Executor } from '@/src/domain/state'
import {
  MAX_SEQ_PER_DAY,
  MEMO_MAX_BYTES,
  REFERENCE_ID_PATTERN,
} from '@/src/domain/types'
import type { Corridor } from '@/src/domain/types'

/** UTC day as YYYY-MM-DD — the key of reference_counters (column `date`). */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** UTC day as YYYYMMDD — the middle part of a reference ID. */
export function utcDayCompact(now: Date): string {
  return utcDayKey(now).replaceAll('-', '')
}

/** Pure string assembly (no DB) — split out so format unit tests need no DB. */
export function formatReferenceId(corridor: Corridor, now: Date, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError(`seq must be an integer >= 1, received ${seq}`)
  if (seq > MAX_SEQ_PER_DAY) {
    throw new RangeError(`Out of SEQ4 for ${corridor} on ${utcDayKey(now)} (used ${seq}/${MAX_SEQ_PER_DAY})`)
  }

  const ref = `TP-${corridor}-${utcDayCompact(now)}-${String(seq).padStart(4, '0')}`

  // Last two guards, in the order the schema checks them: format, then memo length.
  if (!REFERENCE_ID_PATTERN.test(ref)) throw new RangeError(`Reference ID has the wrong format: "${ref}"`)
  if (Buffer.byteLength(ref, 'utf8') > MEMO_MAX_BYTES) {
    throw new RangeError(`Reference ID "${ref}" exceeds the ${MEMO_MAX_BYTES} bytes of MEMO_TEXT`)
  }
  return ref
}

/** Allocate a new reference ID for (corridor, UTC day of `now`). */
export async function allocateReferenceId(
  tx: Executor,
  corridor: Corridor,
  now: Date = new Date(),
): Promise<string> {
  const day = utcDayKey(now)

  const [row] = await tx
    .insert(referenceCounters)
    .values({ corridor, day, nextSeq: 1 })
    .onConflictDoUpdate({
      target: [referenceCounters.corridor, referenceCounters.day],
      set: { nextSeq: sql`${referenceCounters.nextSeq} + 1` },
    })
    .returning({ nextSeq: referenceCounters.nextSeq })

  if (!row) throw new Error(`Could not allocate a sequence for ${corridor}/${day}`)

  return formatReferenceId(corridor, now, row.nextSeq)
}
