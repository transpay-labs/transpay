/**
 * D2 — EVIDENCE OF SETTLEMENT ON STELLAR TESTNET.
 *
 *   pnpm evidence:d2
 *
 * TWO SEPARATE GROUPS, NUMBERS NEVER MERGED:
 *
 *   Positive — 10 runs. Passes when a REAL USDC tx exists on Testnet, the tx
 *              hash binds to the right order (memo on the ledger =
 *              reference_id), and a Stellar Expert link exists. Target 10/10.
 *
 *   Negative — 5 runs (3 duplicate deposit references + 2 mismatched
 *              amount/order). Passes when the order is REJECTED and NO tx is
 *              produced, with a log as the evidence. Target 5/5.
 *
 * A rejected case produces no tx, so it is NOT counted towards the 10/10. The
 * original SOW merged the two numbers and contradicted itself (a rejected case
 * cannot be both "rejected" and "have a tx hash bound to the order"); this
 * version keeps the two tables strictly apart.
 *
 * The settlement path uses EXACTLY the `runOnce` that `pnpm worker` runs, with
 * `liveStellarPort`. There is no evidence-only shortcut: whatever tx hash this
 * script produces is the same tx hash the worker produces.
 *
 * REAL (testnet) money leaves the treasury in the positive group. That is the point.
 *
 * Output: `evidence/d2/<runId>/`, including the raw signed XDR and the full
 * Horizon JSON for each tx — network-independent originals that survive the
 * 2026-12-16 testnet reset (when every Stellar Expert link will die).
 */
import { and, count, eq, inArray } from 'drizzle-orm'
import { db } from '@/src/db/client'
import { ordersRepo, settlementsRepo } from '@/src/db/repo'
import type { Settlement } from '@/src/db/repo'
import { orderEvents, settlements } from '@/src/db/schema'
import { DomainError } from '@/src/domain/errors'
import {
  addRecipient,
  confirmDeposit,
  confirmQuote,
  createOrder,
  getOrder,
  issueDepositReference,
} from '@/src/domain/orders'
import type { RecipientInput } from '@/src/domain/orders'
import { STELLAR_DECIMALS } from '@/src/domain/types'
import type { RejectReason } from '@/src/domain/types'
import {
  ASSET_CODE,
  ASSET_ISSUER,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  PAYOUT_PUBLIC,
  TREASURY_PUBLIC,
  stellarExpertAccountUrl,
  stellarExpertTxUrl,
} from '@/src/stellar'
import { consoleLogger } from '@/src/worker/log'
import { createAdvisoryLock } from '@/src/worker/lock'
import { liveStellarPort } from '@/src/worker/ports'
import { listCandidateOrders } from '@/src/worker/settle'
import { runOnce } from '@/src/worker/index'
import {
  EvidenceRun,
  NO,
  YES,
  amountsEqual,
  assetBalanceOf,
  average,
  closePool,
  expectedQuote,
  fetchJson,
  fmtUtc,
  incomingPaymentHistory,
  mdTable,
  oneStepCheckHolds as checkOneStepHolds,
  rebuildIndex,
  secondsBetween,
  shortHash,
  subtractAmounts,
  sumAmounts,
  transactionOperations,
} from './evidence-lib'
import type { Column, RunManifest } from './evidence-lib'

/**
 * Escape hatch for LOCAL ITERATION ONLY.
 *
 * A handover pack requires a payout float that has received nothing but the
 * settlements in that one report — see `oneStepCheckHolds` below. While fixing
 * a bug you may want to re-run against the corridor you already have and not
 * care about that. Pass this flag and the run still reports the violation
 * loudly, in the console AND in the published document, but exits 0.
 *
 * It deliberately cannot silence the warning, only the exit code.
 */
const ALLOW_REUSED_CORRIDOR = process.argv.includes('--allow-reused-corridor')

const ACTOR = 'script:evidence-d2'
const POSITIVE_TARGET = 10
const NEGATIVE_TARGET = 5

// ─── Positive dataset: 10 amounts + 10 different recipients ─────────────────

interface Party {
  usdAmount: string
  recipient: RecipientInput
}

const POSITIVES: readonly Party[] = [
  { usdAmount: '11.00', recipient: { fullName: 'Andrea Lim', bankName: 'BDO Unibank', accountNumber: '004500112233', bankCode: 'BNORPHMM' } },
  { usdAmount: '23.50', recipient: { fullName: 'Marco Salazar', bankName: 'Bank of the Philippine Islands', accountNumber: '008877665544', bankCode: 'BOPIPHMM' } },
  { usdAmount: '47.25', recipient: { fullName: 'Divina Torres', bankName: 'Metropolitan Bank & Trust Co.', accountNumber: '013312094488', bankCode: 'MBTCPHMM' } },
  { usdAmount: '8.75', recipient: { fullName: 'Nestor Galang', bankName: 'Land Bank of the Philippines', accountNumber: '019700455112', bankCode: 'TLBPPHMM' } },
  { usdAmount: '156.40', recipient: { fullName: 'Perlita Domingo', bankName: 'Philippine National Bank', accountNumber: '010255678123', bankCode: 'PNBMPHMM' } },
  { usdAmount: '99.99', recipient: { fullName: 'Arturo Bacani', bankName: 'Security Bank Corporation', accountNumber: '000078451236', bankCode: 'SETCPHMM' } },
  { usdAmount: '5.50', recipient: { fullName: 'Yolanda Cruz', bankName: 'UnionBank of the Philippines', accountNumber: '109944556677', bankCode: 'UBPHPHMM' } },
  { usdAmount: '302.10', recipient: { fullName: 'Fernando Lacson', bankName: 'Rizal Commercial Banking Corp.', accountNumber: '450099887711', bankCode: 'RCBCPHMM' } },
  { usdAmount: '64.33', recipient: { fullName: 'Teresita Manalo', bankName: 'China Banking Corporation', accountNumber: '201700998877', bankCode: 'CHBKPHMM' } },
  { usdAmount: '18.68', recipient: { fullName: 'Gregorio Paras', bankName: 'Development Bank of the Philippines', accountNumber: '077655443322', bankCode: 'DBPHPHMM' } },
]

// ─── Negative dataset: 3 duplicate + 2 mismatched ──────────────────────────

type NegativeKind = 'duplicate_reference' | 'mismatched_amount' | 'mismatched_order'

interface NegativeCase extends Party {
  kind: NegativeKind
  /** A description for the reviewer, not for a programmer. */
  label: string
  expectedRejectReason: RejectReason
}

const NEGATIVES: readonly NegativeCase[] = [
  {
    kind: 'duplicate_reference',
    label: 'Re-submitted the deposit reference already used by positive order #1',
    expectedRejectReason: 'duplicate_deposit_reference',
    usdAmount: '31.00',
    recipient: { fullName: 'Duplicate Case One', bankName: 'BDO Unibank', accountNumber: '004500999001', bankCode: 'BNORPHMM' },
  },
  {
    kind: 'duplicate_reference',
    label: 'Re-submitted the deposit reference already used by positive order #2',
    expectedRejectReason: 'duplicate_deposit_reference',
    usdAmount: '32.00',
    recipient: { fullName: 'Duplicate Case Two', bankName: 'Metropolitan Bank & Trust Co.', accountNumber: '013399888002', bankCode: 'MBTCPHMM' },
  },
  {
    kind: 'duplicate_reference',
    label: 'Re-submitted the deposit reference already used by positive order #3',
    expectedRejectReason: 'duplicate_deposit_reference',
    usdAmount: '33.00',
    recipient: { fullName: 'Duplicate Case Three', bankName: 'Security Bank Corporation', accountNumber: '000077666003', bankCode: 'SETCPHMM' },
  },
  {
    kind: 'mismatched_amount',
    label: "The order's own deposit reference, but the amount paid in is 5.00 USD too high",
    expectedRejectReason: 'mismatched_amount',
    usdAmount: '41.00',
    recipient: { fullName: 'Amount Mismatch Case', bankName: 'UnionBank of the Philippines', accountNumber: '109900112004', bankCode: 'UBPHPHMM' },
  },
  {
    kind: 'mismatched_order',
    label: 'A deposit reference belonging to a different order (never used before)',
    expectedRejectReason: 'mismatched_order',
    usdAmount: '42.00',
    recipient: { fullName: 'Order Mismatch Case', bankName: 'China Banking Corporation', accountNumber: '201700334005', bankCode: 'CHBKPHMM' },
  },
]

