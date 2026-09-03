/**
 * SHARED INFRASTRUCTURE FOR THE EVIDENCE GENERATORS (D1 + D2).
 *
 * Three quality constraints of the evidence pack live in this file:
 *
 *   1. SELF-GENERATED, RE-RUNNABLE. Every result table comes out of
 *      `writeTable()` — Markdown and CSV at once, from the same data array.
 *      There is no hand-copy step, so fixing a bug only means re-running the
 *      script.
 *
 *   2. SURVIVES THE TESTNET RESET (2026-12-16). The reset wipes Horizon history
 *      and every Stellar Expert link will die. That is why each run gets its
 *      own folder and the D2 script writes the raw signed XDR + the full
 *      Horizon JSON into it.
 *
 *   3. ONLY THIS RUN'S DATA. Every run has a run ID; the script exports only
 *      the orders IT created (filtered by the set of reference IDs collected in
 *      memory). The DB already holds orders from smoke tests — we FILTER, we do
 *      not delete.
 *
 * And one security constraint: `access_token` is NEVER written to an evidence
 * file. `assertClean()` scans every byte before writing, blocking both Stellar
 * secret seeds and every access token issued during this run.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { redact } from '@/src/worker/log'
import {
  PLACEHOLDER_FEE_RATE,
  PLACEHOLDER_FX_RATE_USD_PHP,
  STELLAR_DECIMALS,
} from '@/src/domain/types'

// ─── Money arithmetic — DELIBERATELY re-implemented, no money.ts import ────
//
// D1 must check that "the FX quote is correct". Checking it with the very
// function that produced it (`computeQuote` → `money.ts`) only proves the code
// against itself. So what follows is an INDEPENDENT implementation of the same
// arithmetic: if two implementations produce the same number, that number is
// worth trusting. The constants still come from `src/domain/types.ts` — that is
// the contract, not the calculation.

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/

/** Decimal string -> BigInt in the smallest unit for `decimals`. */
export function toUnits(value: string | number, decimals: number): bigint {
  const raw = String(value).trim()
  const m = DECIMAL_RE.exec(raw)
  if (!m) throw new RangeError(`Not a positive decimal number: "${raw}"`)
  const frac = m[2] ?? ''
  if (frac.length > decimals) throw new RangeError(`"${raw}" has more than ${decimals} decimal places`)
  return BigInt(m[1] + frac.padEnd(decimals, '0'))
}

/** BigInt -> decimal string with exactly `decimals` places. */
export function fromUnits(units: bigint, decimals: number): string {
  const neg = units < 0n
  const abs = neg ? -units : units
  const scale = 10n ** BigInt(decimals)
  const body =
    decimals === 0
      ? String(abs / scale)
      : `${abs / scale}.${String(abs % scale).padStart(decimals, '0')}`
  return neg ? `-${body}` : body
}

/** Half-up rounding division, no floats. */
function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('The denominator must be positive')
  const neg = numerator < 0n
  const abs = neg ? -numerator : numerator
  const q = (abs * 2n + denominator) / (denominator * 2n)
  return neg ? -q : q
}

/** a * b when both share the `decimals` scale; the result keeps that scale. */
function mulSameScale(a: bigint, b: bigint, decimals: number): bigint {
  return divHalfUp(a * b, 10n ** BigInt(decimals))
}

/** Amounts equal by VALUE, not by string comparison ("7.25" == "7.2500000"). */
export function amountsEqual(a: string | number | null, b: string | number | null, decimals: number): boolean {
  if (a === null || b === null) return false
  try {
    return toUnits(a, decimals) === toUnits(b, decimals)
  } catch {
    return false
  }
}

/** PHP is stored in the DB at scale 2 (numeric(20,2)). */
export const PHP_DECIMALS = 2

export interface ExpectedQuote {
  fxRate: string
  feeUsd: string
  netUsd: string
  phpEstimate: string
}

/**
 * The EXPECTED quote, recomputed from scratch with the formula fixed in the SOW:
 *   fee = usd × 1%  (half-up, 7 decimals)
 *   net = usd − fee
 *   php = net × 56.5 (down to 2 decimals, half-up)
 */
