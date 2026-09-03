/**
 * D1 — EVIDENCE OF TRANSFER ORDER CREATION (USD → PHP flow), 10 runs.
 *
 *   pnpm evidence:d1
 *
 * Each run: a different USD amount AND different recipient bank details, going
 * through EXACTLY the domain functions the app uses:
 *
 *   createOrder (draft→quoted) → confirmQuote (sender confirmation)
 *   → addRecipient → issueDepositReference
 *
 * D1 STOPS at `awaiting_deposit` — deliberately. Confirming the deposit is D2's
 * job; if D1 pushed the order to `settlement_ready`, the worker would pick it up
 * and spend testnet USDC for a deliverable that requires no tx at all.
 *
 * A run PASSES when all three SOW conditions hold:
 *   1. The FX quote is correct — checked by an INDEPENDENT calculation (see
 *      evidence-lib.ts)
 *   2. The sender confirmation was recorded — `confirmed_at` is set AND there is
 *      an order_events row `quoted → confirmed`
 *   3. The record is complete — USD amount, PHP estimate, quote (rate/fee/expiry),
 *      recipient bank info, reference ID
 *
 * Target 10/10. Output: `evidence/d1/<runId>/`.
 */
import { inArray } from 'drizzle-orm'
import { db } from '@/src/db/client'
import { ordersRepo } from '@/src/db/repo'
import type { OrderEvidenceRow } from '@/src/db/repo'
import { orderEvents } from '@/src/db/schema'
import { DEPOSIT_REFERENCE_PATTERN } from '@/src/domain/deposit'
import {
  addRecipient,
  confirmQuote,
  createOrder,
  issueDepositReference,
} from '@/src/domain/orders'
import type { RecipientInput } from '@/src/domain/orders'
import {
  QUOTE_TTL_SECONDS,
  REFERENCE_ID_PATTERN,
  STELLAR_DECIMALS,
} from '@/src/domain/types'
import {
  EvidenceRun,
  NO,
  PHP_DECIMALS,
  YES,
  amountsEqual,
  average,
  closePool,
  expectedQuote,
  fmtUtc,
  mdTable,
  rebuildIndex,
  secondsBetween,
} from './evidence-lib'
import type { Column, RunManifest } from './evidence-lib'

const ACTOR = 'script:evidence-d1'
const TARGET = 10

// ─── Dataset: 10 different amounts, 10 different banks/recipients ───────────

interface D1Case {
  usdAmount: string
  recipient: RecipientInput
}

const CASES: readonly D1Case[] = [
  { usdAmount: '25.00', recipient: { fullName: 'Maria Santos', bankName: 'BDO Unibank', accountNumber: '004561230011', bankCode: 'BNORPHMM' } },
  { usdAmount: '40.50', recipient: { fullName: 'Jose Rivera', bankName: 'Bank of the Philippine Islands', accountNumber: '008812457720', bankCode: 'BOPIPHMM' } },
  { usdAmount: '132.75', recipient: { fullName: 'Angelica Dela Cruz', bankName: 'Metropolitan Bank & Trust Co.', accountNumber: '013300998812', bankCode: 'MBTCPHMM' } },
  { usdAmount: '6.25', recipient: { fullName: 'Ramon Bautista', bankName: 'Land Bank of the Philippines', accountNumber: '019745003366', bankCode: 'TLBPPHMM' } },
  { usdAmount: '500.00', recipient: { fullName: 'Cristina Villanueva', bankName: 'Philippine National Bank', accountNumber: '010288114509', bankCode: 'PNBMPHMM' } },
  { usdAmount: '77.77', recipient: { fullName: 'Eduardo Mendoza', bankName: 'Security Bank Corporation', accountNumber: '000045619982', bankCode: 'SETCPHMM' } },
  { usdAmount: '15.10', recipient: { fullName: 'Lorna Aquino', bankName: 'UnionBank of the Philippines', accountNumber: '109933450077', bankCode: 'UBPHPHMM' } },
  { usdAmount: '260.90', recipient: { fullName: 'Benigno Ocampo', bankName: 'Rizal Commercial Banking Corp.', accountNumber: '450012876341', bankCode: 'RCBCPHMM' } },
  { usdAmount: '92.45', recipient: { fullName: 'Imelda Reyes', bankName: 'China Banking Corporation', accountNumber: '201778334455', bankCode: 'CHBKPHMM' } },
  { usdAmount: '3.99', recipient: { fullName: 'Rodrigo Pascual', bankName: 'Development Bank of the Philippines', accountNumber: '077611220034', bankCode: 'DBPHPHMM' } },
]

