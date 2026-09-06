'use client'

/**
 * The "cards" in the chat flow: quote, recipient, deposit instructions, settlement.
 *
 * Every number here is read straight from the server payload — no component
 * recomputes a rate or a fee.
 */
import { useState } from 'react'
import { REJECT_REASON_LABEL, countdown, dateTime, decimal, php, usd } from '@/app/_lib/format'
import type { PublicOrder } from '@/app/_lib/types'

/** The deck's completed-state hero: pale green disc with a check. */
function SuccessHero({ headline }: { headline: string }) {
  return (
    <div className="card-hero">
      <div className="disc">
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M4 12.5 9.5 18 20 7" />
        </svg>
      </div>
      <div className="headline">{headline}</div>
    </div>
  )
}

/** Highlight box for the strings reviewers must cross-check (reference ID, tx hash). */
export function RefBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked (http, permissions) — the string is still fully visible to copy by hand.
    }
  }

  return (
    <div className="refbox">
      <div className="label">
        {label}
        <button type="button" className="copy" onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div className="value">{value}</div>
      {hint ? <div className="note">{hint}</div> : null}
    </div>
  )
}

function Row({ k, v, big }: { k: string; v: React.ReactNode; big?: boolean }) {
  return (
    <div className="kv">
      <dt>{k}</dt>
      <dd className={big ? 'big' : undefined}>{v}</dd>
    </div>
  )
}

// ─── Quote ─────────────────────────────────────────────────────────────────

export function QuoteCard({ order, nowMs }: { order: PublicOrder; nowMs: number }) {
  return (
    <div className="bubble card">
      <div className="card-title">Quote</div>
      <RefBox
        label="Transaction reference ID"
        value={order.referenceId}
        hint="This string is the memo of the transaction on the Stellar ledger — use it to cross-check."
      />
      <dl style={{ margin: 0 }}>
        <Row k="You send" v={usd(order.usdAmount)} />
        <Row k="Fee (1%)" v={usd(order.feeUsd)} />
        <Row k="Converted" v={usd(order.netUsd)} />
        <Row k="Rate" v={`1 USD = ${decimal(order.fxRate, 4)} PHP`} />
        <Row k="Recipient gets" v={php(order.phpEstimate)} big />
      </dl>
      <div className="note">
        Rate held until {dateTime(order.quoteExpiresAt)} ({countdown(order.quoteExpiresAt, nowMs)}).
        The rate used in this demo is a fixed number, not sourced from the market.
      </div>
    </div>
  )
}

// ─── Recipient ─────────────────────────────────────────────────────────────

export function RecipientCard({ order }: { order: PublicOrder }) {
  const r = order.recipient
  if (!r) return null
  return (
    <div className="bubble card">
      <div className="card-title">Recipient</div>
      <dl style={{ margin: 0 }}>
        <Row k="Full name" v={r.fullName} />
        <Row k="Bank" v={r.bankName} />
        <Row k="Account number" v={<span className="mono">{r.accountNumberMasked}</span>} />
        {r.bankCode ? <Row k="Bank code" v={<span className="mono">{r.bankCode}</span>} /> : null}
      </dl>
    </div>
  )
}

// ─── Deposit instructions (MOCK) ───────────────────────────────────────────

export function DepositCard({ order }: { order: PublicOrder }) {
  const d = order.deposit
  if (!d) return null
  return (
    <div className="bubble card">
      <div className="card-title">USD deposit instructions (simulated)</div>
      <RefBox
        label="Deposit reference"
        value={d.depositReference}
        hint="Put this reference in the transfer description so the system matches the right transaction."
      />
      <dl style={{ margin: 0 }}>
        <Row k="Amount to deposit" v={usd(d.expectedUsdAmount)} big />
      </dl>
      <div className="note">
        The deposit step is <strong>simulated</strong> in this demo: there is no real bank account
        here. Press “I have made the deposit” and the system treats the USD as fully received.
      </div>
    </div>
  )
}

// ─── Settlement ────────────────────────────────────────────────────────────

export function SettlementCard({ order }: { order: PublicOrder }) {
  const s = order.settlement
  if (!s) return null

  const confirmed = s.status === 'confirmed'
  return (
    <div className="bubble card">
      {confirmed ? (
        <SuccessHero headline="On the ledger" />
      ) : (
        <div className="card-title">
          {s.status === 'failed' ? 'Transaction failed' : 'Submitted to the ledger'}
        </div>
      )}
      <RefBox
        label="Transaction hash"
        value={s.txHash}
        hint={`Memo: ${s.memo} — exactly the transaction reference ID above.`}
      />
      <dl style={{ margin: 0 }}>
        <Row k="Amount" v={`${decimal(s.amount)} ${s.assetCode}`} />
        <Row k="Network" v="Stellar testnet" />
        {s.ledgerSeq ? <Row k="Ledger" v={<span className="mono">{s.ledgerSeq}</span>} /> : null}
        <Row k="Submitted at" v={dateTime(s.submittedAt)} />
        {s.confirmedAt ? <Row k="Confirmed at" v={dateTime(s.confirmedAt)} /> : null}
        {s.failureReason ? <Row k="Failure reason" v={s.failureReason} /> : null}
      </dl>
      <a className="explorer" href={s.explorerUrl} target="_blank" rel="noreferrer">
        View on Stellar Expert →
      </a>
    </div>
  )
}

// ─── Unhappy ending ────────────────────────────────────────────────────────

export function RejectedCard({ order }: { order: PublicOrder }) {
  const reason = order.rejectReason
  return (
    <div className="bubble card">
      <div className="card-title">Transaction rejected</div>
      <p style={{ margin: '0 0 6px' }}>
        {(reason && REJECT_REASON_LABEL[reason]) ?? 'This transaction could not continue.'}
      </p>
      <div className="note">
        Reference ID <span className="mono">{order.referenceId}</span> is kept on record for
        cross-checking. No funds reached the ledger.
      </div>
    </div>
  )
}
