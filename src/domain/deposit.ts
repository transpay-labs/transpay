/**
 * MOCK DEPOSIT REFERENCE — the string that tells a user how to deposit USD.
 *
 * Invariant #1: this is NOT settlement, it is only the trigger that pushes an
 * order to settlement_ready. It is also NOT the order's reference_id and it
 * does NOT go on the ledger ⇒ the 28-byte MEMO_TEXT limit does not apply.
 *
 * Uniqueness comes from two parts: the order's reference_id (already unique
 * system-wide) plus a random suffix (unguessable, and collision-free on
 * reissue). The final guarantee is still the unique index
 * deposit_references_reference_key.
 */
import { randomBytes } from 'node:crypto'

/** Crockford base32 minus I, L, O, U — a reviewer has to type this by hand. */
const SUFFIX_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SUFFIX_LENGTH = 8
/** 256 = 8*32 ⇒ divides evenly, so no modulo bias. */

export interface DepositReferenceOrderLike {
  referenceId: string
}

export function generateDepositReference(order: DepositReferenceOrderLike): string {
  const bytes = randomBytes(SUFFIX_LENGTH)
  let suffix = ''
  for (const byte of bytes) suffix += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]

  // Drop the "TP-" prefix so nobody mistakes this for the reference_id in the memo.
  return `DEP-${order.referenceId.replace(/^TP-/, '')}-${suffix}`
}

/** Recognizes a string produced by generateDepositReference. */
export const DEPOSIT_REFERENCE_PATTERN = /^DEP-(PHP|VND)-\d{8}-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/
