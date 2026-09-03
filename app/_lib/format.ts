/**
 * DISPLAY FORMATTING. Every slice/grouping of digits happens on STRINGS — never
 * parsed into Number, because the numbers on screen must match the numbers in
 * the DB and in the memo exactly.
 */
import type { OrderStatus } from './types'

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** "500.0000000" -> "500.00"; "1234.5678900" -> "1,234.56789". */
export function decimal(value: string | null | undefined, minFrac = 2): string {
  if (!value) return '—'
  const [whole, rawFrac = ''] = value.split('.')
  let frac = rawFrac.replace(/0+$/, '')
  while (frac.length < minFrac) frac += '0'
  return frac ? `${groupThousands(whole)}.${frac}` : groupThousands(whole)
}

export const usd = (v: string | null | undefined) => `${decimal(v)} USD`
export const php = (v: string | null | undefined) => `₱ ${decimal(v)}`

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * "13:45 UTC" — the small timestamp on a chat bubble.
 *
 * Read in UTC, like dateTime below, so a bubble timestamp and a card date in
 * the same screenshot can never disagree. Reading it in UTC also makes the
 * output independent of the machine's timezone, so server and client render
 * the same string.
 */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
}

/**
 * "2026-09-03 13:45 UTC" — ISO order with an explicit zone.
 *
 * Deliberately NOT a numeric day/month layout: `03/09/2026` reads as 3 September
 * to a European reviewer and 9 March to an American one, and these dates carry
 * evidence (quote expiry, settlement submit/confirm time). ISO order also matches
 * the date already embedded in a reference ID (TP-PHP-20260903-0110), so a
 * reviewer can check the two against each other at a glance.
 *
 * The zone is spelled out because the evidence pack is recorded in UTC and a
 * reviewer in another timezone otherwise cannot verify an expiry time.
 */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    ` ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
  )
}

/** "12:34 left" or "expired". */
export function countdown(expiresAtIso: string | null, nowMs: number): string {
  if (!expiresAtIso) return 'no expiry'
  const left = new Date(expiresAtIso).getTime() - nowMs
  if (left <= 0) return 'expired'
  const total = Math.floor(left / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} left`
}

/** Label for each status — used in the header pill. */
export const STATUS_LABEL: Record<OrderStatus, string> = {
  draft: 'Draft',
  quoted: 'Quoted',
  confirmed: 'Rate locked',
  recipient_added: 'Recipient added',
  awaiting_deposit: 'Awaiting deposit',
  settlement_ready: 'Ready to settle',
  settling: 'Submitting to ledger',
  settled: 'Completed',
  rejected: 'Rejected',
  expired: 'Expired',
}

export const REJECT_REASON_LABEL: Record<string, string> = {
  duplicate_deposit_reference: 'Deposit reference already used for another transaction',
  mismatched_amount: 'Deposited amount does not match the quoted amount',
  mismatched_order: 'Deposit reference does not belong to this transaction',
  quote_expired: 'The exchange rate expired before confirmation',
  invalid_transition: 'The status was changed by another process',
}
