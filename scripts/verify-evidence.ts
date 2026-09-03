/**
 * RE-CHECK THE EVIDENCE PACK — FULLY OFFLINE.
 *
 *   npx tsx scripts/verify-evidence.ts                 # newest D2 run
 *   npx tsx scripts/verify-evidence.ts evidence/d2/<runId>
 *
 * Why this script exists: after the Stellar Testnet reset (2026-12-16), every
 * Stellar Expert link in the result tables will die. What remains as evidence is
 * the two files per tx in `tx/`: the raw signed XDR and the full Horizon JSON.
 *
 * This script touches NO network and reads NO database. It does one thing:
 * recompute the transaction hash FROM the signed XDR string itself, then match
 * the hash, memo, amount, source/destination addresses and asset between the XDR
 * and the saved JSON.
 *
 * Put differently: it proves the evidence pack is self-consistent without having
 * to trust the builder's database, without Horizon, and without the internet.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Networks, Transaction } from '@stellar/stellar-sdk'
import { Operation } from '@stellar/stellar-sdk'
import { mdTable } from './evidence-lib'
import type { Column } from './evidence-lib'
import { NO, YES, amountsEqual, sumAmounts } from './evidence-lib'
import { STELLAR_DECIMALS } from '@/src/domain/types'

interface Check {
  referenceId: string
  txHash: string
  ledgerSeq: number | null
  amount: string | null
  memo: string | null
  failures: string[]
  pass: boolean
}

/** The newest D2 run folder, by file modification time. */
function newestD2Run(): string {
  const base = resolve(process.cwd(), 'evidence', 'd2')
  if (!existsSync(base)) throw new Error('No evidence/d2 yet — run `pnpm evidence:d2` first.')
  const runs = readdirSync(base)
    .map((name) => join(base, name))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (runs.length === 0) throw new Error('evidence/d2 is empty — run `pnpm evidence:d2` first.')
  return runs[0]
}

function verifyOne(txDir: string, referenceId: string): Check {
  const failures: string[] = []
  const xdr = readFileSync(join(txDir, `${referenceId}.xdr`), 'utf8').trim()
  const jsonPath = join(txDir, `${referenceId}.horizon.json`)
  if (!existsSync(jsonPath)) {
    return { referenceId, txHash: '', ledgerSeq: null, amount: null, memo: null, failures: ['the .horizon.json file is missing'], pass: false }
  }
  const saved = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, any>

  // ── 1. Hash RECOMPUTED from the signed bytes themselves.
  const tx = new Transaction(xdr, Networks.TESTNET)
  const recomputedHash = tx.hash().toString('hex')
  if (recomputedHash !== saved['txHash']) {
    failures.push(`hash re-derived from the XDR (${recomputedHash}) differs from the stored hash (${String(saved['txHash'])})`)
  }

  // ── 2. The memo read from the XDR must equal the reference ID — this is where
  //      the tx proves for itself which order it belongs to, independent of any
  //      database.
  const rawMemo: unknown = tx.memo.value
  const memoFromXdr =
    rawMemo === null || rawMemo === undefined
      ? null
      : Buffer.isBuffer(rawMemo)
        ? rawMemo.toString('utf8')
        : String(rawMemo)
  if (memoFromXdr !== referenceId) {
    failures.push(`memo inside the XDR is "${memoFromXdr ?? 'empty'}", not ${referenceId}`)
  }

  // ── 3. The payment operation inside the XDR: destination + amount + asset.
  const op = tx.operations[0]
  if (!op || op.type !== 'payment') {
    failures.push(`the first operation is not a payment: ${op?.type ?? 'none'}`)
  } else {
    const payment = op as Operation.Payment
    const leg = (saved['databaseLeg'] ?? {}) as Record<string, unknown>
    if (payment.destination !== saved['corridor']?.phpSidePayoutFloat) {
      failures.push(`destination inside the XDR (${payment.destination}) differs from the recorded payout float`)
    }
    if (!amountsEqual(payment.amount, String(leg['amount'] ?? ''), STELLAR_DECIMALS)) {
      failures.push(`amount inside the XDR (${payment.amount}) differs from the recorded amount (${String(leg['amount'])})`)
    }
    const asset = payment.asset
    if (asset.getCode() !== saved['asset']?.code || asset.getIssuer() !== saved['asset']?.issuer) {
      failures.push('the asset inside the XDR differs from the recorded asset')
    }
  }
  if (tx.source !== saved['corridor']?.usdSideTreasury) {
    failures.push(`source inside the XDR (${tx.source}) differs from the recorded treasury`)
  }

  // ── 4. The Horizon JSON must carry every field the SOW demands.
  const horizon = (saved['horizonTransactionRefetched'] ?? saved['horizonResponseAtConfirm'] ?? {}) as Record<string, unknown>
  const ledgerSeq = typeof horizon['ledger'] === 'number' ? horizon['ledger'] : null
  if (ledgerSeq === null) failures.push('the Horizon JSON has no ledger sequence')
  if (!horizon['created_at']) failures.push('the Horizon JSON has no timestamp (created_at)')
  if (horizon['memo'] !== referenceId) failures.push(`the memo in the Horizon JSON is not ${referenceId}`)
  if (!horizon['source_account']) failures.push('the Horizon JSON has no source_account')
  if (horizon['successful'] !== true) failures.push('the Horizon JSON does not report successful = true')
  const ops = (saved['horizonOperations'] ?? []) as Array<Record<string, unknown>>
  if (ops.length === 0) failures.push('the Horizon JSON has no operations (destination + amount)')
  else {
    if (!ops[0]['to']) failures.push('the operation in the JSON has no destination')
    if (!ops[0]['amount']) failures.push('the operation in the JSON has no amount')
  }

  return {
    referenceId,
    txHash: recomputedHash,
    ledgerSeq,
    amount: String((saved['databaseLeg'] as Record<string, unknown> | undefined)?.['amount'] ?? ''),
    memo: memoFromXdr,
    failures,
    pass: failures.length === 0,
  }
}

function main(): void {
  const target = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : newestD2Run()
  const txDir = join(target, 'tx')
  if (!existsSync(txDir)) throw new Error(`${txDir} not found — is this a D2 run folder?`)

  const refs = readdirSync(txDir)
    .filter((f) => f.endsWith('.xdr'))
    .map((f) => f.replace(/\.xdr$/, ''))
    .sort()

  const checks = refs.map((ref) => verifyOne(txDir, ref))
  const passed = checks.filter((c) => c.pass).length

  const cols: readonly Column<Check>[] = [
    { header: 'Reference ID', get: (c) => c.referenceId },
    { header: 'Hash re-derived from signed XDR', get: (c) => `\`${c.txHash}\`` },
    { header: 'Memo in XDR', get: (c) => c.memo },
    { header: 'Amount', get: (c) => c.amount },
    { header: 'Ledger seq', get: (c) => c.ledgerSeq },
    { header: 'Result', get: (c) => (c.pass ? YES : NO) },
    { header: 'Notes', get: (c) => c.failures.join('; ') },
  ]

  console.log('')
  console.log(`Offline verification of ${target}`)
  console.log('(no network, no database — hashes are re-derived from the stored signed bytes)')
  console.log('')
  console.log(mdTable(cols, checks))
  console.log('')
  console.log(`Total across all legs: ${sumAmounts(checks.map((c) => c.amount ?? '0'))}`)
  console.log(`Result: ${passed}/${checks.length} transactions are internally consistent.`)
  console.log('')
  process.exit(passed === checks.length && checks.length > 0 ? 0 : 1)
}

main()