// ─── One result row ────────────────────────────────────────────────────────

interface D1Result {
  index: number
  referenceId: string
  orderId: string
  requestedUsd: string
  row: OrderEvidenceRow
  expected: ReturnType<typeof expectedQuote>
  /** Whether there is an order_events row `quoted → confirmed`. */
  confirmationEvent: { actor: string; createdAt: Date } | null
  quoteTtlSeconds: number | null
  checks: {
    fxQuoteCorrect: boolean
    senderConfirmationRecorded: boolean
    recordComplete: boolean
  }
  failures: string[]
  pass: boolean
}

// ─── Run one case through the exact domain path ─────────────────────────────

async function runCase(
  run: EvidenceRun,
  index: number,
  testCase: D1Case,
): Promise<{ orderId: string; referenceId: string }> {
  const created = await createOrder({ usdAmount: testCase.usdAmount, actor: ACTOR })
  // An access token must NEVER reach any evidence file — register it so every
  // later file write is scanned for it.
  run.registerSecret(created.accessToken)

  run.log('d1.order_created', {
    case: index,
    referenceId: created.referenceId,
    usdAmount: created.usdAmount,
    fxRate: created.fxRate,
    feeUsd: created.feeUsd,
    phpEstimate: created.phpEstimate,
  })

  await confirmQuote(created.id, new Date(), ACTOR)
  run.log('d1.sender_confirmed', { case: index, referenceId: created.referenceId })

  await addRecipient(created.id, testCase.recipient, ACTOR)
  const { depositReference } = await issueDepositReference(created.id, ACTOR)
  run.log('d1.recipient_and_deposit_reference', {
    case: index,
    referenceId: created.referenceId,
    bankName: testCase.recipient.bankName,
    bankCode: testCase.recipient.bankCode,
    depositReference,
  })

  return { orderId: created.id, referenceId: created.referenceId }
}

// ─── Evaluate one row against the three SOW conditions ──────────────────────

function evaluate(
  index: number,
  created: { orderId: string; referenceId: string },
  requestedUsd: string,
  row: OrderEvidenceRow,
  confirmationEvent: { actor: string; createdAt: Date } | null,
): D1Result {
  const expected = expectedQuote(requestedUsd)
  const failures: string[] = []

  // ── 1. The FX quote is correct.
  const fxOk = amountsEqual(row.fxRate, expected.fxRate, STELLAR_DECIMALS)
  const feeOk = amountsEqual(row.feeUsd, expected.feeUsd, STELLAR_DECIMALS)
  const phpOk = amountsEqual(row.phpEstimate, expected.phpEstimate, PHP_DECIMALS)
  const usdOk = amountsEqual(row.usdAmount, requestedUsd, STELLAR_DECIMALS)
  if (!usdOk) failures.push(`usd_amount mismatch: DB=${row.usdAmount} requested=${requestedUsd}`)
  if (!fxOk) failures.push(`fx_rate mismatch: DB=${row.fxRate} expected=${expected.fxRate}`)
  if (!feeOk) failures.push(`fee_usd mismatch: DB=${row.feeUsd} expected=${expected.feeUsd}`)
  if (!phpOk) failures.push(`php_estimate mismatch: DB=${row.phpEstimate} expected=${expected.phpEstimate}`)

  const quoteTtlSeconds = secondsBetween(row.quotedAt, row.quoteExpiresAt)
  if (quoteTtlSeconds !== QUOTE_TTL_SECONDS) {
    failures.push(`quote expiry mismatch: ${quoteTtlSeconds}s, expected ${QUOTE_TTL_SECONDS}s`)
  }
  const fxQuoteCorrect = usdOk && fxOk && feeOk && phpOk && quoteTtlSeconds === QUOTE_TTL_SECONDS

  // ── 2. The sender confirmation was recorded.
  if (row.confirmedAt === null) failures.push('confirmed_at is missing on transfer_orders')
  if (confirmationEvent === null) failures.push('the order_events row quoted → confirmed is missing')
  const senderConfirmationRecorded = row.confirmedAt !== null && confirmationEvent !== null

  // ── 3. The record is complete.
  const missing: string[] = []
  const need: readonly (readonly [string, unknown])[] = [
    ['reference_id', row.referenceId],
    ['usd_amount', row.usdAmount],
    ['php_estimate', row.phpEstimate],
    ['fx_rate', row.fxRate],
    ['fee_usd', row.feeUsd],
    ['quoted_at', row.quotedAt],
    ['quote_expires_at', row.quoteExpiresAt],
    ['recipient_name', row.recipientName],
    ['recipient_bank', row.recipientBank],
    ['recipient_account', row.recipientAccount],
    ['deposit_reference', row.depositReference],
  ]
  for (const [name, value] of need) {
    if (value === null || value === undefined || value === '') missing.push(name)
  }
  if (missing.length > 0) failures.push(`missing fields: ${missing.join(', ')}`)
  if (!REFERENCE_ID_PATTERN.test(row.referenceId)) {
    failures.push(`reference_id has the wrong format: ${row.referenceId}`)
  }
  if (row.depositReference !== null && !DEPOSIT_REFERENCE_PATTERN.test(row.depositReference)) {
    failures.push(`deposit_reference has the wrong format: ${row.depositReference}`)
  }
  if (row.corridor !== 'PHP') failures.push(`corridor is not PHP: ${row.corridor}`)
  if (row.status !== 'awaiting_deposit') {
    failures.push(`status is not awaiting_deposit: ${row.status}`)
  }
  const recordComplete =
    missing.length === 0 &&
    REFERENCE_ID_PATTERN.test(row.referenceId) &&
    row.corridor === 'PHP' &&
    row.status === 'awaiting_deposit'

  const checks = { fxQuoteCorrect, senderConfirmationRecorded, recordComplete }
  return {
    index,
    referenceId: created.referenceId,
    orderId: created.orderId,
    requestedUsd,
    row,
    expected,
    confirmationEvent,
    quoteTtlSeconds,
    checks,
    failures,
    pass: fxQuoteCorrect && senderConfirmationRecorded && recordComplete,
  }
}

