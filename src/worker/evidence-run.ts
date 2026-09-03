/**
 * A REAL END-TO-END RUN on Stellar Testnet.
 *
 *   createOrder → confirmQuote → addRecipient → issueDepositReference
 *   → confirmDeposit (settlement_ready) → worker.runOnce → USDC really leaves the wallet
 *
 * Uses the EXACT `runOnce` that `pnpm worker` runs, with `liveStellarPort` — no
 * evidence-only shortcut anywhere. If this script produces a tx hash, the
 * worker produces that same tx hash.
 *
 *   npx tsx src/worker/evidence-run.ts [usdAmount]          # the full run
 *   npx tsx src/worker/evidence-run.ts [usdAmount] --prepare # only stage the order,
 *       for the real `pnpm worker` to pick up — use it to prove the loop too.
 *
 * Real (testnet) money will leave the treasury. This is not a test — this is evidence.
 */
import { eq } from 'drizzle-orm'
import { db } from '@/src/db/client'
import { settlements } from '@/src/db/schema'
import {
  addRecipient,
  confirmDeposit,
  confirmQuote,
  createOrder,
  getOrder,
  issueDepositReference,
} from '@/src/domain/orders'
import { consoleLogger } from './log'
import { liveStellarPort } from './ports'
import { recoverPending } from './recover'
import { runOnce } from './index'

const RECIPIENT = {
  fullName: 'Maria Santos',
  bankName: 'BDO Unibank',
  accountNumber: '00123456789',
  bankCode: 'BNORPHMM',
}

async function main(): Promise<void> {
  const usdAmount = process.argv[2] ?? '12.5'
  const prepareOnly = process.argv.includes('--prepare')
  const log = consoleLogger

  // ── 1. Move the order along the real domain path, no hand-written DB rows.
  const created = await createOrder({ usdAmount })
  await confirmQuote(created.id)
  await addRecipient(created.id, RECIPIENT)
  const { depositReference } = await issueDepositReference(created.id)
  await confirmDeposit(created.id, { depositReference, usdAmount })

  const ready = await getOrder(created.id)
  log.info('evidence.order_ready', {
    orderId: ready.id,
    referenceId: ready.referenceId,
    status: ready.status,
    usdAmount: ready.usdAmount,
    feeUsd: ready.feeUsd,
    phpEstimate: ready.phpEstimate,
  })

  if (prepareOnly) {
    log.info('evidence.prepare_only', { orderId: ready.id, referenceId: ready.referenceId })
    await closePool()
    return
  }

  // ── 2. Recover first, exactly as the real worker does at startup.
  await recoverPending({ logger: log, stellar: liveStellarPort })

  // ── 3. The real scan pass. Sequential, one order at a time.
  const report = await runOnce({
    logger: log,
    stellar: liveStellarPort,
    referenceLike: ready.referenceId,
  })

  const final = await getOrder(ready.id)
  const [leg] = await db.select().from(settlements).where(eq(settlements.orderId, ready.id))

  log.info('evidence.done', {
    referenceId: final.referenceId,
    orderStatus: final.status,
    settlementStatus: leg?.status ?? null,
    txHash: leg?.txHash ?? null,
    ledgerSeq: leg?.ledgerSeq ?? null,
    amount: leg?.amount ?? null,
    memo: leg?.memo ?? null,
    outcomes: report.outcomes.map((o) => `${o.kind}:${o.reason}`),
  })

  if (leg?.txHash) {
    console.log(`\nStellar Expert: https://stellar.expert/explorer/testnet/tx/${leg.txHash}`)
  }

  await closePool()
  process.exit(final.status === 'settled' ? 0 : 1)
}

async function closePool(): Promise<void> {
  const client = (db as unknown as { $client?: { end?: (o?: unknown) => Promise<void> } }).$client
  await client?.end?.({ timeout: 5 })
}

void main()
