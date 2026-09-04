/**
 * D1 — EVIDENCE OF TRANSFER ORDER CREATION (USD → PHP chat flow), 10 runs.
 *
 *   pnpm dev            # in one terminal — the run needs the web app
 *   pnpm evidence:d1    # in another
 *
 * Each run: a different USD amount AND different recipient bank details, driven
 * through the SAME HTTP ENDPOINTS THE CHAT UI CALLS — not through the domain
 * functions behind them. The five requests per order, in the order
 * `app/components/ChatApp.tsx` issues them via `app/_lib/api-client.ts`:
 *
 *   POST /api/orders                            → draft→quoted, returns accessToken
 *   POST /api/orders/[token]/confirm-quote      → sender confirmation
 *   POST /api/orders/[token]/recipient          → recipient bank details
 *   POST /api/orders/[token]/deposit-reference  → deposit instructions
 *   GET  /api/orders/[token]                    → read back what the API reports
 *
 * Why the HTTP path and not the domain calls: the SOW asks for 10 iterations
 * "via the USD to PHP chat flow". Calling `createOrder()` in-process proves the
 * domain, and silently skips the six route handlers, the Zod input schemas, the
 * error→HTTP mapping and the public payload the browser actually receives — the
 * whole layer the reviewer sees. So this script speaks to the app over the
 * network, exactly as the browser does; the HTTP status of every step goes into
 * the results table and `run.json`, and the base URL is printed with the run.
 *
 * Base URL: `EVIDENCE_BASE_URL`, default `http://localhost:3000` — so the same
 * script can be pointed at a deployed instance.
 *
 * D1 STOPS at `awaiting_deposit` — deliberately. Confirming the deposit is D2's
 * job; if D1 pushed the order to `settlement_ready`, the worker would pick it up
 * and spend testnet USDC for a deliverable that requires no tx at all. That is
 * why `POST /api/orders/[token]/confirm-deposit` is the one chat-flow endpoint
 * this script does not call.
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
import { generateAccessToken } from '@/src/domain/token'
import {
  ACCESS_TOKEN_LENGTH,
  QUOTE_TTL_SECONDS,
  REFERENCE_ID_PATTERN,
  STELLAR_DECIMALS,
} from '@/src/domain/types'
import type {
  ApiErrorBody,
  CreateOrderResponse,
  OrderResponse,
  PublicOrder,
} from '@/app/_lib/types'
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

/**
 * The actor recorded in `order_events` for every step of this run. The route
 * handlers call the domain WITHOUT an actor override, so the rows carry the
 * domain default `'user'`. It is not this script's name — and that is itself a
 * trace that the transitions came in through the API rather than from a script
 * calling the domain directly.
 */
const API_ACTOR = 'user'

/** Identifies this script in its own log lines. Never written to order_events. */
const CLIENT = 'script:evidence-d1'

const TARGET = 10

