import { describe, expect, it } from 'vitest'
import { divRound, fromUnits, normalizeAmount, rescale, toUnits } from '@/src/domain/money'
import { computeQuote, isQuoteExpired } from '@/src/domain/quote'
import {
  PLACEHOLDER_FEE_RATE,
  PLACEHOLDER_FX_RATE_USD_PHP,
  QUOTE_TTL_SECONDS,
  STELLAR_DECIMALS,
} from '@/src/domain/types'

const NOW = new Date('2026-09-07T10:00:00.000Z')

describe('money (BigInt, no floats)', () => {
  it('toUnits/fromUnits round-trip on the 7-decimal scale', () => {
    expect(toUnits('100')).toBe(1_000_000_000n)
    expect(toUnits('0.0000001')).toBe(1n)
    expect(fromUnits(1_000_000_000n)).toBe('100.0000000')
    expect(fromUnits(1n)).toBe('0.0000001')
    expect(normalizeAmount('100')).toBe('100.0000000')
  })

  it('rejects strings with excess decimals instead of rounding silently', () => {
    expect(() => toUnits('1.12345678')).toThrowError(RangeError)
    expect(() => toUnits('abc')).toThrowError(RangeError)
    expect(() => toUnits('')).toThrowError(RangeError)
  })

  it('divRound rounds half-up, with no dependence on floats', () => {
    expect(divRound(5n, 10n)).toBe(1n)
    expect(divRound(4n, 10n)).toBe(0n)
    expect(divRound(15n, 10n)).toBe(2n)
    expect(divRound(-5n, 10n)).toBe(-1n)
    expect(rescale(690_555_549_328n, 7, 2)).toBe(6_905_555n)
  })

  it('does not hit the float 0.1 + 0.2 bug', () => {
    expect(fromUnits(toUnits('0.1') + toUnits('0.2'))).toBe('0.3000000')
  })
})

describe('computeQuote', () => {
  it('uses the placeholder FX from the contract, calls no API', () => {
    expect(computeQuote('100', NOW).fxRate).toBe(PLACEHOLDER_FX_RATE_USD_PHP)
  })

  it('100 USD: 1% fee, converts the net part', () => {
    const q = computeQuote('100', NOW)
    expect(q.feeUsd).toBe('1.0000000')
    expect(q.netUsd).toBe('99.0000000')
    // 99 * 56.5 = 5593.50
    expect(q.phpEstimate).toBe('5593.50')
  })

  it('stays exact on an odd 7-decimal amount', () => {
    const q = computeQuote('1234.5678901', NOW)
    expect(q.feeUsd).toBe('12.3456789')
    expect(q.netUsd).toBe('1222.2222112')
    expect(q.phpEstimate).toBe('69055.55')
  })

  it('fee = usdAmount * PLACEHOLDER_FEE_RATE also checks out recomputed in BigInt', () => {
    const usd = '873.1234567'
    const q = computeQuote(usd, NOW)
    const expectedFee = divRound(
      toUnits(usd) * toUnits(PLACEHOLDER_FEE_RATE),
      10n ** BigInt(STELLAR_DECIMALS),
    )
    expect(q.feeUsd).toBe(fromUnits(expectedFee))
  })

  it('reproducible: 10 runs give the same result', () => {
    const first = computeQuote('250.5', NOW)
    for (let i = 0; i < 10; i++) {
      const again = computeQuote('250.5', NOW)
      expect(again).toEqual(first)
    }
  })

  it('quoteExpiresAt = quotedAt + QUOTE_TTL_SECONDS', () => {
    const q = computeQuote('100', NOW)
    expect(q.quotedAt.toISOString()).toBe(NOW.toISOString())
    expect(q.quoteExpiresAt.getTime() - q.quotedAt.getTime()).toBe(QUOTE_TTL_SECONDS * 1000)
  })

  it('rejects amounts <= 0', () => {
    expect(() => computeQuote('0', NOW)).toThrowError(RangeError)
    expect(() => computeQuote('-5', NOW)).toThrowError(RangeError)
  })
})

describe('isQuoteExpired', () => {
  const expiresAt = new Date(NOW.getTime() + QUOTE_TTL_SECONDS * 1000)

  it('false before the deadline', () => {
    expect(isQuoteExpired({ quoteExpiresAt: expiresAt }, new Date(expiresAt.getTime() - 1))).toBe(false)
  })

  it('exactly at the deadline counts as expired', () => {
    expect(isQuoteExpired({ quoteExpiresAt: expiresAt }, expiresAt)).toBe(true)
  })

  it('true past the deadline', () => {
    expect(isQuoteExpired({ quoteExpiresAt: expiresAt }, new Date(expiresAt.getTime() + 1))).toBe(true)
  })

  it('no quote yet counts as expired', () => {
    expect(isQuoteExpired({ quoteExpiresAt: null }, NOW)).toBe(true)
  })
})