export function expectedQuote(usdAmount: string | number): ExpectedQuote {
  const usd = toUnits(usdAmount, STELLAR_DECIMALS)
  const fee = mulSameScale(usd, toUnits(PLACEHOLDER_FEE_RATE, STELLAR_DECIMALS), STELLAR_DECIMALS)
  const net = usd - fee
  const php7 = mulSameScale(net, toUnits(PLACEHOLDER_FX_RATE_USD_PHP, STELLAR_DECIMALS), STELLAR_DECIMALS)
  const php2 = divHalfUp(php7, 10n ** BigInt(STELLAR_DECIMALS - PHP_DECIMALS))
  return {
    fxRate: PLACEHOLDER_FX_RATE_USD_PHP,
    feeUsd: fromUnits(fee, STELLAR_DECIMALS),
    netUsd: fromUnits(net, STELLAR_DECIMALS),
    phpEstimate: fromUnits(php2, PHP_DECIMALS),
  }
}

/** Sum a list of amounts, returned as a 7-decimal string. */
export function sumAmounts(amounts: readonly (string | number)[], decimals = STELLAR_DECIMALS): string {
  let total = 0n
  for (const a of amounts) total += toUnits(a, decimals)
  return fromUnits(total, decimals)
}

/** b − a (decimal strings). Used to reconcile balance deltas on the ledger. */
export function subtractAmounts(b: string, a: string, decimals = STELLAR_DECIMALS): string {
  return fromUnits(toUnits(b, decimals) - toUnits(a, decimals), decimals)
}

// ─── Is this pack fit for handover? ───────────────────────────────────────

export interface OneStepCheckInput {
  /** Payout float balance before this run started. */
  payoutOpeningBalance: string
  /** Number of incoming asset payments in the payout float's whole history. */
  incomingPaymentCount: number
  /** Sum of those payments. */
  incomingPaymentTotal: string
  /** Settlement legs this run put in the results table. */
  legsInThisRun: number
  /** Total amount of those legs. */
  totalSettledInThisRun: string
}

/**
 * Does the README's one-step check hold for this run?
 *
 * The README tells a reviewer they can audit the whole set in one step: open
 * the payout float on a block explorer, read the balance, compare it with the
 * total of the table in THAT report. The promise is only true while the payout
 * float's entire credit history *is* that run's legs — nothing before it and
 * nothing beside it.
 *
 * Which is what makes an evidence corridor SINGLE-USE PER HANDOVER, and why
 * this predicate exists as a named, checkable function instead of an inline
 * condition: re-running on an already-used corridor keeps every other check
 * green (the balance still equals the database total, every credit is still
 * accounted for) while silently falsifying the report's headline claim.
 */
export function oneStepCheckHolds(input: OneStepCheckInput): boolean {
  return (
    amountsEqual(input.payoutOpeningBalance, '0', STELLAR_DECIMALS) &&
    input.incomingPaymentCount === input.legsInThisRun &&
    amountsEqual(input.incomingPaymentTotal, input.totalSettledInThisRun, STELLAR_DECIMALS)
  )
}

// ─── Formatting ────────────────────────────────────────────────────────────

/** Human-readable UTC for the reviewer: `2026-09-03 04:22:32Z`. */
export function fmtUtc(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toISOString().slice(0, 19).replace('T', ' ')}Z`
}

/** Seconds between two instants, 3 decimals. `null` if either is missing. */
export function secondsBetween(from: Date | null | undefined, to: Date | null | undefined): number | null {
  if (!from || !to) return null
  return Math.round((to.getTime() - from.getTime())) / 1000
}

/** Arithmetic mean, 3 decimals. `null` when there is no sample at all. */
export function average(values: readonly (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null)
  if (xs.length === 0) return null
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000
}

export const YES = 'PASS'
export const NO = 'FAIL'
export const TICK = 'yes'
export const CROSS = 'NO'

export const shortHash = (hash: string): string => `${hash.slice(0, 8)}…${hash.slice(-8)}`

// ─── Tables: Markdown + CSV from the SAME data array ───────────────────────

export type Cell = string | number | boolean | null | undefined

export interface Column<R> {
  header: string
  get: (row: R, index: number) => Cell
}

const cellText = (v: Cell): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? TICK : CROSS
  return String(v)
}

const mdCell = (v: Cell): string => {
  const s = cellText(v)
  if (s === '') return '—'
  return s.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

const csvCell = (v: Cell): string => {
  const s = cellText(v)
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function mdTable<R>(cols: readonly Column<R>[], rows: readonly R[]): string {
  const head = `| ${cols.map((c) => c.header).join(' | ')} |`
  const rule = `| ${cols.map(() => '---').join(' | ')} |`
  const body = rows.map((r, i) => `| ${cols.map((c) => mdCell(c.get(r, i))).join(' | ')} |`)
  return [head, rule, ...body].join('\n')
}

export function csvText<R>(cols: readonly Column<R>[], rows: readonly R[]): string {
  const head = cols.map((c) => csvCell(c.header)).join(',')
  const body = rows.map((r, i) => cols.map((c) => csvCell(c.get(r, i))).join(','))
  return `${[head, ...body].join('\n')}\n`
}

// ─── Evidence folders ──────────────────────────────────────────────────────

export const REPO_ROOT = resolve(process.cwd())
export const EVIDENCE_ROOT = join(REPO_ROOT, 'evidence')

export type Deliverable = 'd1' | 'd2'

/** `d1-20260903T044212Z-9f3a` — sortable, collision-free, no DB needed. */
export function newRunId(deliverable: Deliverable, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${deliverable}-${stamp}-${randomBytes(2).toString('hex')}`
}

