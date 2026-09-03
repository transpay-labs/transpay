import { describe, expect, it } from 'vitest'
import { BASE62_ALPHABET, generateAccessToken } from '@/src/domain/token'
import { ACCESS_TOKEN_LENGTH, REFERENCE_ID_PATTERN } from '@/src/domain/types'

describe('generateAccessToken', () => {
  it('is exactly ACCESS_TOKEN_LENGTH long and base62 only', () => {
    for (let i = 0; i < 200; i++) {
      const token = generateAccessToken()
      expect(token).toHaveLength(ACCESS_TOKEN_LENGTH)
      expect(token).toMatch(/^[A-Za-z0-9]{22}$/)
    }
  })

  it('no collisions across 5000 generations', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(generateAccessToken())
    expect(seen.size).toBe(5000)
  })

  it('evenly distributed — no modulo bias', () => {
    const counts = new Map<string, number>()
    for (const ch of BASE62_ALPHABET) counts.set(ch, 0)

    const samples = 3000
    for (let i = 0; i < samples; i++) {
      for (const ch of generateAccessToken()) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }

    const total = samples * ACCESS_TOKEN_LENGTH
    const expected = total / BASE62_ALPHABET.length
    const values = [...counts.values()]

    // No character is missing, and the worst deviation from expectation stays in a wide band.
    // With plain `% 62` the first 8 characters would run ~25% high — past the bounds below.
    expect(Math.min(...values)).toBeGreaterThan(expected * 0.8)
    expect(Math.max(...values)).toBeLessThan(expected * 1.2)
  })

  it('never looks like a reference ID (two fully separate identifier spaces)', () => {
    for (let i = 0; i < 100; i++) {
      const token = generateAccessToken()
      expect(REFERENCE_ID_PATTERN.test(token)).toBe(false)
      expect(token).not.toContain('-')
    }
  })

  it('rejects an invalid length', () => {
    expect(() => generateAccessToken(0)).toThrowError(RangeError)
    expect(() => generateAccessToken(-1)).toThrowError(RangeError)
  })
})
