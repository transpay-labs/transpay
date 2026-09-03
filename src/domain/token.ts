/**
 * ACCESS TOKEN — the key that unlocks an order via its URL.
 *
 * KEPT SEPARATE from reference_id: never goes into a memo, a log, or the
 * evidence pack. Generated from crypto.randomBytes plus rejection sampling so
 * the 62 characters are evenly distributed (plain `% 62` would skew toward the
 * first 8 characters — modulo bias).
 */
import { randomBytes } from 'node:crypto'
import { ACCESS_TOKEN_LENGTH } from '@/src/domain/types'

export const BASE62_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 256 = 4*62 + 8 ⇒ dropping bytes >= 248 leaves all 62 characters equally likely. */
const REJECT_THRESHOLD = 248

export function generateAccessToken(length: number = ACCESS_TOKEN_LENGTH): string {
  if (!Number.isInteger(length) || length <= 0) throw new RangeError('length must be a positive integer')

  let out = ''
  while (out.length < length) {
    // Ask for a few extra bytes so rejected ones don't force another randomBytes call.
    const chunk = randomBytes((length - out.length) * 2)
    for (const byte of chunk) {
      if (byte >= REJECT_THRESHOLD) continue
      out += BASE62_ALPHABET[byte % 62]
      if (out.length === length) break
    }
  }
  return out
}
