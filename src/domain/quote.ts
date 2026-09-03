/**
 * QUOTE — fixed placeholder FX, does NOT call a market rate (out-of-scope #11).
 *
 * Every number comes from types.ts so ten test runs produce one result. The
 * whole calculation runs on BigInt (see money.ts) — no float at any step.
 *
 * Final formula:
 *   feeUsd       = usdAmount * PLACEHOLDER_FEE_RATE            (7 places, half-up)
 *   netUsd       = usdAmount - feeUsd
 *   phpEstimate  = netUsd * PLACEHOLDER_FX_RATE_USD_PHP        (then down to 2 places)
 * The fee comes off before conversion: the recipient gets exactly what is left.
 */
import { fromUnits, mulScaled, rescale, toUnits } from '@/src/domain/money'
import {
  PLACEHOLDER_FEE_RATE,
  PLACEHOLDER_FX_RATE_USD_PHP,
  QUOTE_TTL_SECONDS,
  STELLAR_DECIMALS,
} from '@/src/domain/types'

/** PHP is stored in the DB at scale 2 (numeric(20,2)). */
export const PHP_DECIMALS = 2

export interface Quote {
  /** String with 7 decimal places, exactly the placeholder constant. */
  fxRate: string
  /** USD, 7 decimal places. */
  feeUsd: string
  /** USD after the fee — the part actually converted and put on the ledger. */
  netUsd: string
  /** PHP, 2 decimal places. */
  phpEstimate: string
  quotedAt: Date
  quoteExpiresAt: Date
}

/** The minimum an order needs for a quote-expiry check. */
export interface QuotedOrderLike {
  quoteExpiresAt: Date | string | null
}

export function computeQuote(usdAmount: string | number, now: Date = new Date()): Quote {
  const usdUnits = toUnits(usdAmount, STELLAR_DECIMALS)
  if (usdUnits <= 0n) throw new RangeError(`usdAmount must be > 0, received "${usdAmount}"`)

  const feeUnits = mulScaled(usdUnits, toUnits(PLACEHOLDER_FEE_RATE, STELLAR_DECIMALS), STELLAR_DECIMALS)
  const netUnits = usdUnits - feeUnits
  const phpUnits7 = mulScaled(netUnits, toUnits(PLACEHOLDER_FX_RATE_USD_PHP, STELLAR_DECIMALS), STELLAR_DECIMALS)
  const phpUnits2 = rescale(phpUnits7, STELLAR_DECIMALS, PHP_DECIMALS)

  return {
    fxRate: PLACEHOLDER_FX_RATE_USD_PHP,
    feeUsd: fromUnits(feeUnits, STELLAR_DECIMALS),
    netUsd: fromUnits(netUnits, STELLAR_DECIMALS),
    phpEstimate: fromUnits(phpUnits2, PHP_DECIMALS),
    quotedAt: new Date(now.getTime()),
    quoteExpiresAt: new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000),
  }
}

/** No quote yet counts as expired — do not let it go any further. */
export function isQuoteExpired(order: QuotedOrderLike, now: Date = new Date()): boolean {
  const raw = order.quoteExpiresAt
  if (raw == null) return true
  const expiresAt = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(expiresAt.getTime())) return true
  return now.getTime() >= expiresAt.getTime()
}