/** An order that exists only to issue an UNUSED deposit reference for the mismatched_order case. */
const MISMATCH_FIXTURE: Party = {
  usdAmount: '43.00',
  recipient: { fullName: 'Unused Reference Fixture', bankName: 'Philippine National Bank', accountNumber: '010200000006', bankCode: 'PNBMPHMM' },
}

// ─── Results ───────────────────────────────────────────────────────────────

interface PositiveResult {
  index: number
  referenceId: string
  orderId: string
  usdAmount: string
  expectedSettlementAmount: string
  orderStatus: string
  outcomeKind: string
  outcomeReason: string
  leg: Settlement | null
  ledgerCreatedAt: string | null
  depositConfirmedAt: Date | null
  bindSeconds: number | null
  ledgerSeconds: number | null
  xdrFile: string | null
  horizonFile: string | null
  checks: {
    realTxOnTestnet: boolean
    memoBindsOrder: boolean
    amountCorrect: boolean
    ledgerConfirmed: boolean
    originalsSaved: boolean
  }
  failures: string[]
  pass: boolean
}

interface NegativeResult {
  index: number
  kind: NegativeKind
  label: string
  referenceId: string
  orderId: string
  submittedDepositReference: string
  submittedUsdAmount: string
  expectedRejectReason: RejectReason
  errorName: string | null
  errorMessage: string | null
  actualRejectReason: string | null
  finalStatus: string
  settlementLegs: number
  rejectEventRecorded: boolean
  failures: string[]
  pass: boolean
}

// ─── Build an order up to `awaiting_deposit` ───────────────────────────────