/** Where the app is. Override to run the very same script against a deployment. */
const BASE_URL = (process.env['EVIDENCE_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '')

// ─── Dataset: 10 different amounts, 10 different banks/recipients ───────────

/** Exactly the body `api.addRecipient()` sends from the browser. */
interface RecipientPayload {
  fullName: string
  bankName: string
  accountNumber: string
  bankCode?: string
}

interface D1Case {
  usdAmount: string
  recipient: RecipientPayload
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

// ─── HTTP client — the same five calls the chat UI makes ────────────────────

/** The five chat-flow steps, in the order the UI performs them. */
const STEPS = ['create', 'confirm_quote', 'recipient', 'deposit_reference', 'read_back'] as const
type Step = (typeof STEPS)[number]

/** What each step expects to see, and how it is labelled in the evidence. */
const STEP_ROUTES: Readonly<Record<Step, { method: 'GET' | 'POST'; route: string; expect: number }>> = {
  create: { method: 'POST', route: '/api/orders', expect: 201 },
  confirm_quote: { method: 'POST', route: '/api/orders/[token]/confirm-quote', expect: 200 },
  recipient: { method: 'POST', route: '/api/orders/[token]/recipient', expect: 200 },
  deposit_reference: { method: 'POST', route: '/api/orders/[token]/deposit-reference', expect: 200 },
  read_back: { method: 'GET', route: '/api/orders/[token]', expect: 200 },
}

interface StepCall {
  step: Step
  method: 'GET' | 'POST'
  /** The TOKEN-FREE route label. The real path carries an access token and is
   *  never logged, never written to an evidence file. */
  route: string
  status: number
  ms: number
}

/** The server did not answer at all — a different problem from a 4xx/5xx. */
class ServerUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerUnreachableError'
  }
}

/** The server answered, but not with the status this step requires. */
class UnexpectedStatusError extends Error {
  constructor(
    readonly status: number,
    readonly expected: number,
    readonly label: string,
    readonly body: ApiErrorBody | null,
  ) {
    super(
      `${label} answered HTTP ${status}, expected ${expected}` +
        (body ? ` — ${body.error}: ${body.message}` : ''),
    )
    this.name = 'UnexpectedStatusError'
  }
}

function asErrorBody(parsed: unknown): ApiErrorBody | null {
  if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
    return parsed as ApiErrorBody
  }
  return null
}