/** Stellar secret seed — blocked by shape, even inside a harmless field. */
const SECRET_SEED_RE = /\bS[A-Z2-7]{55}\b/

/**
 * One run = one run ID = one folder. Every file write goes through here so that
 * `assertClean()` gets its chance to block a secret / access token.
 */
export class EvidenceRun {
  readonly id: string
  readonly deliverable: Deliverable
  readonly dir: string
  readonly startedAt: Date
  private readonly forbidden = new Set<string>()
  private readonly logPath: string
  private readonly written: string[] = []

  constructor(deliverable: Deliverable, now: Date = new Date()) {
    this.deliverable = deliverable
    this.startedAt = now
    this.id = newRunId(deliverable, now)
    this.dir = join(EVIDENCE_ROOT, deliverable, this.id)
    mkdirSync(this.dir, { recursive: true })
    this.logPath = join(this.dir, 'run.log.jsonl')
    // The treasury secret is in this process's env — not one byte of it may
    // leak out.
    const treasury = process.env.CORRIDOR_TREASURY_SECRET?.trim()
    if (treasury) this.forbidden.add(treasury)
  }

  /** Register a secret string (access token) so every write scans for it. */
  registerSecret(value: string | null | undefined): void {
    if (value && value.length >= 8) this.forbidden.add(value)
  }

  /** Scan the content before writing. A secret present ⇒ THROW, write nothing. */
  assertClean(text: string, label: string): void {
    for (const secret of this.forbidden) {
      if (text.includes(secret)) {
        throw new Error(
          `WRITE BLOCKED: "${label}" contains a secret value (access token or secret seed). ` +
            'An evidence pack must not contain an access_token — fix the script, not the rule.',
        )
      }
    }
    if (SECRET_SEED_RE.test(text)) {
      throw new Error(`WRITE BLOCKED: "${label}" contains a string shaped like a Stellar secret seed (S...56).`)
    }
  }

  /** Absolute path inside the run folder. */
  path(...parts: string[]): string {
    return join(this.dir, ...parts)
  }

  /** Path relative to the repo root — used when printing for a reader. */
  rel(absolute: string): string {
    return relative(REPO_ROOT, absolute)
  }

  writeText(relPath: string, text: string): string {
    const abs = this.path(relPath)
    this.assertClean(text, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
    this.written.push(this.rel(abs))
    return this.rel(abs)
  }

  writeJson(relPath: string, value: unknown): string {
    return this.writeText(relPath, `${JSON.stringify(value, null, 2)}\n`)
  }

  /**
   * CSV of one table. The Markdown of the SAME table is built by the script
   * with `mdTable()` from the same `cols` and the same `rows` — the two formats
   * cannot drift apart because they are not two copies of the data.
   */
  writeCsv<R>(relPath: string, cols: readonly Column<R>[], rows: readonly R[]): string {
    return this.writeText(relPath, csvText(cols, rows))
  }

  /** JSONL log into the run folder + stdout. Goes through the worker's `redact()`. */
  log(event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      runId: this.id,
      event,
      ...redact(fields),
    })
    this.assertClean(line, 'run.log.jsonl')
    appendFileSync(this.logPath, `${line}\n`)
    process.stdout.write(`${line}\n`)
  }

  files(): readonly string[] {
    return [...this.written, this.rel(this.logPath)]
  }
}

// ─── run.json + INDEX.md ───────────────────────────────────────────────────

export interface RunManifest {
  deliverable: Deliverable
  runId: string
  startedAt: string
  finishedAt: string
  /** One line for the reviewer to read, e.g. "10/10 pass · 5/5 reject". */
  headline: string
  pass: boolean
  files: readonly string[]
  [key: string]: unknown
}