// ─── Table columns ─────────────────────────────────────────────────────────

const quoteCols: readonly Column<D1Result>[] = [
  { header: '#', get: (r) => r.index },
  { header: 'Reference ID', get: (r) => r.referenceId },
  { header: 'USD amount', get: (r) => r.row.usdAmount },
  { header: 'FX rate USD→PHP', get: (r) => r.row.fxRate },
  { header: 'Fee USD (1%)', get: (r) => r.row.feeUsd },
  { header: 'PHP estimate', get: (r) => r.row.phpEstimate },
  { header: 'Quote issued (UTC)', get: (r) => fmtUtc(r.row.quotedAt) },
  { header: 'Quote expires (UTC)', get: (r) => fmtUtc(r.row.quoteExpiresAt) },
  { header: 'Sender confirmed (UTC)', get: (r) => fmtUtc(r.row.confirmedAt) },
  { header: 'Status', get: (r) => r.row.status },
  { header: 'Result', get: (r) => (r.pass ? YES : NO) },
]

const recipientCols: readonly Column<D1Result>[] = [
  { header: '#', get: (r) => r.index },
  { header: 'Reference ID', get: (r) => r.referenceId },
  { header: 'Recipient', get: (r) => r.row.recipientName },
  { header: 'Bank', get: (r) => r.row.recipientBank },
  { header: 'Bank code', get: (r) => CASES[r.index - 1]?.recipient.bankCode ?? '' },
  { header: 'Account number', get: (r) => r.row.recipientAccount },
  { header: 'Deposit reference', get: (r) => r.row.depositReference },
]

const checkCols: readonly Column<D1Result>[] = [
  { header: '#', get: (r) => r.index },
  { header: 'Reference ID', get: (r) => r.referenceId },
  { header: '1. FX quote correct', get: (r) => r.checks.fxQuoteCorrect },
  { header: '2. Sender confirmation recorded', get: (r) => r.checks.senderConfirmationRecorded },
  { header: '3. Record complete', get: (r) => r.checks.recordComplete },
  { header: 'Result', get: (r) => (r.pass ? YES : NO) },
  { header: 'Notes', get: (r) => (r.failures.length > 0 ? r.failures.join('; ') : '') },
]