function unreachable(err: unknown): ServerUnreachableError {
  const code =
    (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? null
  const detail = err instanceof Error ? err.message : String(err)
  return new ServerUnreachableError(
    `No answer from ${BASE_URL}${code ? ` (${code})` : ''}: ${detail}`,
  )
}

/**
 * One request, exactly as the browser sends it: JSON in, JSON out, no caching.
 *
 * `path` contains the access token; `route` is the token-free label that goes
 * into the evidence. Nothing derived from `path` is ever logged.
 */
async function apiRequest<T>(input: {
  step: Step
  path: string
  body?: unknown
}): Promise<{ data: T; call: StepCall }> {
  const { method, route, expect } = STEP_ROUTES[input.step]
  const label = `${method} ${route}`
  const startedAt = Date.now()

  let res: Response
  try {
    res = await fetch(`${BASE_URL}${input.path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      cache: 'no-store',
    })
  } catch (err) {
    throw unreachable(err)
  }

  const ms = Date.now() - startedAt
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text.trim() ? JSON.parse(text) : null
  } catch {
    parsed = null
  }

  if (res.status !== expect) {
    throw new UnexpectedStatusError(res.status, expect, label, asErrorBody(parsed))
  }
  if (parsed === null) {
    throw new Error(`${label} answered HTTP ${res.status} with a body that is not JSON.`)
  }

  return { data: parsed as T, call: { step: input.step, method, route, status: res.status, ms } }
}

/**
 * Is the app up and are the routes wired to a working database?
 *
 * The probe is a GET with a well-formed but unissued access token: it must come
 * back `404 order_not_found`. That single answer proves three things at once —
 * the host answers, the route handler is mounted, and it reached the database to
 * find nothing. A 5xx here means the app is running but its dependencies are
 * not, which is worth saying out loud instead of failing ten times over.
 *
 * Runs BEFORE the run folder is created, so an unreachable server leaves no
 * empty `evidence/d1/<runId>/` behind.
 */
async function preflight(): Promise<{ status: number; ms: number }> {
  const probe = generateAccessToken(ACCESS_TOKEN_LENGTH)
  const startedAt = Date.now()

  let res: Response
  try {
    res = await fetch(`${BASE_URL}/api/orders/${probe}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
  } catch (err) {
    throw unreachable(err)
  }
  const ms = Date.now() - startedAt

  const text = await res.text()
  let body: ApiErrorBody | null = null
  try {
    body = asErrorBody(text.trim() ? JSON.parse(text) : null)
  } catch {
    body = null
  }

  if (res.status === 404 && body?.error === 'order_not_found') {
    return { status: res.status, ms }
  }

  if (res.status >= 500) {
    throw new Error(
      `${BASE_URL} answered HTTP ${res.status} on GET /api/orders/[token]. The web server is up ` +
        'but the request failed — check that PostgreSQL is reachable (`docker compose up -d`) ' +
        'and the schema is migrated (`pnpm db:migrate`), then read the server console.',
    )
  }

  throw new Error(
    `${BASE_URL} answered HTTP ${res.status} on GET /api/orders/[token], expected 404 ` +
      `order_not_found. Is ${BASE_URL} really a TransPay instance?`,
  )
}

function printServerDownHelp(message: string): void {
  console.error('')
  console.error('══════════════════════════════════════════════════════════════')
  console.error('  D1 CANNOT RUN — the web app did not answer')
  console.error('══════════════════════════════════════════════════════════════')
  console.error(`  ${message}`)
  console.error('')
  console.error('  This run drives the real chat-flow endpoints over HTTP, so')
  console.error('  the web server has to be running.')
  console.error('')
  console.error('  In one terminal:   pnpm dev            # http://localhost:3000')
  console.error('  then in another:   pnpm evidence:d1')
  console.error('')
  console.error('  To point the run at a deployed instance instead:')
  console.error('    EVIDENCE_BASE_URL=https://your-deployment.example.com pnpm evidence:d1')
  console.error('')
}

// ─── One result row ────────────────────────────────────────────────────────

interface CaseRun {
  orderId: string
  referenceId: string
  /** The five HTTP calls this order took, with their statuses. */
  calls: readonly StepCall[]
  /** The order as `GET /api/orders/[token]` reported it at the end. */
  apiOrder: PublicOrder
}

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
  calls: readonly StepCall[]
  apiOrder: PublicOrder
  checks: {
    fxQuoteCorrect: boolean
    senderConfirmationRecorded: boolean
    recordComplete: boolean
  }
  failures: string[]
  pass: boolean
}

// ─── Run one case through the endpoints the chat UI calls ───────────────────

async function runCase(run: EvidenceRun, index: number, testCase: D1Case): Promise<CaseRun> {
  const calls: StepCall[] = []
  const record = (call: StepCall): void => {
    calls.push(call)
    run.log('d1.http_call', {
      case: index,
      step: call.step,
      method: call.method,
      route: call.route,
      status: call.status,
      ms: call.ms,
    })
  }

  // ── 1. POST /api/orders — the only response that carries the access token.
  const created = await apiRequest<CreateOrderResponse>({
    step: 'create',
    path: '/api/orders',
    body: { usdAmount: testCase.usdAmount },
  })
  // An access token must NEVER reach any evidence file — register it so every
  // later file write is scanned for it.
  run.registerSecret(created.data.accessToken)
  record(created.call)

  // From here on every step is addressed by token, exactly like the browser.
  const token = created.data.accessToken
  const order = created.data.order
  run.log('d1.order_created', {
    case: index,
    referenceId: order.referenceId,
    usdAmount: order.usdAmount,
    fxRate: order.fxRate,
    feeUsd: order.feeUsd,
    phpEstimate: order.phpEstimate,
    httpStatus: created.call.status,
  })

  // ── 2. POST …/confirm-quote — takes no body, like the UI's button.
  const confirmed = await apiRequest<OrderResponse>({
    step: 'confirm_quote',
    path: `/api/orders/${token}/confirm-quote`,
  })
  record(confirmed.call)
  run.log('d1.sender_confirmed', {
    case: index,
    referenceId: order.referenceId,
    confirmedAt: confirmed.data.order.confirmedAt,
    httpStatus: confirmed.call.status,
  })

  // ── 3. POST …/recipient — the recipient form of the chat flow.
  const withRecipient = await apiRequest<OrderResponse>({
    step: 'recipient',
    path: `/api/orders/${token}/recipient`,
    body: testCase.recipient,
  })
  record(withRecipient.call)

  // ── 4. POST …/deposit-reference — issues the (mock) deposit instructions.
  const withDeposit = await apiRequest<OrderResponse>({
    step: 'deposit_reference',
    path: `/api/orders/${token}/deposit-reference`,
  })
  record(withDeposit.call)
  run.log('d1.recipient_and_deposit_reference', {
    case: index,
    referenceId: order.referenceId,
    bankName: testCase.recipient.bankName,
    bankCode: testCase.recipient.bankCode,
    depositReference: withDeposit.data.order.deposit?.depositReference ?? null,
    httpStatus: withDeposit.call.status,
  })

  // ── 5. GET /api/orders/[token] — read back what the API itself reports.
  const readBack = await apiRequest<OrderResponse>({
    step: 'read_back',
    path: `/api/orders/${token}`,
  })
  record(readBack.call)
  const apiOrder = readBack.data.order
  assertApiOrder(index, testCase, order.referenceId, apiOrder)

  // The API never exposes the internal order UUID (references are sequential,
  // hence guessable — see app/_lib/orders.ts). The event log is keyed by it, so
  // resolve it here, from the database, by the reference the API returned.
  const stored = await ordersRepo.findByReferenceId(db, apiOrder.referenceId)
  if (!stored) {
    throw new Error(
      `The API created ${apiOrder.referenceId} but it is not in the database — the evidence cannot be trusted.`,
    )
  }

  return { orderId: stored.id, referenceId: apiOrder.referenceId, calls, apiOrder }
}

/**
 * The API's own read-back must agree with what was requested.
 *
 * This throws rather than scoring a FAIL: a disagreement here is not a failed
 * test case, it is a broken API contract, and continuing would produce a
 * results table that cannot be trusted at all.
 */
function assertApiOrder(
  index: number,
  testCase: D1Case,
  referenceIdAtCreate: string,
  apiOrder: PublicOrder,
): void {
  const problems: string[] = []
  if (apiOrder.referenceId !== referenceIdAtCreate) {
    problems.push(
      `GET returned reference ${apiOrder.referenceId}, POST /api/orders returned ${referenceIdAtCreate}`,
    )
  }
  if (apiOrder.status !== 'awaiting_deposit') {
    problems.push(`status is ${apiOrder.status}, expected awaiting_deposit`)
  }
  if (apiOrder.corridor !== 'PHP') problems.push(`corridor is ${apiOrder.corridor}, expected PHP`)
  if (!amountsEqual(apiOrder.usdAmount, testCase.usdAmount, STELLAR_DECIMALS)) {
    problems.push(`usdAmount is ${apiOrder.usdAmount}, requested ${testCase.usdAmount}`)
  }
  if (apiOrder.confirmedAt === null) problems.push('confirmedAt is null after confirm-quote')
  if (apiOrder.recipient === null) problems.push('recipient is null after the recipient step')
  else {
    if (apiOrder.recipient.fullName !== testCase.recipient.fullName) {
      problems.push(`recipient name is ${apiOrder.recipient.fullName}`)
    }
    if (apiOrder.recipient.bankName !== testCase.recipient.bankName) {
      problems.push(`recipient bank is ${apiOrder.recipient.bankName}`)
    }
    // Only the last 4 digits leave the server — that is the whole payload here.
    if (!apiOrder.recipient.accountNumberMasked.endsWith(testCase.recipient.accountNumber.slice(-4))) {
      problems.push(`masked account ${apiOrder.recipient.accountNumberMasked} does not match the account sent`)
    }
  }
  if (apiOrder.deposit === null) {
    problems.push('deposit is null after the deposit-reference step')
  } else if (apiOrder.deposit.confirmedAt !== null) {
    problems.push('the deposit is already confirmed — D1 must stop before that')
  }

  if (problems.length > 0) {
    throw new Error(
      `Case ${index}: GET /api/orders/[token] disagrees with the request: ${problems.join('; ')}`,
    )
  }
}

// ─── Evaluate one row against the three SOW conditions ──────────────────────

function evaluate(
  index: number,
  created: CaseRun,
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
    calls: created.calls,
    apiOrder: created.apiOrder,
    checks,
    failures,
    pass: fxQuoteCorrect && senderConfirmationRecorded && recordComplete,
  }
}

