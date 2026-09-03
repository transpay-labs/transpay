/**
 * FAKE STELLAR — stands in for the real network in unit tests.
 *
 * Not just a stub returning canned values: it reproduces the exact TRAP the
 * Stellar lane ran into with real transactions.
 *
 *   - An account's sequence is ONE number shared by every tx. `build` reads the
 *     current sequence (changing nothing), only `submit` bumps it. Two orders
 *     that both build first and submit after ⇒ the second one eats
 *     `tx_bad_seq`, just like the real thing.
 *   - RESUBMITTING the exact signed XDR of a tx already in a ledger ⇒ returns
 *     200 with the SAME ledger and hash (idempotent), no second payment.
 *
 * Every call is appended to `calls` in order, so tests can assert propositions
 * like "the old hash must be polled BEFORE anything else".
 */
import { createHash } from 'node:crypto'
import type { PollResult, StellarPort, SubmitResult } from '../ports'

export interface FakeCall {
  op: 'build' | 'submit' | 'poll' | 'deadline'
  txHash?: string
  at: number
}

export interface FakeLedgerEntry {
  ledgerSeq: number
  successful: boolean
}

export interface FakeStellarOptions {
  /** Timebounds validity of the fake tx (ms). */
  timeboundsMs?: number
  /** Override the submit behaviour. Return `undefined` to use the default. */
  onSubmit?: (ctx: { signedXdr: string; txHash: string; call: number }) => SubmitResult | undefined
  /** Override the poll behaviour. Return `undefined` to use the default. */
  onPoll?: (ctx: { txHash: string; deadlineMs: number; call: number }) => PollResult | undefined
  /** Artificial delay for build/submit — so tests can detect parallel execution. */
  buildDelayMs?: number
  submitDelayMs?: number
  /** Throws if buildSettlementTx is called. Used by the "NO rebuild" tests. */
  forbidBuild?: boolean
  /** Throws if submitSignedXdr is called. Used by the "NEVER send the money again" tests. */
  forbidSubmit?: boolean
  now?: () => number
}