/**
 * Rebuild `evidence/INDEX.md` by SCANNING the run.json files that really exist.
 *
 * Not by appending to an accumulating file: appending makes the index live
 * independently of the data, and it starts lying the first time somebody
 * deletes a run folder.
 */
export function rebuildIndex(): string {
  const runs: RunManifest[] = []
  for (const deliverable of ['d1', 'd2'] as const) {
    const base = join(EVIDENCE_ROOT, deliverable)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base)) {
      const manifestPath = join(base, entry, 'run.json')
      if (!existsSync(manifestPath)) continue
      try {
        runs.push(JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest)
      } catch {
        // A broken run.json is skipped rather than killing the whole index.
      }
    }
  }
  runs.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))

  const cols: Column<RunManifest>[] = [
    { header: 'Deliverable', get: (r) => r.deliverable.toUpperCase() },
    { header: 'Run ID', get: (r) => r.runId },
    { header: 'Finished (UTC)', get: (r) => fmtUtc(r.finishedAt) },
    { header: 'Result', get: (r) => r.headline },
    { header: 'Overall', get: (r) => (r.pass ? YES : NO) },
    { header: 'Folder', get: (r) => `\`evidence/${r.deliverable}/${r.runId}/\`` },
  ]

  const newest = (d: Deliverable) => runs.find((r) => r.deliverable === d)
  const d1 = newest('d1')
  const d2 = newest('d2')

  const body = [
    '# TransPay — evidence index',
    '',
    'Generated by `pnpm evidence:d1` and `pnpm evidence:d2`. Do not edit by hand:',
    'every table below is written by the scripts, so re-running them replaces the',
    'numbers with a fresh, self-consistent set.',
    '',
    '## Start here (newest run of each deliverable)',
    '',
    d1
      ? `- **D1 — transfer orders:** [\`evidence/d1/${d1.runId}/d1-orders.md\`](d1/${d1.runId}/d1-orders.md) — ${d1.headline}`
      : '- **D1 — transfer orders:** no run yet. Run `pnpm evidence:d1`.',
    d2
      ? `- **D2 — settlements:** [\`evidence/d2/${d2.runId}/d2-summary.md\`](d2/${d2.runId}/d2-summary.md) — ${d2.headline}`
      : '- **D2 — settlements:** no run yet. Run `pnpm evidence:d2`.',
    '',
    '## Every run',
    '',
    runs.length > 0 ? mdTable(cols, runs) : '_No runs yet._',
    '',
    '## Why one folder per run',
    '',
    'The database is shared between runs and already contained orders from earlier',
    'smoke tests. Each script therefore exports **only the orders that run itself',
    'created** — it filters by the set of reference IDs it just issued. No record is',
    'ever deleted to clean up the output; older rows are simply left out of the',
    'tables.',
    '',
    '## Testnet links stop working after 2026-12-16',
    '',
    'Stellar Testnet is reset periodically, and the reset on **16 December 2026**',
    'wipes Horizon history — every Stellar Expert link in these tables will return',
    '404 from that day on, even though the work was finished in October.',
    '',
    'The network-independent originals live in `evidence/d2/<run>/tx/`: the raw',
    'signed XDR (`.xdr`) and the full Horizon JSON captured at confirmation time',
    '(`.horizon.json`, containing ledger sequence, timestamp, memo,',
    'source/destination and amount).',
    '',
    'To re-check the pack offline, with no network and no database:',
    '',
    '```',
    'npx tsx scripts/verify-evidence.ts',
    '```',
    '',
  ].join('\n')

  const target = join(EVIDENCE_ROOT, 'INDEX.md')
  mkdirSync(EVIDENCE_ROOT, { recursive: true })
  writeFileSync(target, `${body}\n`)
  return relative(REPO_ROOT, target)
}

// ─── Horizon (read directly, not through the SDK) ──────────────────────────
//
// The SDK returns objects with `_links` plus callbacks — JSON.stringify loses
// those. Evidence needs the JSON exactly as Horizon returns it, so the functions
// below fetch directly.

/**
 * GET one JSON document from Horizon, with retries.
 *
 * The retry here is NOT belt-and-braces: a single transient `fetch failed`
 * (flaky DNS, a TLS reset) once killed an entire 10-tx run right at the opening
 * balance read. Every call in this file is READ-ONLY, so retrying is completely
 * safe — quite unlike submitting a tx, where a blind retry is never allowed.
 *
 * A 404 is not retried: it is an answer, not a transport failure.
 */