// ─── Table columns ─────────────────────────────────────────────────────────

/** HTTP status of one step, for the table. Empty if the step never ran. */
const statusOf = (r: D1Result, step: Step): number | null =>
  r.calls.find((c) => c.step === step)?.status ?? null

const totalHttpMs = (r: D1Result): number => r.calls.reduce((sum, c) => sum + c.ms, 0)

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

/**
 * The HTTP status of every step of the chat flow. This is the table that shows
 * the run went through the app's API and not through its internals.
 */
const httpCols: readonly Column<D1Result>[] = [
  { header: '#', get: (r) => r.index },
  { header: 'Reference ID', get: (r) => r.referenceId },
  { header: 'POST /api/orders', get: (r) => statusOf(r, 'create') },
  { header: 'POST …/confirm-quote', get: (r) => statusOf(r, 'confirm_quote') },
  { header: 'POST …/recipient', get: (r) => statusOf(r, 'recipient') },
  { header: 'POST …/deposit-reference', get: (r) => statusOf(r, 'deposit_reference') },
  { header: 'GET /api/orders/[token]', get: (r) => statusOf(r, 'read_back') },
  { header: 'Status read back from the API', get: (r) => r.apiOrder.status },
  { header: 'order_events actor', get: (r) => r.confirmationEvent?.actor ?? '' },
  { header: 'HTTP time, 5 calls (ms)', get: (r) => totalHttpMs(r) },
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
  { header: 'HTTP POST /api/orders', get: (r) => statusOf(r, 'create') },
  { header: 'HTTP POST /api/orders/[token]/confirm-quote', get: (r) => statusOf(r, 'confirm_quote') },
  { header: 'HTTP POST /api/orders/[token]/recipient', get: (r) => statusOf(r, 'recipient') },
  { header: 'HTTP POST /api/orders/[token]/deposit-reference', get: (r) => statusOf(r, 'deposit_reference') },
  { header: 'HTTP GET /api/orders/[token]', get: (r) => statusOf(r, 'read_back') },
  { header: 'Status read back from the API', get: (r) => r.apiOrder.status },
  { header: 'HTTP time, 5 calls (ms)', get: (r) => totalHttpMs(r) },
  { header: 'order_events actor', get: (r) => r.confirmationEvent?.actor ?? '' },
  { header: 'Check 1 FX quote correct', get: (r) => r.checks.fxQuoteCorrect },
  { header: 'Check 2 sender confirmation recorded', get: (r) => r.checks.senderConfirmationRecorded },
  { header: 'Check 3 record complete', get: (r) => r.checks.recordComplete },
  { header: 'Result', get: (r) => (r.pass ? YES : NO) },
  { header: 'Notes', get: (r) => r.failures.join('; ') },
]

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 0. Fail fast, and clearly, if nothing is listening. Before the run
  //      folder exists, so a server that is down produces no empty folder.
  const probe = await preflight()

  const run = new EvidenceRun('d1')
  run.log('d1.run_start', {
    runId: run.id,
    cases: CASES.length,
    baseUrl: BASE_URL,
    transport: 'http',
    client: CLIENT,
  })
  run.log('d1.preflight_ok', {
    baseUrl: BASE_URL,
    route: 'GET /api/orders/[token]',
    status: probe.status,
    ms: probe.ms,
  })

  // ── 1. Run the 10 cases. Sequentially, so reference IDs are issued in a readable order.
  const created: CaseRun[] = []
  for (const [i, testCase] of CASES.entries()) {
    created.push(await runCase(run, i + 1, testCase))
  }
  const refs = created.map((c) => c.referenceId)
  const ids = created.map((c) => c.orderId)

  // ── 2. Read back from the DB through the evidence repo (which never selects
  //      access_token) and FILTER down to exactly this run's orders. The DB
  //      already holds orders from smoke tests — we filter, we do not delete.
  //      This is a second, independent view of what the API reported in step 5.
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
  const headline = `${passed}/${TARGET} pass (via HTTP API)`

  // ── 4. Write the tables: Markdown for readers, CSV for tools.
  const uniqueAmounts = new Set(results.map((r) => r.row.usdAmount)).size
  const uniqueBanks = new Set(results.map((r) => r.row.recipientBank)).size
  const uniqueAccounts = new Set(results.map((r) => r.row.recipientAccount)).size
  const avgLatency = average(results.map((r) => secondsBetween(r.row.createdAt, r.row.confirmedAt)))
  const httpCalls = results.reduce((sum, r) => sum + r.calls.length, 0)
  const httpMs = results.reduce((sum, r) => sum + totalHttpMs(r), 0)
  const wallClockSeconds = secondsBetween(run.startedAt, finishedAt)

  const doc = [
    '# D1 — Transfer order creation (USD → PHP) · 10 runs',
    '',
    `**Result: ${passed}/${TARGET} passed.**`,
    '',
    `- Run ID: \`${run.id}\``,
    `- Started / finished (UTC): ${fmtUtc(run.startedAt)} → ${fmtUtc(finishedAt)} (${wallClockSeconds ?? '—'} s)`,
    `- Driven over HTTP against \`${BASE_URL}\` — **${httpCalls} requests**, ${httpMs} ms of HTTP time in total.`,
    '- Corridor: USD → PHP. The FX rate is a fixed placeholder — Phase 1 does not',
    '  call any market rate provider.',
    `- Distinct USD amounts: ${uniqueAmounts}/${results.length} · distinct banks: ${uniqueBanks}/${results.length} · distinct account numbers: ${uniqueAccounts}/${results.length}`,
    `- This table contains **only** the ${results.length} orders created by this run.`,
    `  ${skipped} other orders currently in the database (earlier smoke tests) were`,
    '  filtered out. Nothing was deleted.',
    '',
    '## How the run reaches the app',
    '',
    'Every order in these tables was created the way the chat interface creates',
    'one: five HTTP requests to the running web app, in the order',
    '`app/components/ChatApp.tsx` issues them through `app/_lib/api-client.ts`.',
    'The script holds no shortcut into the domain layer — it only has an access',
    'token and a URL, exactly like the browser.',
    '',
    '| Step | Request | Expected status |',
    '| --- | --- | --- |',
    '| 1. Amount entered, quote issued | `POST /api/orders` | 201 |',
    '| 2. Sender accepts the quote | `POST /api/orders/[token]/confirm-quote` | 200 |',
    '| 3. Recipient bank details | `POST /api/orders/[token]/recipient` | 200 |',
    '| 4. Deposit instructions issued | `POST /api/orders/[token]/deposit-reference` | 200 |',
    '| 5. Read the order back | `GET /api/orders/[token]` | 200 |',
    '',
    'Table 4 lists the status every one of those requests actually returned. The',
    'sixth endpoint of the flow, `POST /api/orders/[token]/confirm-deposit`, is',
    'deliberately **not** called: it would move the order to `settlement_ready`,',
    'the worker would settle it, and D1 would spend testnet USDC on a deliverable',
    'that needs no transaction at all.',
    '',
    `The \`quoted → confirmed\` rows in the event log carry actor \`${API_ACTOR}\` — the value`,
    'the route handler records for a request coming from a client. It is not the',
    'name of this script, which is a further trace that the transition arrived',
    'through the API.',
    '',
    'The base URL is configurable (`EVIDENCE_BASE_URL`), so the identical script',
    'and the identical checks can be pointed at a deployed instance.',
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
    'The figures in the tables below are read from the **database** after the HTTP',
    'flow finished, not from the API responses — so the API and the stored record',
    'have to agree for a run to pass. A disagreement between the two aborts the',
    'whole run instead of scoring a single failure: a broken API contract makes',
    'every row untrustworthy, not just one.',
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
    '## Table 4 — HTTP status of every step',
    '',
    mdTable(httpCols, results),
    '',
    'The access token itself appears in none of these files: it travels only in',
    'the request URL, and every route printed here is the token-free template.',
    '',
    '## Observed metric (not a pass/fail condition)',
    '',
    `- Average time from order creation to sender confirmation: **${avgLatency ?? '—'} seconds**. This is an automated script talking to a local server, so the number reflects machine and network speed, not user behaviour.`,
    '',
    '## Files in this folder',
    '',
    '| File | Contents |',
    '| --- | --- |',
    '| `d1-orders.md` | This document |',
    '| `d1-orders.csv` | Every column of all four tables, opens in Excel |',
    '| `d1-checks.csv` | The three-condition table on its own |',
    '| `d1-http.csv` | The HTTP status of each of the 50 requests, per order |',
    '| `run.json` | Machine-readable record of this run, including the base URL |',
    '| `run.log.jsonl` | Step-by-step log, one JSON object per event and per request |',
    '',
    'None of these files contains an order access token or a wallet secret key:',
    'the script scans every byte before writing and aborts if it finds one.',
    '',
  ].join('\n')

  run.writeText('d1-orders.md', doc)
  run.writeCsv('d1-orders.csv', csvCols, results)
  run.writeCsv('d1-checks.csv', checkCols, results)
  run.writeCsv('d1-http.csv', httpCols, results)

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
    actor: API_ACTOR,
    client: CLIENT,
    // The flow went over the network — this is where a reviewer checks that.
    transport: 'http',
    baseUrl: BASE_URL,
    httpRequests: httpCalls,
    httpTimeMs: httpMs,
    wallClockSeconds,
    endpoints: STEPS.map((step) => ({
      step,
      method: STEP_ROUTES[step].method,
      route: STEP_ROUTES[step].route,
      expectedStatus: STEP_ROUTES[step].expect,
    })),
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
      // What the API answered, step by step, for this order.
      http: r.calls.map((c) => ({
        step: c.step,
        method: c.method,
        route: c.route,
        status: c.status,
        ms: c.ms,
      })),
      apiReadBack: {
        status: r.apiOrder.status,
        usdAmount: r.apiOrder.usdAmount,
        feeUsd: r.apiOrder.feeUsd,
        fxRate: r.apiOrder.fxRate,
        phpEstimate: r.apiOrder.phpEstimate,
        accountNumberMasked: r.apiOrder.recipient?.accountNumberMasked ?? null,
        depositReference: r.apiOrder.deposit?.depositReference ?? null,
      },
      checks: r.checks,
      failures: r.failures,
      pass: r.pass,
    })),
    files: [],
  }
  manifest.files = run.files()
  run.writeJson('run.json', manifest)
  const indexPath = rebuildIndex()

  run.log('d1.run_done', {
    passed,
    target: TARGET,
    baseUrl: BASE_URL,
    httpRequests: httpCalls,
    dir: run.rel(run.dir),
  })

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
  console.log(`  Endpoint      : ${BASE_URL} · ${httpCalls} HTTP requests, ${httpMs} ms`)
  console.log(`  Results table : ${run.rel(run.path('d1-orders.md'))}`)
  console.log(`  CSV           : ${run.rel(run.path('d1-orders.csv'))}`)
  console.log(`  HTTP statuses : ${run.rel(run.path('d1-http.csv'))}`)
  console.log(`  Index         : ${indexPath}`)
  console.log('')

  await closePool(db)
  process.exit(passed === TARGET ? 0 : 1)
}

void main().catch(async (err) => {
  if (err instanceof ServerUnreachableError) {
    printServerDownHelp(err.message)
  } else {
    console.error('\nD1 FAILED:', err instanceof Error ? err.message : err)
    if (err instanceof Error && err.stack && !(err instanceof UnexpectedStatusError)) {
      console.error(err.stack)
    }
  }
  await closePool(db).catch(() => {})
  process.exit(1)
})