async function prepareOrder(
  run: EvidenceRun,
  party: Party,
  tag: string,
): Promise<{ orderId: string; referenceId: string; depositReference: string }> {
  const created = await createOrder({ usdAmount: party.usdAmount, actor: ACTOR })
  // An access token is never written to evidence — register it so it gets scanned.
  run.registerSecret(created.accessToken)
  await confirmQuote(created.id, new Date(), ACTOR)
  await addRecipient(created.id, party.recipient, ACTOR)
  const { depositReference } = await issueDepositReference(created.id, ACTOR)
  run.log('d2.order_prepared', {
    tag,
    referenceId: created.referenceId,
    usdAmount: created.usdAmount,
    phpEstimate: created.phpEstimate,
    bankName: party.recipient.bankName,
    depositReference,
  })
  return { orderId: created.id, referenceId: created.referenceId, depositReference }
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const run = new EvidenceRun('d2')
  const logger = consoleLogger
  // One lock object for the whole run — exactly like the worker: an advisory
  // lock on the treasury, globally serialised, so two txs never race for a
  // sequence number.
  const lock = createAdvisoryLock({})

  run.log('d2.run_start', {
    runId: run.id,
    positives: POSITIVES.length,
    negatives: NEGATIVES.length,
    horizon: HORIZON_URL,
    asset: `${ASSET_CODE}:${ASSET_ISSUER}`,
    treasury: TREASURY_PUBLIC,
    payout: PAYOUT_PUBLIC,
  })

  // ── 0. Preflight. NOTHING is cleaned up, only reported — another run's data
  //      is not this script's business.
  const preexisting = await listCandidateOrders(db, { limit: 50 })
  if (preexisting.length > 0) {
    run.log('d2.preflight_preexisting_settleable_orders', {
      note: 'these orders are NOT part of this run and are not touched by this script',
      orders: preexisting.map((o) => ({ referenceId: o.referenceId, status: o.status })),
    })
  }
  const settlementRowsAtStart = (await db.select({ n: count() }).from(settlements))[0]?.n ?? 0

  const payoutOpening = await assetBalanceOf(HORIZON_URL, PAYOUT_PUBLIC, ASSET_CODE, ASSET_ISSUER)
  const treasuryOpening = await assetBalanceOf(HORIZON_URL, TREASURY_PUBLIC, ASSET_CODE, ASSET_ISSUER)
  run.log('d2.opening_balances', {
    payout: payoutOpening,
    treasury: treasuryOpening,
    assetCode: ASSET_CODE,
  })

  // ── 1. POSITIVE GROUP — 10 real USDC txs, SEQUENTIALLY.
  const positives: PositiveResult[] = []
  const consumedDepositReferences: string[] = []

  for (const [i, party] of POSITIVES.entries()) {
    const index = i + 1
    const prepared = await prepareOrder(run, party, `positive-${index}`)

    await confirmDeposit(
      prepared.orderId,
      { depositReference: prepared.depositReference, usdAmount: party.usdAmount },
      ACTOR,
    )
    consumedDepositReferences.push(prepared.depositReference)
    run.log('d2.deposit_confirmed', {
      case: index,
      referenceId: prepared.referenceId,
      depositReference: prepared.depositReference,
    })

    // Exactly the scan `pnpm worker` performs, narrowed to one reference_id so
    // it cannot touch another run's orders.
    const report = await runOnce({
      logger,
      stellar: liveStellarPort,
      lock,
      referenceLike: prepared.referenceId,
      limit: 1,
    })
    const outcome = report.outcomes[0]

    const order = await getOrder(prepared.orderId)
    const leg = await settlementsRepo.findActiveByOrderId(db, prepared.orderId)
    const expectedAmount = expectedQuote(party.usdAmount).netUsd

    const failures: string[] = []
    if (order.status !== 'settled') failures.push(`order is not settled: ${order.status}`)
    if (!leg) failures.push('no settlement leg was created')
    if (leg && leg.status !== 'confirmed') failures.push(`settlement leg is not confirmed: ${leg.status}`)
    if (leg && leg.memo !== prepared.referenceId) {
      failures.push(`memo does not bind the order: memo=${leg.memo} reference=${prepared.referenceId}`)
    }
    if (leg && !amountsEqual(leg.amount, expectedAmount, STELLAR_DECIMALS)) {
      failures.push(`amount mismatch: leg=${leg.amount} expected=${expectedAmount}`)
    }
    if (leg && leg.ledgerSeq === null) failures.push('ledger sequence is missing')

    // ── Network-independent originals: raw signed XDR + full Horizon JSON.
    let xdrFile: string | null = null
    let horizonFile: string | null = null
    let ledgerCreatedAt: string | null = null

    if (leg) {
      xdrFile = run.writeText(`tx/${prepared.referenceId}.xdr`, `${leg.signedXdr}\n`)

      // Re-fetch from Horizon: the tx resource for ledger/timestamp/memo/source,
      // and the operations for destination + amount (the tx resource has neither).
      let horizonTx: Record<string, unknown> | null = null
      let horizonOps: unknown[] = []
      try {
        horizonTx = await fetchJson(`${HORIZON_URL}/transactions/${leg.txHash}`)
        horizonOps = await transactionOperations(HORIZON_URL, leg.txHash)
      } catch (err) {
        failures.push(`could not re-read the transaction from Horizon: ${err instanceof Error ? err.message : String(err)}`)
      }
      ledgerCreatedAt = horizonTx ? String(horizonTx['created_at'] ?? '') : null

      if (horizonTx && horizonTx['memo'] !== prepared.referenceId) {
        failures.push(`memo on the ledger does not match the reference ID: ${String(horizonTx['memo'])}`)
      }
      if (horizonTx && horizonTx['successful'] !== true) {
        failures.push('Horizon reports the transaction as not successful')
      }

      horizonFile = run.writeJson(`tx/${prepared.referenceId}.horizon.json`, {
        note:
          'Network-independent original of one settlement leg. The Stellar Testnet reset on 2026-12-16 wipes Horizon history and kills every Stellar Expert link; this file, together with the .xdr file next to it, is the evidence that survives.',
        capturedAt: new Date().toISOString(),
        runId: run.id,
        referenceId: prepared.referenceId,
        txHash: leg.txHash,
        stellarExpertUrl: stellarExpertTxUrl(leg.txHash),
        network: { name: 'stellar-testnet', passphrase: NETWORK_PASSPHRASE, horizon: HORIZON_URL },
        asset: { code: ASSET_CODE, issuer: ASSET_ISSUER },
        corridor: {
          usdSideTreasury: TREASURY_PUBLIC,
          phpSidePayoutFloat: PAYOUT_PUBLIC,
        },
        order: {
          referenceId: prepared.referenceId,
          status: order.status,
          usdAmount: order.usdAmount,
          feeUsd: order.feeUsd,
          phpEstimate: order.phpEstimate,
          fxRate: order.fxRate,
        },
        databaseLeg: {
          txHash: leg.txHash,
          status: leg.status,
          memo: leg.memo,
          sourceAccount: leg.sourceAccount,
          destinationAccount: leg.destinationAccount,
          assetCode: leg.assetCode,
          assetIssuer: leg.assetIssuer,
          amount: leg.amount,
          ledgerSeq: leg.ledgerSeq,
          submittedAt: leg.submittedAt.toISOString(),
          confirmedAt: leg.confirmedAt?.toISOString() ?? null,
          signedXdr: leg.signedXdr,
        },
        horizonResponseAtConfirm: leg.horizonResponse,
        horizonTransactionRefetched: horizonTx,
        horizonOperations: horizonOps,
      })
    }

    const checks = {
      realTxOnTestnet: leg !== null && leg.ledgerSeq !== null && leg.status === 'confirmed',
      memoBindsOrder: leg !== null && leg.memo === prepared.referenceId,
      amountCorrect: leg !== null && amountsEqual(leg.amount, expectedAmount, STELLAR_DECIMALS),
      ledgerConfirmed: order.status === 'settled',
      originalsSaved: xdrFile !== null && horizonFile !== null,
    }

    positives.push({
      index,
      referenceId: prepared.referenceId,
      orderId: prepared.orderId,
      usdAmount: order.usdAmount,
      expectedSettlementAmount: expectedAmount,
      orderStatus: order.status,
      outcomeKind: outcome?.kind ?? 'none',
      outcomeReason: outcome?.reason ?? 'the worker did not pick up the order',
      leg,
      ledgerCreatedAt,
      depositConfirmedAt: null,
      bindSeconds: null,
      ledgerSeconds: null,
      xdrFile,
      horizonFile,
      checks,
      failures,
      pass: failures.length === 0 && Object.values(checks).every(Boolean),
    })

    run.log('d2.positive_done', {
      case: index,
      referenceId: prepared.referenceId,
      txHash: leg?.txHash ?? null,
      ledgerSeq: leg?.ledgerSeq ?? null,
      amount: leg?.amount ?? null,
      memo: leg?.memo ?? null,
      outcome: outcome ? `${outcome.kind}:${outcome.reason}` : 'none',
      pass: failures.length === 0,
    })
  }

  const payoutAfterPositives = await assetBalanceOf(HORIZON_URL, PAYOUT_PUBLIC, ASSET_CODE, ASSET_ISSUER)
  const treasuryAfterPositives = await assetBalanceOf(HORIZON_URL, TREASURY_PUBLIC, ASSET_CODE, ASSET_ISSUER)

  // ── 2. NEGATIVE GROUP — must be rejected, producing NO tx at all.
  const settlementRowsBeforeNegatives = (await db.select({ n: count() }).from(settlements))[0]?.n ?? 0

  const fixture = await prepareOrder(run, MISMATCH_FIXTURE, 'negative-fixture')
  run.log('d2.negative_fixture_ready', {
    note: 'helper order, only there to provide an unused deposit reference. Not one of the 5 cases.',
    referenceId: fixture.referenceId,
    depositReference: fixture.depositReference,
  })

  const negatives: NegativeResult[] = []
  for (const [i, testCase] of NEGATIVES.entries()) {
    const index = i + 1
    const prepared = await prepareOrder(run, testCase, `negative-${index}`)

    // Pick the WRONG input for each kind of case.
    const submission = ((): { reference: string; amount: string } => {
      switch (testCase.kind) {
        case 'duplicate_reference':
          // A deposit reference a positive order has already CONSUMED — one
          // deposit must not bind to two orders.
          return { reference: consumedDepositReferences[i], amount: testCase.usdAmount }
        case 'mismatched_amount':
          // The order's own reference, but the wrong amount.
          return { reference: prepared.depositReference, amount: String(Number(testCase.usdAmount) + 5) }
        case 'mismatched_order':
          // A real, unconsumed reference, but it belongs to a different order.
          return { reference: fixture.depositReference, amount: testCase.usdAmount }
      }
    })()
    const submittedReference = submission.reference
    const submittedAmount = submission.amount

    let caught: unknown = null
    try {
      await confirmDeposit(
        prepared.orderId,
        { depositReference: submittedReference, usdAmount: submittedAmount },
        ACTOR,
      )
    } catch (err) {
      caught = err
    }

    const order = await getOrder(prepared.orderId)
    const legs = await settlementsRepo.listByOrderId(db, prepared.orderId)
    const events = await db
      .select({
        fromStatus: orderEvents.fromStatus,
        toStatus: orderEvents.toStatus,
        actor: orderEvents.actor,
        createdAt: orderEvents.createdAt,
      })
      .from(orderEvents)
      .where(inArray(orderEvents.orderId, [prepared.orderId]))

    const rejectEvent = events.find((e) => e.toStatus === 'rejected') ?? null
    const domainError = caught instanceof DomainError ? caught : null

    const failures: string[] = []
    if (caught === null) failures.push('the deposit was ACCEPTED — this negative case should have been rejected')
    if (domainError === null && caught !== null) {
      failures.push(`rejected with an unexpected error type: ${caught instanceof Error ? caught.name : typeof caught}`)
    }
    if (domainError && domainError.rejectReason !== testCase.expectedRejectReason) {
      failures.push(`wrong reject reason: ${domainError.rejectReason}, expected ${testCase.expectedRejectReason}`)
    }
    if (order.status !== 'rejected') failures.push(`order is not in the rejected state: ${order.status}`)
    if (order.rejectReason !== testCase.expectedRejectReason) {
      failures.push(`stored reject reason is ${order.rejectReason ?? 'null'}, expected ${testCase.expectedRejectReason}`)
    }
    if (legs.length !== 0) failures.push(`${legs.length} settlement leg(s) WERE created — a rejected case must produce none`)
    if (rejectEvent === null) failures.push('no event-log row recording the move to rejected')

    const result: NegativeResult = {
      index,
      kind: testCase.kind,
      label: testCase.label,
      referenceId: prepared.referenceId,
      orderId: prepared.orderId,
      submittedDepositReference: submittedReference,
      submittedUsdAmount: submittedAmount,
      expectedRejectReason: testCase.expectedRejectReason,
      errorName: caught instanceof Error ? caught.name : null,
      errorMessage: caught instanceof Error ? caught.message : null,
      actualRejectReason: order.rejectReason,
      finalStatus: order.status,
      settlementLegs: legs.length,
      rejectEventRecorded: rejectEvent !== null,
      failures,
      pass: failures.length === 0,
    }
    negatives.push(result)

    run.log('d2.negative_rejected', {
      case: index,
      kind: testCase.kind,
      referenceId: prepared.referenceId,
      submittedDepositReference: submittedReference,
      submittedUsdAmount: submittedAmount,
      errorName: result.errorName,
      errorMessage: result.errorMessage,
      rejectReason: result.actualRejectReason,
      finalStatus: result.finalStatus,
      settlementLegsCreated: result.settlementLegs,
      pass: result.pass,
    })
  }

  const settlementRowsAfterNegatives = (await db.select({ n: count() }).from(settlements))[0]?.n ?? 0
  const payoutAfterNegatives = await assetBalanceOf(HORIZON_URL, PAYOUT_PUBLIC, ASSET_CODE, ASSET_ISSUER)

  // ── 3. Observed metric: deposit confirm → settlement bind.
  const orderRows = await ordersRepo.listForEvidence(db, 500)
  const depositConfirmedByRef = new Map(
    orderRows.map((r) => [r.referenceId, r.depositConfirmedAt] as const),
  )
  for (const p of positives) {
    p.depositConfirmedAt = depositConfirmedByRef.get(p.referenceId) ?? null
    p.bindSeconds = secondsBetween(p.depositConfirmedAt, p.leg?.submittedAt ?? null)
    p.ledgerSeconds = secondsBetween(p.depositConfirmedAt, p.leg?.confirmedAt ?? null)
  }
  const avgBind = average(positives.map((p) => p.bindSeconds))
  const avgLedger = average(positives.map((p) => p.ledgerSeconds))

  // ── 4. Reconcile the ledger balances against the DB.
  const settledAmounts = positives.map((p) => p.leg?.amount ?? '0').filter((a) => a !== '0')
  const totalSettled = sumAmounts(settledAmounts)
  const payoutDeltaPositives = subtractAmounts(payoutAfterPositives, payoutOpening)
  const treasuryDeltaPositives = subtractAmounts(treasuryAfterPositives, treasuryOpening)
  const payoutDeltaNegatives = subtractAmounts(payoutAfterNegatives, payoutAfterPositives)
  // Money into the payout float must equal EXACTLY the sum of the legs in the
  // database, and money out of the treasury must equal that same figure. Stellar
  // fees are paid in XLM, so there is no fee residue here.
  const payoutMatchesDatabase = amountsEqual(payoutDeltaPositives, totalSettled, STELLAR_DECIMALS)
  const treasuryMatchesDatabase = amountsEqual(
    subtractAmounts(treasuryOpening, treasuryAfterPositives),
    totalSettled,
    STELLAR_DECIMALS,
  )

  /**
   * ABSOLUTE BALANCE RECONCILIATION — one step stronger than a delta.
   *
   * This corridor was rotated onto a fresh set of accounts and the payout float
   * started at EXACTLY 0 USDC (no prior payment history at all). Which means the
   * reviewer need not trust any "before/after" figure the script supplies: just
   * open Stellar Expert, read the payout float's current balance, and compare it
   * with the total of the amount column in the results table.
   *
   * Compared against EVERY confirmed leg in the DB belonging to this corridor
   * (by destination + asset issuer), not just this run's 10 legs — so the
   * reconciliation still holds on the second run, and the third, and is not
   * thrown off by the 23 legs of the old corridor still sitting in the DB.
   */
  const corridorLegs = await db
    .select({ amount: settlements.amount })
    .from(settlements)
    .where(
      and(
        eq(settlements.status, 'confirmed'),
        eq(settlements.destinationAccount, PAYOUT_PUBLIC),
        eq(settlements.assetIssuer, ASSET_ISSUER),
      ),
    )
  const corridorTotalInDatabase = sumAmounts(corridorLegs.map((r) => r.amount))
  const payoutOpeningWasZero = amountsEqual(payoutOpening, '0', STELLAR_DECIMALS)
  const payoutAbsoluteMatchesDatabase = amountsEqual(
    payoutAfterNegatives,
    corridorTotalInDatabase,
    STELLAR_DECIMALS,
  )


  /**
   * A matching balance is not enough. What this report claims is that "the payout
   * float has never received anything else", so EVERY credit operation on the
   * ledger has to be matched against every leg in the DB — both the count and
   * the total.
   *
   * This is exactly the check that caught the last contamination: a production
   * test order settled 42.0750000 USDC into the very payout float being used as
   * evidence. The totals showed a discrepancy; counting operations showed
   * immediately what had caused it.
   */
  const payoutHistory = await incomingPaymentHistory(HORIZON_URL, PAYOUT_PUBLIC, ASSET_CODE, ASSET_ISSUER)
  const ledgerHistoryMatchesDatabase =
    payoutHistory.count === corridorLegs.length &&
    amountsEqual(payoutHistory.total, corridorTotalInDatabase, STELLAR_DECIMALS)
  const unexplainedInflow = subtractAmounts(payoutHistory.total, corridorTotalInDatabase)

  const reconciled =
    payoutMatchesDatabase &&
    treasuryMatchesDatabase &&
    payoutAbsoluteMatchesDatabase &&
    ledgerHistoryMatchesDatabase

  /**
   * DOES THE README'S ONE-STEP CHECK ACTUALLY HOLD FOR THIS RUN?
   *
   * The README tells the reviewer they can verify the whole set in one step:
   * open the payout float on a block explorer, read its balance, and compare it
   * with the total of the table in THIS report. That promise holds only while
   * the payout float's entire credit history IS this run's ten legs — nothing
   * before, nothing beside.
   *
   * Which makes an evidence corridor SINGLE-USE PER HANDOVER. Re-running on a
   * corridor that already carries a previous run keeps every internal check
   * green — the balance still equals the database total, every credit is still
   * accounted for — while quietly falsifying the README: the explorer shows 20
   * credits and twice the money, and the table shows 10.
   *
   * That is exactly what happened once: a re-run on a used corridor produced a
   * PASS whose headline claim was false, and nothing in the output said so.
   * A check that detects a problem and still reports success is not a check, so
   * this one is wired into the exit code and into the document itself.
   */
  const oneStepCheckHolds = checkOneStepHolds({
    payoutOpeningBalance: payoutOpening,
    incomingPaymentCount: payoutHistory.count,
    incomingPaymentTotal: payoutHistory.total,
    legsInThisRun: positives.length,
    totalSettledInThisRun: totalSettled,
  })
  const negativesMovedNothing =
    amountsEqual(payoutDeltaNegatives, '0', STELLAR_DECIMALS) &&
    settlementRowsAfterNegatives === settlementRowsBeforeNegatives

  const positivePassed = positives.filter((p) => p.pass).length
  const negativePassed = negatives.filter((n) => n.pass).length
  const overall =
    positivePassed === POSITIVE_TARGET &&
    negativePassed === NEGATIVE_TARGET &&
    reconciled &&
    negativesMovedNothing
  /** Fit to hand to a reviewer: every check green AND the README's promise true. */
  const handoverReady = overall && oneStepCheckHolds

  run.log('d2.reconciliation', {
    payoutOpening,
    payoutAfterPositives,
    payoutAfterNegatives,
    treasuryOpening,
    treasuryAfterPositives,
    totalSettledFromDatabase: totalSettled,
    payoutDeltaPositives,
    treasuryDeltaPositives,
    payoutDeltaNegatives,
    corridorTotalInDatabase,
    corridorLegsInDatabase: corridorLegs.length,
    payoutOpeningWasZero,
    payoutAbsoluteMatchesDatabase,
    payoutIncomingPaymentCount: payoutHistory.count,
    payoutIncomingPaymentTotal: payoutHistory.total,
    payoutOtherOperationTypes: payoutHistory.otherOperationTypes,
    ledgerHistoryMatchesDatabase,
    unexplainedInflow,
    oneStepCheckHolds,
    handoverReady,
    payoutMatchesDatabase,
    treasuryMatchesDatabase,
    reconciled,
    negativesMovedNothing,
    settlementRowsAtStart,
    settlementRowsBeforeNegatives,
    settlementRowsAfterNegatives,
  })

  // ── 5. Tables.
  const positiveCols: readonly Column<PositiveResult>[] = [
    { header: '#', get: (r) => r.index },
    { header: 'Reference ID', get: (r) => r.referenceId },
    { header: 'Memo on ledger', get: (r) => r.leg?.memo ?? null },
    { header: 'Memo = Reference ID', get: (r) => r.checks.memoBindsOrder },
    { header: 'USD ordered', get: (r) => r.usdAmount },
    { header: `${ASSET_CODE} settled`, get: (r) => r.leg?.amount ?? null },
    { header: 'Ledger seq', get: (r) => r.leg?.ledgerSeq ?? null },
    { header: 'Ledger time (UTC)', get: (r) => fmtUtc(r.ledgerCreatedAt) },
    { header: 'Tx hash', get: (r) => (r.leg ? shortHash(r.leg.txHash) : null) },
    { header: 'Stellar Expert', get: (r) => (r.leg ? `[open](${stellarExpertTxUrl(r.leg.txHash)})` : null) },
    { header: 'Order status', get: (r) => r.orderStatus },
    { header: 'Result', get: (r) => (r.pass ? YES : NO) },
  ]

  const originalsCols: readonly Column<PositiveResult>[] = [
    { header: '#', get: (r) => r.index },
    { header: 'Reference ID', get: (r) => r.referenceId },
    { header: 'Full transaction hash', get: (r) => (r.leg ? `\`${r.leg.txHash}\`` : null) },
    { header: 'Raw signed XDR', get: (r) => (r.xdrFile ? `\`${r.xdrFile.split('/').slice(-2).join('/')}\`` : null) },
    { header: 'Horizon JSON', get: (r) => (r.horizonFile ? `\`${r.horizonFile.split('/').slice(-2).join('/')}\`` : null) },
  ]

  const negativeCols: readonly Column<NegativeResult>[] = [
    { header: '#', get: (r) => r.index },
    { header: 'Group', get: (r) => (r.kind === 'duplicate_reference' ? 'duplicate reference' : 'mismatched amount/order') },
    { header: 'What was submitted', get: (r) => r.label },
    { header: 'Order reference', get: (r) => r.referenceId },
    { header: 'Final status', get: (r) => r.finalStatus },
    { header: 'Reject reason', get: (r) => r.actualRejectReason },
    { header: 'Settlement tx created', get: (r) => r.settlementLegs },
    { header: 'Reject logged', get: (r) => r.rejectEventRecorded },
    { header: 'Result', get: (r) => (r.pass ? YES : NO) },
  ]

  const metricRows = positives.map((p) => ({
    referenceId: p.referenceId,
    depositConfirmedAt: p.depositConfirmedAt,
    submittedAt: p.leg?.submittedAt ?? null,
    confirmedAt: p.leg?.confirmedAt ?? null,
    bindSeconds: p.bindSeconds,
    ledgerSeconds: p.ledgerSeconds,
  }))
  const metricCols: readonly Column<(typeof metricRows)[number]>[] = [
    { header: 'Reference ID', get: (r) => r.referenceId },
    { header: 'Deposit reference confirmed (UTC)', get: (r) => fmtUtc(r.depositConfirmedAt) },
    { header: 'Settlement bound / submitted (UTC)', get: (r) => fmtUtc(r.submittedAt) },
    { header: 'Ledger confirmed (UTC)', get: (r) => fmtUtc(r.confirmedAt) },
    { header: 'Deposit confirm → settlement bind (s)', get: (r) => r.bindSeconds },
    { header: 'Deposit confirm → ledger confirmed (s)', get: (r) => r.ledgerSeconds },
  ]

  const positiveCsvCols: readonly Column<PositiveResult>[] = [
    { header: '#', get: (r) => r.index },
    { header: 'Reference ID', get: (r) => r.referenceId },
    { header: 'Order status', get: (r) => r.orderStatus },
    { header: 'USD ordered', get: (r) => r.usdAmount },
    { header: 'Expected settlement amount', get: (r) => r.expectedSettlementAmount },
    { header: 'Settled amount', get: (r) => r.leg?.amount ?? null },
    { header: 'Asset code', get: (r) => r.leg?.assetCode ?? null },
    { header: 'Asset issuer', get: (r) => r.leg?.assetIssuer ?? null },
    { header: 'Source (USD-side treasury)', get: (r) => r.leg?.sourceAccount ?? null },
    { header: 'Destination (PHP-side payout float)', get: (r) => r.leg?.destinationAccount ?? null },
    { header: 'Memo on ledger', get: (r) => r.leg?.memo ?? null },
    { header: 'Transaction hash', get: (r) => r.leg?.txHash ?? null },
    { header: 'Ledger sequence', get: (r) => r.leg?.ledgerSeq ?? null },
    { header: 'Ledger time (UTC)', get: (r) => fmtUtc(r.ledgerCreatedAt) },
    { header: 'Stellar Expert URL', get: (r) => (r.leg ? stellarExpertTxUrl(r.leg.txHash) : null) },
    { header: 'Signed XDR file', get: (r) => r.xdrFile },
    { header: 'Horizon JSON file', get: (r) => r.horizonFile },
    { header: 'Deposit confirmed (UTC)', get: (r) => fmtUtc(r.depositConfirmedAt) },
    { header: 'Settlement submitted (UTC)', get: (r) => fmtUtc(r.leg?.submittedAt ?? null) },
    { header: 'Settlement confirmed (UTC)', get: (r) => fmtUtc(r.leg?.confirmedAt ?? null) },
    { header: 'Deposit confirm to settlement bind (s)', get: (r) => r.bindSeconds },
    { header: 'Deposit confirm to ledger confirm (s)', get: (r) => r.ledgerSeconds },
    { header: 'Worker outcome', get: (r) => `${r.outcomeKind}:${r.outcomeReason}` },
    { header: 'Check real tx on testnet', get: (r) => r.checks.realTxOnTestnet },
    { header: 'Check memo binds order', get: (r) => r.checks.memoBindsOrder },
    { header: 'Check amount correct', get: (r) => r.checks.amountCorrect },
    { header: 'Check order settled by ledger', get: (r) => r.checks.ledgerConfirmed },
    { header: 'Check originals saved locally', get: (r) => r.checks.originalsSaved },
    { header: 'Result', get: (r) => (r.pass ? YES : NO) },
    { header: 'Notes', get: (r) => r.failures.join('; ') },
  ]

  const negativeCsvCols: readonly Column<NegativeResult>[] = [
    { header: '#', get: (r) => r.index },
    { header: 'Group', get: (r) => r.kind },
    { header: 'What was submitted', get: (r) => r.label },
    { header: 'Order reference', get: (r) => r.referenceId },
    { header: 'Deposit reference submitted', get: (r) => r.submittedDepositReference },
    { header: 'USD amount submitted', get: (r) => r.submittedUsdAmount },
    { header: 'Expected reject reason', get: (r) => r.expectedRejectReason },
    { header: 'Actual reject reason', get: (r) => r.actualRejectReason },
    { header: 'Error class', get: (r) => r.errorName },
    { header: 'Error message', get: (r) => r.errorMessage },
    { header: 'Final status', get: (r) => r.finalStatus },
    { header: 'Settlement legs created', get: (r) => r.settlementLegs },
    { header: 'Reject event recorded', get: (r) => r.rejectEventRecorded },
    { header: 'Result', get: (r) => (r.pass ? YES : NO) },
    { header: 'Notes', get: (r) => r.failures.join('; ') },
  ]

  const finishedAt = new Date()
  const headline =
    `positive ${positivePassed}/${POSITIVE_TARGET} · negative ${negativePassed}/${NEGATIVE_TARGET} · ledger reconciliation ${reconciled ? 'exact' : 'MISMATCH'}` +
    (oneStepCheckHolds ? '' : ' · **CORRIDOR REUSED — not fit for handover**')

  /**
   * The document must carry the warning too. The console scrolls away; the
   * published summary is what a reviewer actually reads, and it must never
   * claim a one-step check that does not hold for the run that produced it.
   */
  const staleCorridorBanner: string[] = oneStepCheckHolds
    ? []
    : [
        '> ## :warning: This run is NOT fit for handover',
        '>',
        '> The payout float used here **already carried settlements from an earlier',
        `> run** before this one started (opening balance \`${payoutOpening}\`, and`,
        `> ${payoutHistory.count} credits in its history against the ${positives.length} legs in the table below).`,
        '>',
        '> Every internal check below is still green and every transaction in this',
        "> report is real. What does *not* hold is the README's one-step check: a",
        "> reviewer opening the payout float on a block explorer will read",
        `> \`${payoutAfterNegatives}\` across ${payoutHistory.count} payments, not the \`${totalSettled}\` across`,
        `> ${positives.length} payments that this report shows, and the difference is the earlier run.`,
        '>',
        '> **An evidence corridor is single-use per handover.** Run',
        '> `pnpm stellar:bootstrap` to create a fresh corridor, point `.env` at it,',
        '> and run `pnpm evidence:d2` again before handing anything over.',
        '',
        '---',
        '',
      ]

  const reconciliationIntro: string[] = oneStepCheckHolds
    ? [
        'This corridor was created fresh, and the payout float started at **exactly',
        `zero ${ASSET_CODE}** with no payment history at all. That makes the strongest form`,
        'of reconciliation available: **the balance you can read off the public block',
        'explorer right now must equal the sum of the amounts in the table above.** You do',
        'not have to trust any "before" or "after" figure supplied by us.',
      ]
    : [
        'Every figure below is internally consistent, but read the warning at the top of',
        'this document first: **this payout float was already in use before this run**, so',
        'its balance covers more settlements than the table above lists. The reconciliation',
        'here is against everything recorded for the corridor, which still holds — but the',
        "README's one-step check, which compares the explorer balance against *this* table,",
        'does not.',
      ]

  const oneStepSection: string[] = oneStepCheckHolds
    ? [
        '### How to check this yourself in one step',
        '',
        `Open the payout float on the block explorer — [\`${PAYOUT_PUBLIC}\`](${stellarExpertAccountUrl(PAYOUT_PUBLIC)}) —`,
        `read its ${ASSET_CODE} balance, and compare it with \`${corridorTotalInDatabase}\` above.`,
        'The account has received nothing else, ever, so the two numbers can only agree if',
        'the settlements in this report are exactly the transactions that happened.',
      ]
    : [
        '### The one-step check does not apply to this run',
        '',
        `The payout float [\`${PAYOUT_PUBLIC}\`](${stellarExpertAccountUrl(PAYOUT_PUBLIC)}) holds`,
        `\`${payoutAfterNegatives}\` across ${payoutHistory.count} credits, because it was reused across runs.`,
        `Only \`${totalSettled}\` of that, across ${positives.length} credits, belongs to the settlements in`,
        'this report; the rest belongs to an earlier run of the same scripts.',
        '',
        'Verify individual transactions row by row instead (the memo check above still',
        'holds for every one of them), and generate a handover pack on a fresh corridor.',
      ]

  const doc = [
    '# D2 — Settlement on Stellar Testnet',
    '',
    ...staleCorridorBanner,
    `**Positive group: ${positivePassed}/${POSITIVE_TARGET} real USDC transactions confirmed on the ledger.**  `,
    `**Negative group: ${negativePassed}/${NEGATIVE_TARGET} attempts correctly rejected, transactions produced: 0.**`,
    '',
    `- Run ID: \`${run.id}\``,
    `- Started / finished (UTC): ${fmtUtc(run.startedAt)} → ${fmtUtc(finishedAt)}`,
    `- Network: Stellar **Testnet** · Horizon \`${HORIZON_URL}\``,
    `- Asset: \`${ASSET_CODE}\`, issuer \`${ASSET_ISSUER}\``,
    `- USD-side treasury (money leaves here): [\`${TREASURY_PUBLIC}\`](${stellarExpertAccountUrl(TREASURY_PUBLIC)})`,
    `- PHP-side payout float (money arrives here): [\`${PAYOUT_PUBLIC}\`](${stellarExpertAccountUrl(PAYOUT_PUBLIC)})`,
    '- This document contains **only** the orders created by this run. Older orders',
    '  in the database (smoke tests and earlier runs) were filtered out, not deleted.',
    '',
    '> **The two numbers must not be added together.** A negative case is rejected',
    '> *before* any transaction is built, so it cannot have a transaction hash and',
    '> is not part of the positive group’s 10/10. The original SOW merged the two',
    '> counts and contradicted itself; this report keeps them apart.',
    '',
    '---',
    '',
    '## POSITIVE group — 10 real USDC transactions',
    '',
    'Passes when: a real USDC transaction exists on Testnet, its hash is bound to',
    'the right order (the memo on the ledger equals the order reference ID), and a',
    'Stellar Expert link is available.',
    '',
    mdTable(positiveCols, positives),
    '',
    '**`Memo = Reference ID` is the most important column in this deliverable.** The',
    'memo lives on the public ledger, not in the builder’s database. It is the point',
    'at which a transaction proves for itself which order it belongs to.',
    '',
    `The \`${ASSET_CODE} settled\` figure is the USD amount **after** the 1% fee is`,
    'deducted — the part that is actually converted to PHP — not the gross amount.',
    '',
    '### Local originals (these survive the testnet reset on 2026-12-16)',
    '',
    mdTable(originalsCols, positives),
    '',
    'Paths are relative to this run folder. After **16 December 2026** the Stellar',
    'Testnet is reset: Horizon history is wiped and every Stellar Expert link above',
    'returns 404. The two files kept here per transaction are the originals that do',
    'not depend on the network — the raw signed XDR (the exact signed bytes, which',
    'hash back to the transaction hash in the table) and the full Horizon JSON',
    'captured at confirmation time (ledger sequence, timestamp, memo,',
    'source/destination, amount).',
    '',
    'To re-check them with no network and no database:',
    '',
    '```',
    'npx tsx scripts/verify-evidence.ts',
    '```',
    '',
    '---',
    '',
    '## NEGATIVE group — 5 attempts that must be rejected',
    '',
    '3 duplicate deposit references + 2 mismatched amount / mismatched order.',
    '',
    'Passes when: the order is **rejected**, **no transaction is produced**, and the',
    'rejection is logged.',
    '',
    mdTable(negativeCols, negatives),
    '',
    `- Settlement legs produced by these 5 cases: **${settlementRowsAfterNegatives - settlementRowsBeforeNegatives}**.`,
    `- Payout float ${ASSET_CODE} balance before and after the negative group: \`${payoutAfterPositives}\` → \`${payoutAfterNegatives}\` (change: \`${payoutDeltaNegatives}\`).`,
    '- The per-case log is in `run.log.jsonl` under the event `d2.negative_rejected`,',
    '  including the exact string that was submitted and the error the system returned.',
    '',
    'One helper order was created separately so that an **unused** deposit reference',
    `existed for the "mismatched order" case (\`${fixture.referenceId}\`). It is not one`,
    'of the 5 cases and it produced no transaction.',
    '',
    '---',
    '',
    '## Reconciling the ledger against the database',
    '',
    ...reconciliationIntro,
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Payout float balance when this corridor was created | \`${payoutOpening}\`${payoutOpeningWasZero ? ' — exactly zero' : ' — **not zero, see note below**'} |`,
    `| Total ${ASSET_CODE} across the 10 positive legs of this run (per the database) | \`${totalSettled}\` |`,
    `| Total ${ASSET_CODE} across **every** confirmed leg recorded for this corridor (per the database) | \`${corridorTotalInDatabase}\` (${corridorLegs.length} legs) |`,
    `| **Payout float balance on the ledger right now** | **\`${payoutAfterNegatives}\`** |`,
    `| **Absolute balance matches the database?** | **${payoutAbsoluteMatchesDatabase ? 'EXACT MATCH' : 'MISMATCH — see note below'}** |`,
    `| Incoming ${ASSET_CODE} payments in the payout float's entire ledger history | **${payoutHistory.count}** payments, totalling \`${payoutHistory.total}\` |`,
    `| Confirmed legs for this corridor in the database | **${corridorLegs.length}** legs, totalling \`${corridorTotalInDatabase}\` |`,
    `| **Every credit on the ledger accounted for by the database?** | **${ledgerHistoryMatchesDatabase ? 'YES — payment for payment, no unexplained inflow' : `NO — unexplained inflow of \`${unexplainedInflow}\``}** |`,
    `| Other operations in the payout float's history | ${payoutHistory.otherOperationTypes.length > 0 ? payoutHistory.otherOperationTypes.map((t) => `\`${t}\``).join(', ') : 'none'} |`,
    '',
    '### Second, independent check: the change in balance',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Payout float before the 10 positive legs | \`${payoutOpening}\` |`,
    `| Payout float after the 10 positive legs | \`${payoutAfterPositives}\` |`,
    `| Change on the ledger | \`${payoutDeltaPositives}\` |`,
    `| Money **in** matches the database? | **${payoutMatchesDatabase ? 'EXACT MATCH' : 'MISMATCH'}** |`,
    `| Treasury balance before / after | \`${treasuryOpening}\` → \`${treasuryAfterPositives}\` (change \`${treasuryDeltaPositives}\`) |`,
    `| Money **out** matches the database? | **${treasuryMatchesDatabase ? 'EXACT MATCH' : 'MISMATCH'}** |`,
    `| Change during the negative group | \`${payoutDeltaNegatives}\` |`,
    '',
    'The treasury loses exactly what the payout float gains, which is also the point',
    'made in section 5 of the README: these are two accounts in two different roles,',
    'not one account paying itself.',
    '',
    'Stellar network fees are paid in XLM, not in USDC, so every figure above matches',
    'exactly to 7 decimal places with no fee residue.',
    '',
    'The absolute comparison is made against **every** confirmed leg recorded for this',
    'corridor, not only the ten in this run, so it stays correct if the evidence',
    'scripts are run again. Legs belonging to earlier, retired corridors are still in',
    'the database and are excluded by destination account and asset issuer — they are',
    'filtered out, not deleted.',
    '',
    'The balance is checked **payment by payment**, not just as a total. The script',
    "reads the payout float's entire incoming payment history from the ledger and",
    'requires the number of credits and their sum to equal the legs recorded in the',
    'database. A matching total alone would not be enough: a single stray payment from',
    'somewhere else would break the claim that this account received nothing but the',
    'settlements in this report, and only an operation-by-operation comparison catches',
    'that. This check is the reason the previous corridor was retired — see',
    'limitation 6 in the README.',
    '',
    ...oneStepSection,
    '',
    '---',
    '',
    '## Observed metric — NOT a pass/fail condition',
    '',
    `- **Average time from confirming the deposit reference to binding the settlement: ${avgBind ?? '—'} seconds.**`,
    `- Average time through to ledger confirmation (settled): ${avgLedger ?? '—'} seconds.`,
    '',
    'Both figures are **observational**: they are recorded for monitoring and are',
    '**not** pass/fail conditions for D2. They depend on the Stellar Testnet ledger',
    'close interval (roughly 5 seconds) and on the worker poll interval, and say',
    'nothing about the quality of the evidence.',
    '',
    '"Binding the settlement" is the moment the transaction hash is written to the',
    'database and attached to the order. It happens *before* the transaction is sent',
    'to the network — that ordering is the double-spend protection, not an accident.',
    '',
    mdTable(metricCols, metricRows),
    '',
    '---',
    '',
    '## Verify one settlement yourself, in 5 minutes',
    '',
    '1. Pick any row in the positive table above — row 1 will do.',
    '2. Note the `Reference ID` in that row.',
    '3. Click the `Stellar Expert` link in the same row (or paste the full',
    '   transaction hash into `https://stellar.expert/explorer/testnet/tx/<hash>`).',
    '4. On that page find the **Memo** field. It must be exactly the `Reference ID`',
    '   from step 2.',
    '5. Optionally cross-check the amount and the destination against the',
    `   \`${ASSET_CODE} settled\` column and the payout float \`${PAYOUT_PUBLIC}\`.`,
    '6. For the whole set at once: open the payout float account on the explorer and',
    `   check that its ${ASSET_CODE} balance equals \`${corridorTotalInDatabase}\` — the total of the`,
    '   amount column. The account started at zero and has received nothing else.',
    '',
    'The memo is on the public ledger, not in the builder’s database — which is why',
    'step 4 requires no trust in us. If the memo matches, that transaction belongs to',
    'that order.',
    '',
    '## Files in this folder',
    '',
    '| File | Contents |',
    '| --- | --- |',
    '| `d2-summary.md` | This document |',
    '| `d2-positive.csv` | The positive group, every column |',
    '| `d2-negative.csv` | The negative group, every column |',
    '| `d2-metrics.csv` | Per-leg timings |',
    '| `tx/<reference>.xdr` | Raw signed XDR of each transaction |',
    '| `tx/<reference>.horizon.json` | Full Horizon JSON plus the database record |',
    '| `run.json` | Machine-readable record of this run |',
    '| `run.log.jsonl` | Step-by-step log, one JSON object per event |',
    '',
    'None of these files contains an order access token or a wallet secret key: the',
    'script scans every byte before writing and aborts if it finds one.',
    '',
  ].join('\n')

  run.writeText('d2-summary.md', doc)
  run.writeCsv('d2-positive.csv', positiveCsvCols, positives)
  run.writeCsv('d2-negative.csv', negativeCsvCols, negatives)
  run.writeCsv('d2-metrics.csv', metricCols, metricRows)

  const manifest: RunManifest = {
    deliverable: 'd2',
    runId: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    headline,
    pass: handoverReady,
    network: { name: 'stellar-testnet', passphrase: NETWORK_PASSPHRASE, horizon: HORIZON_URL },
    asset: { code: ASSET_CODE, issuer: ASSET_ISSUER },
    corridor: { usdSideTreasury: TREASURY_PUBLIC, phpSidePayoutFloat: PAYOUT_PUBLIC },
    positive: {
      target: POSITIVE_TARGET,
      passed: positivePassed,
      cases: positives.map((p) => ({
        index: p.index,
        referenceId: p.referenceId,
        orderStatus: p.orderStatus,
        usdAmount: p.usdAmount,
        settledAmount: p.leg?.amount ?? null,
        expectedSettlementAmount: p.expectedSettlementAmount,
        memo: p.leg?.memo ?? null,
        txHash: p.leg?.txHash ?? null,
        ledgerSeq: p.leg?.ledgerSeq ?? null,
        ledgerTime: p.ledgerCreatedAt,
        stellarExpertUrl: p.leg ? stellarExpertTxUrl(p.leg.txHash) : null,
        signedXdrFile: p.xdrFile,
        horizonJsonFile: p.horizonFile,
        depositConfirmedAt: p.depositConfirmedAt?.toISOString() ?? null,
        settlementSubmittedAt: p.leg?.submittedAt.toISOString() ?? null,
        settlementConfirmedAt: p.leg?.confirmedAt?.toISOString() ?? null,
        depositToBindSeconds: p.bindSeconds,
        depositToLedgerSeconds: p.ledgerSeconds,
        workerOutcome: `${p.outcomeKind}:${p.outcomeReason}`,
        checks: p.checks,
        failures: p.failures,
        pass: p.pass,
      })),
    },
    negative: {
      target: NEGATIVE_TARGET,
      passed: negativePassed,
      settlementLegsCreated: settlementRowsAfterNegatives - settlementRowsBeforeNegatives,
      fixtureOrderReferenceId: fixture.referenceId,
      cases: negatives.map((n) => ({
        index: n.index,
        group: n.kind,
        label: n.label,
        referenceId: n.referenceId,
        submittedDepositReference: n.submittedDepositReference,
        submittedUsdAmount: n.submittedUsdAmount,
        expectedRejectReason: n.expectedRejectReason,
        actualRejectReason: n.actualRejectReason,
        errorName: n.errorName,
        errorMessage: n.errorMessage,
        finalStatus: n.finalStatus,
        settlementLegs: n.settlementLegs,
        rejectEventRecorded: n.rejectEventRecorded,
        failures: n.failures,
        pass: n.pass,
      })),
    },
    observedMetrics: {
      note: 'Observational metric — NOT a pass/fail condition.',
      averageDepositConfirmToSettlementBindSeconds: avgBind,
      averageDepositConfirmToLedgerConfirmSeconds: avgLedger,
    },
    reconciliation: {
      totalSettledFromDatabase: totalSettled,
      payoutOpeningBalance: payoutOpening,
      payoutBalanceAfterPositives: payoutAfterPositives,
      payoutBalanceAfterNegatives: payoutAfterNegatives,
      payoutDeltaPositives,
      payoutDeltaNegatives,
      treasuryOpeningBalance: treasuryOpening,
      treasuryBalanceAfterPositives: treasuryAfterPositives,
      treasuryDeltaPositives,
      corridorTotalInDatabase,
      corridorLegsInDatabase: corridorLegs.length,
      payoutOpeningWasZero,
      oneStepCheckHolds,
      handoverReady,
      allowReusedCorridorFlagPassed: ALLOW_REUSED_CORRIDOR,
      payoutAbsoluteMatchesDatabase,
      payoutIncomingPaymentCount: payoutHistory.count,
      payoutIncomingPaymentTotal: payoutHistory.total,
      payoutOtherOperationTypes: payoutHistory.otherOperationTypes,
      ledgerHistoryMatchesDatabase,
      unexplainedInflow,
      payoutMatchesDatabase,
      treasuryMatchesDatabase,
      reconciled,
      negativesMovedNothing,
      note:
        'The payout float started this corridor at exactly 0 USDC, so its absolute balance is reconciled directly against the sum of every confirmed leg recorded for this corridor in the database. The delta checks are kept as a second, independent confirmation.',
    },
    preexistingSettleableOrdersAtStart: preexisting.map((o) => ({
      referenceId: o.referenceId,
      status: o.status,
    })),
    settlementRowsInDatabase: {
      atStart: settlementRowsAtStart,
      beforeNegatives: settlementRowsBeforeNegatives,
      afterNegatives: settlementRowsAfterNegatives,
    },
    files: [],
  }
  manifest.files = run.files()
  run.writeJson('run.json', manifest)
  const indexPath = rebuildIndex()

  run.log('d2.run_done', {
    positivePassed,
    negativePassed,
    reconciled,
    negativesMovedNothing,
    oneStepCheckHolds,
    handoverReady,
    dir: run.rel(run.dir),
  })

  console.log('')
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`  D2 · POSITIVE (real USDC tx):      ${positivePassed}/${POSITIVE_TARGET} PASS`)
  console.log(`  D2 · NEGATIVE (must be rejected):  ${negativePassed}/${NEGATIVE_TARGET} PASS · transactions produced: ${settlementRowsAfterNegatives - settlementRowsBeforeNegatives}`)
  console.log('══════════════════════════════════════════════════════════════')
  for (const p of positives) {
    console.log(
      `  ${String(p.index).padStart(2)}. ${p.referenceId}  ${String(p.leg?.amount ?? '—').padStart(12)} ${ASSET_CODE}  ledger ${p.leg?.ledgerSeq ?? '—'}  ${p.pass ? 'PASS' : `FAIL (${p.failures.join('; ')})`}`,
    )
  }
  console.log('')
  for (const n of negatives) {
    console.log(
      `  ${String(n.index).padStart(2)}. ${n.referenceId}  ${n.kind.padEnd(20)} → ${n.finalStatus}/${n.actualRejectReason ?? '—'}  legs=${n.settlementLegs}  ${n.pass ? 'PASS' : `FAIL (${n.failures.join('; ')})`}`,
    )
  }
  console.log('')
  console.log(`  Reconciliation : payout absolute balance ${payoutAfterNegatives} vs database total ${corridorTotalInDatabase} → ${payoutAbsoluteMatchesDatabase ? 'EXACT MATCH' : 'MISMATCH'}`)
  console.log(`                   payout delta ${payoutDeltaPositives} vs this run's legs ${totalSettled} → ${payoutMatchesDatabase ? 'EXACT MATCH' : 'MISMATCH'}`)
  console.log(`                   payout opening balance ${payoutOpening}${payoutOpeningWasZero ? ' (exactly zero — absolute check is meaningful)' : ' (NOT zero)'}`)
  console.log(`                   payout ledger history ${payoutHistory.count} incoming payments totalling ${payoutHistory.total} vs ${corridorLegs.length} legs in database → ${ledgerHistoryMatchesDatabase ? 'EVERY CREDIT ACCOUNTED FOR' : `UNEXPLAINED INFLOW ${unexplainedInflow}`}`)
  console.log(`  Observed metric: deposit confirm → settlement bind, average ${avgBind ?? '—'}s (observational, not pass/fail)`)
  console.log('')
  if (!oneStepCheckHolds) {
    console.log('')
    console.log('══════════════════════════════════════════════════════════════')
    console.log('  WARNING — THIS RUN IS NOT FIT FOR HANDOVER')
    console.log('══════════════════════════════════════════════════════════════')
    console.log(`  The payout float was already in use before this run started.`)
    console.log(`    opening balance          : ${payoutOpening} (expected 0.0000000)`)
    console.log(`    credits in its history   : ${payoutHistory.count}`)
    console.log(`    legs in this report      : ${positives.length}`)
    console.log(`    balance on the ledger    : ${payoutAfterNegatives}`)
    console.log(`    total of this run's legs : ${totalSettled}`)
    console.log('')
    console.log("  Every transaction above is real and every internal check passed, but")
    console.log("  the README's one-step check DOES NOT HOLD for this run: a reviewer")
    console.log('  opening the payout float on a block explorer will not see the total')
    console.log('  printed in the results table.')
    console.log('')
    console.log('  An evidence corridor is SINGLE-USE PER HANDOVER. Before handing over:')
    console.log('    1. pnpm stellar:bootstrap        (creates a fresh corridor)')
    console.log('    2. point .env at the new issuer / treasury / payout')
    console.log('    3. pnpm evidence:d2              (re-run on the clean corridor)')
    console.log('')
    console.log(`  The published summary carries this warning too: ${run.rel(run.path('d2-summary.md'))}`)
    if (ALLOW_REUSED_CORRIDOR) {
      console.log('')
      console.log('  --allow-reused-corridor was passed, so this run exits 0 anyway.')
    }
    console.log('══════════════════════════════════════════════════════════════')
    console.log('')
  }

  console.log(`  Results table  : ${run.rel(run.path('d2-summary.md'))}`)
  console.log(`  Tx originals   : ${run.rel(run.path('tx'))}/`)
  console.log(`  Index          : ${indexPath}`)
  console.log('')

  await closePool(db)
  process.exit(handoverReady || (overall && ALLOW_REUSED_CORRIDOR) ? 0 : 1)
}

void main().catch(async (err) => {
  console.error('\nD2 FAILED:', err instanceof Error ? err.message : err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  await closePool(db).catch(() => {})
  process.exit(1)
})