export interface FakeStellar {
  port: StellarPort
  calls: FakeCall[]
  /** How many times each op was called. */
  count: (op: FakeCall['op']) => number
  /** The fake ledger: hash → result. Tests set it by hand to simulate "tx already on the ledger". */
  ledger: Map<string, FakeLedgerEntry>
  /** Payments the ledger actually recorded — double-send protection is measured here. */
  payments: string[]
  /** Orders running concurrently — must always be ≤ 1. */
  maxConcurrent: number
  /** Place a tx on the ledger by hand (simulating a crash after submit). */
  putOnLedger: (txHash: string, ledgerSeq?: number, successful?: boolean) => void
  /** The fake account's current sequence. */
  accountSequence: () => number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The fake XDR carries its own deadline + hash + sequence, so `deadlineMsFromXdr` can read them back. */
export function fakeXdr(txHash: string, deadlineMs: number, txSequence: number): string {
  return `FAKEXDR:${deadlineMs}:${txSequence}:${txHash}`
}

export function parseFakeXdr(xdr: string): { deadlineMs: number; txSequence: number; txHash: string } {
  const m = /^FAKEXDR:(\d+):(\d+):([0-9a-f]{64})$/.exec(xdr)
  if (!m) throw new Error(`Fake XDR could not be parsed: ${xdr}`)
  return { deadlineMs: Number(m[1]), txSequence: Number(m[2]), txHash: m[3] }
}

function badSeq(txHash: string): SubmitResult {
  return {
    ok: false,
    txHash,
    error: {
      kind: 'tx_bad_seq',
      retryable: true,
      resolution: 'rebuild',
      message: 'tx_bad_seq — sequence mismatch.',
      status: 400,
      resultCodes: { transaction: 'tx_bad_seq' },
    },
  }
}

export function createFakeStellar(options: FakeStellarOptions = {}): FakeStellar {
  const timeboundsMs = options.timeboundsMs ?? 180_000
  const now = options.now ?? Date.now
  const calls: FakeCall[] = []
  const ledger = new Map<string, FakeLedgerEntry>()
  const payments: string[] = []

  let accountSeq = 100
  let nextLedger = 900_000
  let buildN = 0
  let submitN = 0
  let pollN = 0
  let inFlight = 0
  const state = { maxConcurrent: 0 }

  const enter = () => {
    inFlight += 1
    if (inFlight > state.maxConcurrent) state.maxConcurrent = inFlight
  }
  const leave = () => {
    inFlight -= 1
  }

  const port: StellarPort = {
    async buildSettlementTx(params) {
      if (options.forbidBuild) {
        throw new Error('buildSettlementTx was called — that is the road to double-send, this test forbids it.')
      }
      enter()
      try {
        buildN += 1
        if (options.buildDelayMs) await sleep(options.buildDelayMs)

        // The sequence is READ here, only `submit` bumps it — just like the real thing.
        const txSequence = accountSeq + 1
        const txHash = createHash('sha256')
          .update(`${params.memo}|${params.amount}|${txSequence}|${buildN}`)
          .digest('hex')
        const deadlineMs = now() + timeboundsMs

        calls.push({ op: 'build', txHash, at: now() })
        return {
          txHash,
          signedXdr: fakeXdr(txHash, deadlineMs, txSequence),
          source: 'GTREASURYFAKE',
          destination: 'GPAYOUTFAKE',
          assetCode: 'USDC',
          assetIssuer: 'GISSUERFAKE',
          amount: params.amount,
          memo: params.memo,
          maxTimeSec: Math.floor(deadlineMs / 1000),
          deadlineMs,
          txSequence: String(txSequence),
        }
      } finally {
        leave()
      }
    },

    async submitSignedXdr(signedXdr) {
      if (options.forbidSubmit) {
        throw new Error('submitSignedXdr was called — this test forbids sending the money again.')
      }
      enter()
      try {
        submitN += 1
        const { txHash, txSequence } = parseFakeXdr(signedXdr)
        calls.push({ op: 'submit', txHash, at: now() })
        if (options.submitDelayMs) await sleep(options.submitDelayMs)

        const override = options.onSubmit?.({ signedXdr, txHash, call: submitN })
        if (override) return override

        // Idempotent: the exact XDR of a tx already in a ledger ⇒ return the
        // old result, do NOT record a second payment.
        const existing = ledger.get(txHash)
        if (existing) {
          return { ok: true, txHash, ledgerSeq: existing.ledgerSeq, rawResponse: { ledger: existing.ledgerSeq } }
        }

        // The sequence must be the next one, otherwise tx_bad_seq — the real trap.
        if (txSequence !== accountSeq + 1) return badSeq(txHash)

        accountSeq = txSequence
        const ledgerSeq = nextLedger++
        ledger.set(txHash, { ledgerSeq, successful: true })
        payments.push(txHash)
        return { ok: true, txHash, ledgerSeq, rawResponse: { ledger: ledgerSeq, successful: true } }
      } finally {
        leave()
      }
    },

    async pollTransaction(txHash, deadlineMs) {
      pollN += 1
      calls.push({ op: 'poll', txHash, at: now() })

      const override = options.onPoll?.({ txHash, deadlineMs, call: pollN })
      if (override) return override

      const entry = ledger.get(txHash)
      if (entry) {
        return {
          found: true,
          ledgerSeq: entry.ledgerSeq,
          txSuccessful: entry.successful,
          rawResponse: { ledger: entry.ledgerSeq, successful: entry.successful },
        }
      }
      // Not on the ledger: a conclusion is only possible past the deadline.
      return { found: false, reason: now() >= deadlineMs ? 'deadline' : 'not_found' }
    },

    async deadlineMsFromXdr(signedXdr) {
      calls.push({ op: 'deadline', at: now() })
      return parseFakeXdr(signedXdr).deadlineMs
    },
  }

  return {
    port,
    calls,
    ledger,
    payments,
    count: (op) => calls.filter((c) => c.op === op).length,
    get maxConcurrent() {
      return state.maxConcurrent
    },
    putOnLedger: (txHash, ledgerSeq = nextLedger++, successful = true) => {
      ledger.set(txHash, { ledgerSeq, successful })
    },
    accountSequence: () => accountSeq,
  }
}