export async function fetchJson(url: string, attempts = 4): Promise<Record<string, unknown>> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (res.status === 404) {
        throw new Error(`Horizon 404 for ${url}`)
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        lastError = new Error(`Horizon ${res.status} for ${url}: ${body.slice(0, 300)}`)
      } else {
        return (await res.json()) as Record<string, unknown>
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Horizon 404')) throw err
      lastError = err
    }
    if (attempt < attempts) await sleep(500 * attempt)
  }
  throw new Error(
    `Could not read ${url} after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/** The account's balance in one specific asset. No trustline ⇒ "0.0000000". */
export async function assetBalanceOf(
  horizonUrl: string,
  publicKey: string,
  assetCode: string,
  assetIssuer: string,
): Promise<string> {
  const account = await fetchJson(`${horizonUrl}/accounts/${publicKey}`)
  const balances = (account['balances'] ?? []) as Array<Record<string, unknown>>
  for (const b of balances) {
    if (b['asset_code'] === assetCode && b['asset_issuer'] === assetIssuer) {
      return String(b['balance'])
    }
  }
  return fromUnits(0n, STELLAR_DECIMALS)
}

export interface IncomingPayment {
  txHash: string
  amount: string
  from: string
  createdAt: string
}

export interface IncomingPaymentHistory {
  /** Number of payment ops CREDITING the account in the right asset. */
  count: number
  /** Total amount of those payments, 7 decimals. */
  total: string
  payments: IncomingPayment[]
  /** Every other operation type seen (create_account, change_trust...). */
  otherOperationTypes: string[]
}

/**
 * The COMPLETE incoming-payment history of an account, read straight from Horizon.
 *
 * Why this is needed when the balance is not enough: the balance only states a
 * total, while what the evidence pack actually claims is "the payout float has
 * NEVER received anything other than the settlements in this report". A single
 * credit contaminating it from another environment (it happened: a production
 * test order settled into the very payout float being used as evidence) makes
 * that claim false, and only counting and matching operation by operation
 * catches it — comparing one grand total does not.
 *
 * Paginated: a corridor run several times exceeds a single page.
 */
export async function incomingPaymentHistory(
  horizonUrl: string,
  publicKey: string,
  assetCode: string,
  assetIssuer: string,
): Promise<IncomingPaymentHistory> {
  const payments: IncomingPayment[] = []
  const otherOperationTypes = new Set<string>()
  let url: string | null = `${horizonUrl}/accounts/${publicKey}/payments?limit=200&order=asc`

  while (url) {
    const page = await fetchJson(url)
    const embedded = page['_embedded'] as Record<string, unknown> | undefined
    const records = (embedded?.['records'] ?? []) as Array<Record<string, unknown>>
    if (records.length === 0) break

    for (const record of records) {
      if (record['type'] !== 'payment') {
        otherOperationTypes.add(String(record['type']))
        continue
      }
      // Credits only, in the right asset. Outgoing payments sit in this endpoint too.
      if (record['to'] !== publicKey) continue
      if (record['asset_code'] !== assetCode || record['asset_issuer'] !== assetIssuer) {
        otherOperationTypes.add(`payment:${String(record['asset_code'] ?? 'XLM')}`)
        continue
      }
      payments.push({
        txHash: String(record['transaction_hash']),
        amount: String(record['amount']),
        from: String(record['from']),
        createdAt: String(record['created_at']),
      })
    }

    const links = page['_links'] as Record<string, { href?: string }> | undefined
    const next = links?.['next']?.href ?? null
    url = next && records.length === 200 ? next : null
  }

  return {
    count: payments.length,
    total: sumAmounts(payments.map((p) => p.amount)),
    payments,
    otherOperationTypes: [...otherOperationTypes],
  }
}

/** A tx's operations — the ONLY place with a payment's destination + amount. */
export async function transactionOperations(horizonUrl: string, txHash: string): Promise<unknown[]> {
  const page = await fetchJson(`${horizonUrl}/transactions/${txHash}/operations?limit=50`)
  const embedded = page['_embedded'] as Record<string, unknown> | undefined
  return (embedded?.['records'] ?? []) as unknown[]
}

// ─── Utilities ─────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Close the postgres-js pool so the process exits instead of hanging. */
export async function closePool(db: unknown): Promise<void> {
  const client = (db as { $client?: { end?: (o?: unknown) => Promise<void> } }).$client
  await client?.end?.({ timeout: 5 })
}