/** CSV with every field merged — one file for anyone who wants to open it in Excel. */
const csvCols: readonly Column<D1Result>[] = [
  ...quoteCols.slice(0, 10),
  { header: 'Recipient', get: (r) => r.row.recipientName },
  { header: 'Bank', get: (r) => r.row.recipientBank },
  { header: 'Bank code', get: (r) => CASES[r.index - 1]?.recipient.bankCode ?? '' },
  { header: 'Account number', get: (r) => r.row.recipientAccount },
  { header: 'Deposit reference', get: (r) => r.row.depositReference },
  { header: 'Expected fee USD (independent calc)', get: (r) => r.expected.feeUsd },
  { header: 'Expected PHP estimate (independent calc)', get: (r) => r.expected.phpEstimate },
  { header: 'Quote TTL seconds', get: (r) => r.quoteTtlSeconds },
  { header: 'Check 1 FX quote correct', get: (r) => r.checks.fxQuoteCorrect },
  { header: 'Check 2 sender confirmation recorded', get: (r) => r.checks.senderConfirmationRecorded },
  { header: 'Check 3 record complete', get: (r) => r.checks.recordComplete },
  { header: 'Result', get: (r) => (r.pass ? YES : NO) },
  { header: 'Notes', get: (r) => r.failures.join('; ') },
]

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const run = new EvidenceRun('d1')
  run.log('d1.run_start', { runId: run.id, cases: CASES.length, actor: ACTOR })

  // ── 1. Run the 10 cases. Sequentially, so reference IDs are issued in a readable order.
  const created: { orderId: string; referenceId: string }[] = []
  for (const [i, testCase] of CASES.entries()) {
    created.push(await runCase(run, i + 1, testCase))
  }
  const refs = created.map((c) => c.referenceId)
  const ids = created.map((c) => c.orderId)

  // ── 2. Read back from the DB through the evidence repo (which never selects
  //      access_token) and FILTER down to exactly this run's orders. The DB
  //      already holds orders from smoke tests — we filter, we do not delete.
  const allRows = await ordersRepo.listForEvidence(db, 500)
  const byRef = new Map(allRows.map((r) => [r.referenceId, r]))
  const skipped = allRows.length - refs.filter((r) => byRef.has(r)).length

  const events = await db
    .select({
      orderId: orderEvents.orderId,
      fromStatus: orderEvents.fromStatus,
      toStatus: orderEvents.toStatus,
      actor: orderEvents.actor,
      createdAt: orderEvents.createdAt,
    })
    .from(orderEvents)
    .where(inArray(orderEvents.orderId, ids))

  // ── 3. Evaluate.
  const results: D1Result[] = []
  for (const [i, c] of created.entries()) {
    const row = byRef.get(c.referenceId)
    if (!row) throw new Error(`Could not read order ${c.referenceId} back from the DB — the evidence cannot be trusted.`)
    const confirmation =
      events.find(
        (e) => e.orderId === c.orderId && e.fromStatus === 'quoted' && e.toStatus === 'confirmed',
      ) ?? null
    results.push(
      evaluate(
        i + 1,
        c,
        CASES[i].usdAmount,
        row,
        confirmation ? { actor: confirmation.actor, createdAt: confirmation.createdAt } : null,
      ),
    )
  }

  const passed = results.filter((r) => r.pass).length
  const finishedAt = new Date()
  const headline = `${passed}/${TARGET} pass`

  // ── 4. Write the tables: Markdown for readers, CSV for tools.
  const uniqueAmounts = new Set(results.map((r) => r.row.usdAmount)).size
  const uniqueBanks = new Set(results.map((r) => r.row.recipientBank)).size
  const uniqueAccounts = new Set(results.map((r) => r.row.recipientAccount)).size
  const avgLatency = average(results.map((r) => secondsBetween(r.row.createdAt, r.row.confirmedAt)))

  const doc = [
    '# D1 — Transfer order creation (USD → PHP) · 10 runs',
    '',
    `**Result: ${passed}/${TARGET} passed.**`,
    '',
    `- Run ID: \`${run.id}\``,
    `- Started / finished (UTC): ${fmtUtc(run.startedAt)} → ${fmtUtc(finishedAt)}`,
    '- Corridor: USD → PHP. The FX rate is a fixed placeholder — Phase 1 does not',
    '  call any market rate provider.',
    `- Distinct USD amounts: ${uniqueAmounts}/${results.length} · distinct banks: ${uniqueBanks}/${results.length} · distinct account numbers: ${uniqueAccounts}/${results.length}`,
    `- This table contains **only** the ${results.length} orders created by this run.`,
    `  ${skipped} other orders currently in the database (earlier smoke tests) were`,
    '  filtered out. Nothing was deleted.',
    '',
    '## A run counts as passed only when all three conditions hold',
    '',
    '1. **The FX quote is correct.** The fee and the PHP estimate are recomputed',
    '   from scratch by an independent calculation inside the evidence script and',
    '   compared against what the database stored. The two must match exactly.',
    '2. **The sender confirmation was recorded.** The order carries a',
    '   `confirmed_at` timestamp *and* a `quoted → confirmed` row in the event log.',
    '3. **The record is complete.** USD amount, PHP estimate, quote (rate, fee,',
    '   expiry), recipient bank details, and reference ID are all present.',
    '',
    'No transaction reaches the ledger in D1: the orders stop at the',
    '`awaiting_deposit` state. The real settlements are deliverable D2.',
    '',
    '## Table 1 — Quote and sender confirmation',
    '',
    mdTable(quoteCols, results),
    '',
    `A quote is valid for ${QUOTE_TTL_SECONDS / 60} minutes from the moment it is issued, and the script checks that exact figure.`,
    '',
    '## Table 2 — Recipient bank details and deposit reference',
    '',
    mdTable(recipientCols, results),
    '',
    'Every run uses a different bank, a different account holder and a different',
    'account number. These recipients are **fabricated test data** created for the',
    'evidence pack — Phase 1 connects to no real bank and performs no KYC.',
    '',
    'The deposit reference (`DEP-…`) is a **simulated** payment instruction. It is',
    'not the order reference ID and it never appears on the ledger.',
    '',
    '## Table 3 — The three conditions, per run',
    '',
    mdTable(checkCols, results),
    '',
    '## Observed metric (not a pass/fail condition)',
    '',
    `- Average time from order creation to sender confirmation: **${avgLatency ?? '—'} seconds**. This is an automated script, so the number reflects machine speed, not user behaviour.`,
    '',
    '## Files in this folder',
    '',
    '| File | Contents |',
    '| --- | --- |',
    '| `d1-orders.md` | This document |',
    '| `d1-orders.csv` | Every column of all three tables, opens in Excel |',
    '| `d1-checks.csv` | The three-condition table on its own |',
    '| `run.json` | Machine-readable record of this run |',
    '| `run.log.jsonl` | Step-by-step log, one JSON object per event |',
    '',
    'None of these files contains an order access token or a wallet secret key:',
    'the script scans every byte before writing and aborts if it finds one.',
    '',
  ].join('\n')

  run.writeText('d1-orders.md', doc)
  run.writeCsv('d1-orders.csv', csvCols, results)
  run.writeCsv('d1-checks.csv', checkCols, results)

  const manifest: RunManifest = {
    deliverable: 'd1',
    runId: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    headline,
    pass: passed === TARGET,
    target: TARGET,
    passed,
    corridor: 'PHP',
    actor: ACTOR,
    ordersInDatabaseNotInThisRun: skipped,
    averageCreateToConfirmSeconds: avgLatency,
    cases: results.map((r) => ({
      index: r.index,
      referenceId: r.referenceId,
      status: r.row.status,
      requestedUsdAmount: r.requestedUsd,
      storedUsdAmount: r.row.usdAmount,
      fxRate: r.row.fxRate,
      feeUsd: r.row.feeUsd,
      phpEstimate: r.row.phpEstimate,
      expectedFeeUsd: r.expected.feeUsd,
      expectedPhpEstimate: r.expected.phpEstimate,
      quotedAt: r.row.quotedAt?.toISOString() ?? null,
      quoteExpiresAt: r.row.quoteExpiresAt?.toISOString() ?? null,
      quoteTtlSeconds: r.quoteTtlSeconds,
      confirmedAt: r.row.confirmedAt?.toISOString() ?? null,
      confirmationEventActor: r.confirmationEvent?.actor ?? null,
      recipient: {
        fullName: r.row.recipientName,
        bankName: r.row.recipientBank,
        bankCode: CASES[r.index - 1]?.recipient.bankCode ?? null,
        accountNumber: r.row.recipientAccount,
      },
      depositReference: r.row.depositReference,
      checks: r.checks,
      failures: r.failures,
      pass: r.pass,
    })),
    files: [],
  }
  manifest.files = run.files()
  run.writeJson('run.json', manifest)
  const indexPath = rebuildIndex()

  run.log('d1.run_done', { passed, target: TARGET, dir: run.rel(run.dir) })

  console.log('')
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`  D1 — transfer order creation:  ${passed}/${TARGET} PASS`)
  console.log('══════════════════════════════════════════════════════════════')
  for (const r of results) {
    console.log(
      `  ${String(r.index).padStart(2)}. ${r.referenceId}  ${r.row.usdAmount.padStart(12)} USD → ${String(r.row.phpEstimate).padStart(10)} PHP  ${r.pass ? 'PASS' : `FAIL (${r.failures.join('; ')})`}`,
    )
  }
  console.log('')
  console.log(`  Results table : ${run.rel(run.path('d1-orders.md'))}`)
  console.log(`  CSV           : ${run.rel(run.path('d1-orders.csv'))}`)
  console.log(`  Index         : ${indexPath}`)
  console.log('')

  await closePool(db)
  process.exit(passed === TARGET ? 0 : 1)
}

void main().catch(async (err) => {
  console.error('\nD1 FAILED:', err instanceof Error ? err.message : err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  await closePool(db).catch(() => {})
  process.exit(1)
})
