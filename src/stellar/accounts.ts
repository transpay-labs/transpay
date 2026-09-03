/**
 * CORRIDOR ACCOUNTS.
 *
 *   treasury (USD-side) ──USDC──> payout (PHP-side)
 *
 * Only treasury needs a secret because it is the source that signs the tx. Payout only
 * needs a public key. NEVER log the secret — every function here hands out public keys only.
 */
import { Keypair } from '@stellar/stellar-sdk'
import './config' // pulls in the network guard + dotenv

const PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/
const SECRET_KEY_RE = /^S[A-Z2-7]{55}$/

function readEnv(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(
      `${name} is not set — see .env.example. Run \`pnpm stellar:bootstrap\` to create the testnet accounts.`,
    )
  }
  return v
}

// ─── Treasury (source) ─────────────────────────────────────────────────────

function loadTreasuryKeypair(): Keypair {
  const secret = readEnv('CORRIDOR_TREASURY_SECRET')
  // Never put the secret's value into an error message.
  if (!SECRET_KEY_RE.test(secret)) {
    throw new Error('CORRIDOR_TREASURY_SECRET has the wrong format — it must be an S... secret seed (56 base32 characters).')
  }
  try {
    return Keypair.fromSecret(secret)
  } catch {
    throw new Error('CORRIDOR_TREASURY_SECRET could not be parsed (bad checksum?). The value has been withheld from the log.')
  }
}

/** The keypair that signs settlement txs. Kept inside the module, never exported as a string. */
export const treasuryKeypair: Keypair = loadTreasuryKeypair()

/** Treasury's public key — safe to log / write to the DB / put into evidence. */
export const TREASURY_PUBLIC: string = treasuryKeypair.publicKey()

// ─── Payout (destination) ──────────────────────────────────────────────────

function loadPayoutPublic(): string {
  const pub = readEnv('CORRIDOR_PAYOUT_PUBLIC')
  if (!PUBLIC_KEY_RE.test(pub)) {
    throw new Error(`CORRIDOR_PAYOUT_PUBLIC is not a valid public key (G... 56 characters): "${pub}"`)
  }
  try {
    Keypair.fromPublicKey(pub)
  } catch {
    throw new Error('CORRIDOR_PAYOUT_PUBLIC could not be parsed (bad checksum?).')
  }
  return pub
}

export const PAYOUT_PUBLIC: string = loadPayoutPublic()

if (TREASURY_PUBLIC === PAYOUT_PUBLIC) {
  throw new Error('CORRIDOR_TREASURY_SECRET and CORRIDOR_PAYOUT_PUBLIC point at the same account — the settlement leg would be meaningless.')
}

/** Masks a secret when it absolutely has to be printed (debug only, never for evidence). */
export function maskSecret(secret: string): string {
  if (secret.length < 12) return '***'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}
