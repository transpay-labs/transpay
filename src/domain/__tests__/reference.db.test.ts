/**
 * Integration test — needs a real Postgres (DATABASE_URL, default localhost:5434).
 * Focus: proving allocateReferenceId does NOT race.
 */
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/src/db/client'
import { allocateReferenceId, formatReferenceId, utcDayKey } from '@/src/domain/reference'
import { MAX_SEQ_PER_DAY, MEMO_MAX_BYTES, REFERENCE_ID_PATTERN } from '@/src/domain/types'
import { cleanupTestData, closeDb, ensureSchema } from './db-setup'

const seqOf = (ref: string) => Number(ref.slice(-4))

beforeAll(async () => {
  await ensureSchema()
  await cleanupTestData()
})

afterAll(async () => {
  await cleanupTestData()
  await closeDb()
})

describe('allocateReferenceId (real DB)', () => {
  it('allocates sequentially from 1 per (corridor, UTC day)', async () => {
    const day = new Date('2099-03-01T08:00:00.000Z')
    const refs: string[] = []
    for (let i = 0; i < 3; i++) {
      refs.push(await db.transaction((tx) => allocateReferenceId(tx, 'PHP', day)))
    }
    expect(refs).toEqual(['TP-PHP-20990301-0001', 'TP-PHP-20990301-0002', 'TP-PHP-20990301-0003'])
  })

  it('50 CONCURRENT calls ⇒ 50 distinct references, seq contiguous 1..50', async () => {
    const day = new Date('2099-06-15T12:00:00.000Z')

    const refs = await Promise.all(
      Array.from({ length: 50 }, () => db.transaction((tx) => allocateReferenceId(tx, 'VND', day))),
    )

    expect(refs).toHaveLength(50)
    expect(new Set(refs).size).toBe(50) // no duplicates
    expect(refs.map(seqOf).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1), // contiguous, no gaps
    )
    for (const ref of refs) {
      expect(ref).toMatch(REFERENCE_ID_PATTERN)
      expect(ref.startsWith('TP-VND-20990615-')).toBe(true)
      expect(Buffer.byteLength(ref, 'utf8')).toBeLessThanOrEqual(MEMO_MAX_BYTES)
    }

    const counterRows = (await db.execute(
      sql`select next_seq from reference_counters where corridor = 'VND' and day = ${utcDayKey(day)}`,
    )) as unknown as Array<{ next_seq: number }>
    expect(Number(counterRows[0].next_seq)).toBe(50)
  })

  it('counters stay separate per corridor and per day', async () => {
    const dayA = new Date('2099-07-01T00:00:00.000Z')
    const dayB = new Date('2099-07-02T00:00:00.000Z')

    const php1 = await db.transaction((tx) => allocateReferenceId(tx, 'PHP', dayA))
    const vnd1 = await db.transaction((tx) => allocateReferenceId(tx, 'VND', dayA))
    const php2 = await db.transaction((tx) => allocateReferenceId(tx, 'PHP', dayB))

    expect(php1).toBe('TP-PHP-20990701-0001')
    expect(vnd1).toBe('TP-VND-20990701-0001')
    expect(php2).toBe('TP-PHP-20990702-0001')
  })

  it('takes the day in UTC even when local time is already on another day', async () => {
    const lateUtc = new Date('2099-08-10T23:30:00.000Z')
    const ref = await db.transaction((tx) => allocateReferenceId(tx, 'PHP', lateUtc))
    expect(ref).toBe('TP-PHP-20990810-0001')
  })

  it('throws past MAX_SEQ_PER_DAY instead of minting a malformed reference', async () => {
    const day = new Date('2099-09-09T00:00:00.000Z')
    await db.execute(
      sql`insert into reference_counters (corridor, day, next_seq)
          values ('PHP', ${utcDayKey(day)}, ${MAX_SEQ_PER_DAY})`,
    )

    await expect(db.transaction((tx) => allocateReferenceId(tx, 'PHP', day))).rejects.toThrowError(
      RangeError,
    )
    expect(() => formatReferenceId('PHP', day, MAX_SEQ_PER_DAY + 1)).toThrowError(RangeError)
  })
})
