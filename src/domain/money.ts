/**
 * MONEY ARITHMETIC — BigInt over the smallest unit, NO floats.
 *
 * An error here is an error in the evidence: the number on the UI, the number
 * in the DB and the number in the memo have to match exactly. Stellar's
 * standard is 7 decimal places (STELLAR_DECIMALS).
 */
import { STELLAR_DECIMALS } from '@/src/domain/types'

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/

/** 10^n as a BigInt. */
export function pow10(n: number): bigint {
  return 10n ** BigInt(n)
}

/** Decimal string -> BigInt in the smallest unit. Excess decimals are an error. */
export function toUnits(value: string | number, decimals: number = STELLAR_DECIMALS): bigint {
  const raw = typeof value === 'number' ? String(value) : value.trim()
  const m = DECIMAL_RE.exec(raw)
  if (!m) throw new RangeError(`Invalid amount: "${raw}"`)
  const frac = m[3] ?? ''
  if (frac.length > decimals) {
    throw new RangeError(`"${raw}" has more than ${decimals} decimal places — precision would be lost`)
  }
  const units = BigInt(m[2] + frac.padEnd(decimals, '0'))
  return m[1] ? -units : units
}

/** BigInt in the smallest unit -> decimal string with exactly `decimals` places. */
export function fromUnits(units: bigint, decimals: number = STELLAR_DECIMALS): string {
  const neg = units < 0n
  const abs = neg ? -units : units
  const scale = pow10(decimals)
  const whole = abs / scale
  const frac = abs % scale
  const body = decimals === 0 ? String(whole) : `${whole}.${String(frac).padStart(decimals, '0')}`
  return neg ? `-${body}` : body
}

/** BigInt division, rounded half-up (0.5 away from zero). No floats here. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive')
  const neg = numerator < 0n
  const abs = neg ? -numerator : numerator
  const q = (abs * 2n + denominator) / (denominator * 2n)
  return neg ? -q : q
}

/** a * b / 10^decimals — multiply two values on the same `decimals` scale, keeping it. */
export function mulScaled(a: bigint, b: bigint, decimals: number = STELLAR_DECIMALS): bigint {
  return divRound(a * b, pow10(decimals))
}

/** Rescale: from `from` decimal places to `to`, rounded half-up. */
export function rescale(units: bigint, from: number, to: number): bigint {
  if (to >= from) return units * pow10(to - from)
  return divRound(units, pow10(from - to))
}

/** Normalize a money string to exactly `decimals` places — used when writing numeric. */
export function normalizeAmount(value: string | number, decimals: number = STELLAR_DECIMALS): string {
  return fromUnits(toUnits(value, decimals), decimals)
}
