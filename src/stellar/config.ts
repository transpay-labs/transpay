/**
 * STELLAR CONFIG — reads env once, fails at import time if anything is missing.
 *
 * Hard block on mainnet: Phase 1 runs on testnet only. If STELLAR_NETWORK is anything
 * other than 'testnet' this throws, and no flag can bypass it.
 *
 * NOTE: `scripts/bootstrap-accounts.ts` does NOT import this file — when bootstrap runs,
 * STELLAR_USDC_ISSUER is still empty (chicken-and-egg).
 */
import 'dotenv/config'
import { Asset, Horizon, Networks } from '@stellar/stellar-sdk'

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(
      `${name} is not set — see .env.example. If you do not have a value yet, run \`pnpm stellar:bootstrap\` and paste the output into .env.`,
    )
  }
  return v
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`)
  return Math.floor(n)
}

// ─── Network guard ─────────────────────────────────────────────────────────

/** Phase 1 does NOT touch mainnet. This is a hard block with no escape hatch. */
export const STELLAR_NETWORK = (process.env.STELLAR_NETWORK ?? '').trim()
if (STELLAR_NETWORK !== 'testnet') {
  throw new Error(
    `STELLAR_NETWORK must be "testnet" (got "${STELLAR_NETWORK || '<empty>'}"). ` +
      'Phase 1 is hard-blocked from mainnet — no mainnet keys or Horizon here.',
  )
}

export const NETWORK_PASSPHRASE = Networks.TESTNET

export const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org'

/**
 * `.env.example` ships the correct host (`horizon-testnet.stellar.org`), so the
 * branch below is not about this repository's own template any more.
 *
 * It stays as a guard against one specific typo that is easy to make by hand and
 * costs an afternoon to diagnose: `horizon-testnet.org`, without `.stellar`, is a
 * host that does not exist, and every Horizon call then fails with a DNS error
 * that says nothing about the cause. Fixing it silently would hide a config
 * mistake and throwing would block a running environment, so it self-heals and
 * warns loudly. On a `.env` copied from `.env.example` it never runs.
 */
function resolveHorizonUrl(): string {
  const raw = (process.env.STELLAR_HORIZON_URL?.trim() || DEFAULT_HORIZON_URL).replace(/\/+$/, '')
  if (!/^https:\/\//.test(raw)) {
    throw new Error(`STELLAR_HORIZON_URL must be https, got "${raw}"`)
  }
  if (new URL(raw).hostname === 'horizon-testnet.org') {
    console.warn(
      `[stellar] STELLAR_HORIZON_URL="${raw}" is a typo (missing ".stellar"), using ${DEFAULT_HORIZON_URL} instead. Fix your .env.`,
    )
    return DEFAULT_HORIZON_URL
  }
  return raw
}

export const HORIZON_URL = resolveHorizonUrl()

// ─── Asset settlement ──────────────────────────────────────────────────────

export const ASSET_CODE = required('STELLAR_ASSET_CODE')
export const ASSET_ISSUER = required('STELLAR_USDC_ISSUER')

if (!/^G[A-Z2-7]{55}$/.test(ASSET_ISSUER)) {
  throw new Error(`STELLAR_USDC_ISSUER is not a valid public key (G... 56 characters): "${ASSET_ISSUER}"`)
}

/** The settlement leg's asset. The testnet issuer is created by bootstrap, NOT fixed. */
export const SETTLEMENT_ASSET = new Asset(ASSET_CODE, ASSET_ISSUER)

// ─── Horizon server ────────────────────────────────────────────────────────

export const horizonServer = new Horizon.Server(HORIZON_URL)

// ─── Worker parameters ─────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = optionalInt('SETTLEMENT_POLL_INTERVAL_MS', 3000)
export const TIMEBOUNDS_SEC = optionalInt('SETTLEMENT_TIMEBOUNDS_SEC', 180)

/** Explorer links for the evidence pack. */
export function stellarExpertAccountUrl(publicKey: string): string {
  return `https://stellar.expert/explorer/testnet/account/${publicKey}`
}

export function stellarExpertTxUrl(txHash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${txHash}`
}
