/**
 * ZOD SCHEMAS for every input that reaches a route handler.
 *
 * Principle: the client may ONLY send what it genuinely is the source of — the
 * USD amount the user typed, the recipient details the user typed. The rate,
 * the fee, the PHP estimate and the expected amount are all recomputed by the
 * server from the DB; no schema here accepts them.
 */
import { z } from 'zod'
import { ACCESS_TOKEN_LENGTH } from '@/src/domain/types'

// ─── Access token in the path param ────────────────────────────────────────

/** Base62 at the exact contract length. Rejected early so junk never hits the DB. */
export const accessTokenSchema = z
  .string()
  .length(ACCESS_TOKEN_LENGTH)
  .regex(/^[A-Za-z0-9]+$/, 'invalid access token')

// ─── USD amount ────────────────────────────────────────────────────────────

/** Demo ceiling — above this it is certainly a typo. */
export const MAX_USD_AMOUNT = 1_000_000

const decimalString = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, 'Amount must be a positive number with at most 7 decimal places')

export const usdAmountSchema = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .pipe(decimalString)
  .refine((v) => Number(v) > 0, 'Amount must be greater than 0')
  .refine((v) => Number(v) <= MAX_USD_AMOUNT, `Amount must be at most ${MAX_USD_AMOUNT} USD`)

// ─── POST /api/orders ──────────────────────────────────────────────────────

/**
 * The corridor is deliberately NOT accepted from the client: Phase 1 only opens
 * PHP (ACTIVE_CORRIDOR), and letting the client pick would open a path to
 * creating VND orders, which is not implemented.
 */
export const createOrderSchema = z.object({
  usdAmount: usdAmountSchema,
})

// ─── POST /api/orders/[token]/recipient ────────────────────────────────────

const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(min, `${label} is too short`).max(max, `${label} is too long`))

export const recipientSchema = z.object({
  fullName: trimmed(2, 120, 'Recipient name'),
  bankName: trimmed(2, 120, 'Bank name'),
  // Phase 1 does not validate against a real bank — it only rejects junk characters.
  accountNumber: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(
      z
        .string()
        .min(4, 'Account number is too short')
        .max(34, 'Account number is too long')
        .regex(/^[A-Za-z0-9]+$/, 'Account number may contain only letters and digits'),
    ),
  bankCode: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().max(20, 'Bank code is too long'))
    .optional()
    .transform((v) => (v ? v : null)),
})

// ─── POST /api/orders/[token]/confirm-deposit ──────────────────────────────

/**
 * No `usdAmount`. The amount to check against comes from deposit_references in
 * the DB.
 *
 * `depositReference` is optional and defaults to this order's own reference
 * (read from the DB). Sending it is allowed so the D2 negative script can
 * simulate "deposited under another order's reference" through the real API
 * path; the UI never sends this field.
 */
export const confirmDepositSchema = z.object({
  depositReference: z.string().trim().min(1).max(64).optional(),
})
