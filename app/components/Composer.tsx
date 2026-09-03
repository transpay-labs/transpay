'use client'

/**
 * The input area of the chat flow. Its shape is DERIVED from the order status on
 * the server — no "current step" variable is kept in parallel on the client.
 *
 * Zustand only holds the drafts being typed (amount, recipient form).
 */
import { emptyRecipientDraft, useChatUi } from '@/app/store/chat-ui'
import type { PublicOrder } from '@/app/_lib/types'

export interface ComposerProps {
  order: PublicOrder | null
  busy: boolean
  errorMessage: string | null
  onCreate: (usdAmount: string) => void
  onConfirmQuote: () => void
  onAddRecipient: (r: { fullName: string; bankName: string; accountNumber: string; bankCode?: string }) => void
  onIssueDeposit: () => void
  onConfirmDeposit: () => void
  onReset: () => void
}

export function Composer(props: ComposerProps) {
  const { order, busy, errorMessage } = props
  const amountDraft = useChatUi((s) => s.amountDraft)
  const setAmountDraft = useChatUi((s) => s.setAmountDraft)
  const recipientDraft = useChatUi((s) => s.recipientDraft)
  const setRecipientDraft = useChatUi((s) => s.setRecipientDraft)

  const status = order?.status ?? null
  const err = errorMessage ? <div className="error">{errorMessage}</div> : null

  // ── No order yet: enter the USD amount ─────────────────────────────────
  if (!order) {
    const ok = /^\d+(\.\d{1,7})?$/.test(amountDraft.trim()) && Number(amountDraft) > 0
    return (
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok && !busy) props.onCreate(amountDraft.trim())
        }}
      >
        {err}
        <div className="composer-hint">Enter the USD amount you want to send (for example 500)</div>
        <div className="field-row">
          <input
            type="text"
            inputMode="decimal"
            placeholder="500"
            aria-label="USD amount"
            value={amountDraft}
            onChange={(e) => setAmountDraft(e.target.value)}
            disabled={busy}
          />
          <button className="btn" type="submit" disabled={!ok || busy}>
            Send
          </button>
        </div>
      </form>
    )
  }

  // ── Quote issued: confirm it ───────────────────────────────────────────
  if (status === 'quoted') {
    return (
      <div className="composer">
        {err}
        <div className="composer-hint">Do you accept the rate and fee above?</div>
        <div className="field-row">
          <button className="btn" type="button" disabled={busy} onClick={props.onConfirmQuote}>
            Confirm rate
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={props.onReset}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // ── Rate locked: enter the recipient ───────────────────────────────────
  if (status === 'confirmed') {
    const d = recipientDraft
    const ok =
      d.fullName.trim().length >= 2 &&
      d.bankName.trim().length >= 2 &&
      d.accountNumber.replace(/[\s-]/g, '').length >= 4
    return (
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          if (!ok || busy) return
          props.onAddRecipient({
            fullName: d.fullName,
            bankName: d.bankName,
            accountNumber: d.accountNumber,
            bankCode: d.bankCode.trim() || undefined,
          })
        }}
      >
        {err}
        <div className="composer-hint">Bank account details of the recipient in the Philippines</div>
        <div className="field-row">
          <input
            type="text"
            placeholder="Recipient full name"
            aria-label="Recipient full name"
            value={d.fullName}
            onChange={(e) => setRecipientDraft({ fullName: e.target.value })}
            disabled={busy}
          />
        </div>
        <div className="field-row">
          <input
            type="text"
            placeholder="Bank name"
            aria-label="Bank name"
            value={d.bankName}
            onChange={(e) => setRecipientDraft({ bankName: e.target.value })}
            disabled={busy}
          />
        </div>
        <div className="field-row wrap">
          <input
            type="text"
            placeholder="Account number"
            aria-label="Account number"
            value={d.accountNumber}
            onChange={(e) => setRecipientDraft({ accountNumber: e.target.value })}
            disabled={busy}
          />
          <input
            type="text"
            placeholder="Bank code (optional)"
            aria-label="Bank code"
            value={d.bankCode}
            onChange={(e) => setRecipientDraft({ bankCode: e.target.value })}
            disabled={busy}
            style={{ maxWidth: 150 }}
          />
        </div>
        <button className="btn block" type="submit" disabled={!ok || busy}>
          Send recipient details
        </button>
      </form>
    )
  }

  // ── Recipient added: ask for the deposit instructions ──────────────────
  if (status === 'recipient_added') {
    return (
      <div className="composer">
        {err}
        <button className="btn block" type="button" disabled={busy} onClick={props.onIssueDeposit}>
          Get deposit instructions
        </button>
      </div>
    )
  }

  // ── Awaiting deposit: simulate having deposited ────────────────────────
  if (status === 'awaiting_deposit') {
    return (
      <div className="composer">
        {err}
        <div className="composer-hint">
          The deposit step is simulated — the amount it is checked against is re-read by the server from the database.
        </div>
        <button className="btn block" type="button" disabled={busy} onClick={props.onConfirmDeposit}>
          I have made the deposit
        </button>
      </div>
    )
  }

  // ── Settling: nothing to enter, just wait ──────────────────────────────
  if (status === 'settlement_ready' || status === 'settling') {
    return (
      <div className="composer">
        {err}
        <div className="composer-hint">
          Processing on the Stellar testnet. This screen updates itself once the ledger confirms.
        </div>
        <button className="btn block" type="button" disabled>
          Waiting for the ledger…
        </button>
      </div>
    )
  }

  // ── Finished (settled / rejected / expired) ────────────────────────────
  return (
    <div className="composer">
      {err}
      <button
        className="btn block"
        type="button"
        onClick={() => {
          useChatUi.setState({ recipientDraft: emptyRecipientDraft })
          props.onReset()
        }}
      >
        Start a new transaction
      </button>
    </div>
  )
}
