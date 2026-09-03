import { describe, expect, it } from 'vitest'
import { DEPOSIT_REFERENCE_PATTERN, generateDepositReference } from '@/src/domain/deposit'
import { formatReferenceId, utcDayCompact, utcDayKey } from '@/src/domain/reference'
import { MAX_SEQ_PER_DAY, MEMO_MAX_BYTES, REFERENCE_ID_PATTERN } from '@/src/domain/types'

describe('formatReferenceId (pure, no DB)', () => {
  const day = new Date('2026-09-07T10:00:00.000Z')

  it('matches the contract format and pads SEQ to 4 digits', () => {
    expect(formatReferenceId('PHP', day, 1)).toBe('TP-PHP-20260907-0001')
    expect(formatReferenceId('PHP', day, 42)).toBe('TP-PHP-20260907-0042')
    expect(formatReferenceId('VND', day, MAX_SEQ_PER_DAY)).toBe('TP-VND-20260907-9999')
  })

  it('every valid value matches REFERENCE_ID_PATTERN and fits the 28-byte memo', () => {
    for (const seq of [1, 9, 10, 99, 100, 999, 1000, MAX_SEQ_PER_DAY]) {
      for (const corridor of ['PHP', 'VND'] as const) {
        const ref = formatReferenceId(corridor, day, seq)
        expect(ref).toMatch(REFERENCE_ID_PATTERN)
        expect(Buffer.byteLength(ref, 'utf8')).toBeLessThanOrEqual(MEMO_MAX_BYTES)
        expect(Buffer.byteLength(ref, 'utf8')).toBe(20)
      }
    }
  })

  it('takes the day in UTC, not the host timezone', () => {
    // 18:00Z is the next day at UTC+7 — the reference must still use the UTC day.
    const evening = new Date('2026-09-07T18:00:00.000Z')
    expect(utcDayKey(evening)).toBe('2026-09-07')
    expect(utcDayCompact(evening)).toBe('20260907')
    expect(formatReferenceId('PHP', evening, 1)).toBe('TP-PHP-20260907-0001')

    // 23:59:59.999Z is still the old day; 00:00:00Z is already the new one.
    expect(formatReferenceId('PHP', new Date('2026-09-07T23:59:59.999Z'), 1)).toBe('TP-PHP-20260907-0001')
    expect(formatReferenceId('PHP', new Date('2026-09-08T00:00:00.000Z'), 1)).toBe('TP-PHP-20260908-0001')
  })

  it('throws past MAX_SEQ_PER_DAY instead of spilling into 5 digits', () => {
    expect(() => formatReferenceId('PHP', day, MAX_SEQ_PER_DAY + 1)).toThrowError(RangeError)
  })

  it('throws on an invalid seq', () => {
    expect(() => formatReferenceId('PHP', day, 0)).toThrowError(RangeError)
    expect(() => formatReferenceId('PHP', day, -1)).toThrowError(RangeError)
    expect(() => formatReferenceId('PHP', day, 1.5)).toThrowError(RangeError)
  })
})

describe('generateDepositReference', () => {
  const order = { referenceId: 'TP-PHP-20260907-0007' }

  it('differs from the order reference_id and carries no TP- prefix', () => {
    const dep = generateDepositReference(order)
    expect(dep).not.toBe(order.referenceId)
    expect(dep.startsWith('TP-')).toBe(false)
    expect(dep).toMatch(DEPOSIT_REFERENCE_PATTERN)
    expect(REFERENCE_ID_PATTERN.test(dep)).toBe(false)
  })

  it('unique across 5000 generations for the same order', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(generateDepositReference(order))
    expect(seen.size).toBe(5000)
  })

  it('carries the reference_id so a reviewer can trace back to the order', () => {
    expect(generateDepositReference(order)).toContain('PHP-20260907-0007')
  })
})
