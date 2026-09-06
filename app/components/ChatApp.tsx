'use client'

/**
 * TransPay SIMULATED CHAT INTERFACE.
 *
 * SOW Out-of-Scope #8: NO integration with the API of any commercial messaging
 * platform. This screen only simulates the *form* of a conversation; it uses no
 * platform's name, logo, colors or interface chrome, and it always shows the
 * "simulated" label so screenshots in the evidence pack cannot be mistaken for
 * a real integration. The brand names of such platforms deliberately appear in
 * no file under `app/**` — not even in a comment, because dev builds ship
 * source maps to the browser.
 *
 * Sources of truth:
 *   - Order status: TanStack Query (['order', token]) — a mirror of the server.
 *   - Zustand: only the drafts being typed + the browser session key.
 * The entire transcript below is DERIVED from the server-side order, so
 * reloading the page rebuilds exactly the same conversation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, isPolling } from '@/app/_lib/api-client'
import { STATUS_LABEL, clockTime, usd } from '@/app/_lib/format'
import type { OrderResponse, PublicOrder } from '@/app/_lib/types'
import { emptyRecipientDraft, useChatUi } from '@/app/store/chat-ui'
import { Composer } from './Composer'
import { DepositCard, QuoteCard, RecipientCard, RejectedCard, SettlementCard } from './cards'

/** The TransPay "T" mark from the product deck: dark green stem, bright green flag. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden focusable="false">
      <path fill="#3f9a22" d="M4 4h20v9h-6v23h-9V13H4z" />
      <path fill="#7dd143" d="M24 4h12l-9 9h-9z" />
    </svg>
  )
}

interface ThreadItem {
  key: string
  from: 'agent' | 'user'
  node: React.ReactNode
  time?: string
  /** The node is already a complete .bubble.card; do not wrap it again. */
  card?: boolean
}

function buildThread(order: PublicOrder | null, nowMs: number): ThreadItem[] {
  const items: ThreadItem[] = []

  items.push({
    key: 'greet',
    from: 'agent',
    node: 'Hello, this is the TransPay assistant. How much USD would you like to send to the Philippines?',
  })

  if (!order) return items

  items.push({
    key: 'amount',
    from: 'user',
    node: `I would like to send ${usd(order.usdAmount)}.`,
    time: clockTime(order.createdAt),
  })
  items.push({ key: 'quote-intro', from: 'agent', node: 'Here is the quote for your transfer.' })
  items.push({
    key: 'quote',
    from: 'agent',
    card: true,
    node: <QuoteCard order={order} nowMs={nowMs} />,
  })

  if (order.confirmedAt) {
    items.push({
      key: 'confirm',
      from: 'user',
      node: 'I confirm this rate.',
      time: clockTime(order.confirmedAt),
    })
    items.push({
      key: 'confirm-ack',
      from: 'agent',
      node: 'Rate locked. Please send me the bank account details of the recipient in the Philippines.',
    })
  }

  if (order.recipient) {
    items.push({
      key: 'recipient-msg',
      from: 'user',
      node: `${order.recipient.fullName} — ${order.recipient.bankName} — ${order.recipient.accountNumberMasked}`,
    })
    items.push({ key: 'recipient', from: 'agent', card: true, node: <RecipientCard order={order} /> })
  }

  if (order.deposit) {
    items.push({ key: 'dep-ask', from: 'user', node: 'Please send me the deposit instructions.' })
    items.push({ key: 'dep', from: 'agent', card: true, node: <DepositCard order={order} /> })
  }

  if (order.deposit?.confirmedAt) {
    items.push({
      key: 'dep-done',
      from: 'user',
      node: 'I have made the deposit.',
      time: clockTime(order.deposit.confirmedAt),
    })
    items.push({
      key: 'dep-ack',
      from: 'agent',
      node: 'Deposit recorded. The transfer is being submitted to the Stellar testnet.',
    })
  }

  if (order.status === 'settlement_ready') {
    items.push({
      key: 'queued',
      from: 'agent',
      node: 'The transfer is queued for the settlement worker to pick up. This screen updates itself.',
    })
  }
  if (order.status === 'settling') {
    items.push({
      key: 'settling',
      from: 'agent',
      node: 'Submitting the transaction to the ledger and waiting for confirmation…',
    })
  }

  if (order.settlement) {
    items.push({ key: 'settlement', from: 'agent', card: true, node: <SettlementCard order={order} /> })
  }

  if (order.status === 'settled') {
    items.push({
      key: 'settled',
      from: 'agent',
      node: `Completed. The ledger confirmed the transaction with memo ${order.referenceId}.`,
    })
  }

  if (order.status === 'rejected') {
    items.push({ key: 'rejected', from: 'agent', card: true, node: <RejectedCard order={order} /> })
  }

  if (order.status === 'expired') {
    items.push({
      key: 'expired',
      from: 'agent',
      node: 'The exchange rate expired, so this transfer has stopped. Create a new transaction to get a fresh rate.',
    })
  }

  return items
}

export function ChatApp() {
  const qc = useQueryClient()
  const token = useChatUi((s) => s.accessToken)
  const setAccessToken = useChatUi((s) => s.setAccessToken)
  const resetSession = useChatUi((s) => s.resetSession)
  const [uiError, setUiError] = useState<string | null>(null)

  // persist uses skipHydration ⇒ rehydrate after mount to avoid a hydration mismatch.
  useEffect(() => {
    void useChatUi.persist.rehydrate()
  }, [])

  // Clock for the quote-expiry countdown. Display only, not order state.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const orderQuery = useQuery({
    queryKey: ['order', token],
    queryFn: () => api.getOrder(token as string),
    enabled: Boolean(token),
    // Poll while the order is still in flight (settlement_ready/settling) until settled/rejected.
    refetchInterval: (q) => (isPolling(q.state.data?.order.status) ? 2000 : false),
  })

  // An old localStorage token pointing at a vanished order ⇒ drop the session.
  useEffect(() => {
    const err = orderQuery.error
    if (err instanceof ApiError && err.status === 404) {
      resetSession()
      setUiError('That old transaction link is no longer valid. Please start over.')
    }
  }, [orderQuery.error, resetSession])

  const order = orderQuery.data?.order ?? null

  function apply(data: OrderResponse) {
    qc.setQueryData(['order', token], data)
  }

  function onError(err: unknown) {
    if (err instanceof ApiError) {
      setUiError(err.body.message)
      // A 409 means the client is looking at a stale status — refetch the current one.
      if (err.status === 409) void qc.invalidateQueries({ queryKey: ['order', token] })
    } else {
      setUiError('Could not reach the server. Please try again.')
    }
  }

  const createMut = useMutation({
    mutationFn: (usdAmount: string) => api.createOrder(usdAmount),
    onSuccess: (data) => {
      qc.setQueryData(['order', data.accessToken], { order: data.order })
      // accessToken exists only here and in the local store — it is never logged anywhere.
      setAccessToken(data.accessToken)
      useChatUi.setState({ amountDraft: '' })
    },
    onError,
  })

  const confirmQuoteMut = useMutation({
    mutationFn: () => api.confirmQuote(token as string),
    onSuccess: apply,
    onError,
  })

  const recipientMut = useMutation({
    mutationFn: (r: { fullName: string; bankName: string; accountNumber: string; bankCode?: string }) =>
      api.addRecipient(token as string, r),
    onSuccess: (data) => {
      apply(data)
      useChatUi.setState({ recipientDraft: emptyRecipientDraft })
    },
    onError,
  })

  const depositMut = useMutation({
    mutationFn: () => api.issueDepositReference(token as string),
    onSuccess: apply,
    onError,
  })

  const confirmDepositMut = useMutation({
    mutationFn: () => api.confirmDeposit(token as string),
    onSuccess: apply,
    onError,
  })

  const busy =
    createMut.isPending ||
    confirmQuoteMut.isPending ||
    recipientMut.isPending ||
    depositMut.isPending ||
    confirmDepositMut.isPending

  const run = (fn: () => void) => {
    setUiError(null)
    fn()
  }

  const items = useMemo(() => buildThread(order, nowMs), [order, nowMs])

  // Always scroll to the newest message.
  const threadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length, busy, order?.status])

  const statusPill = order ? (
    <span
      className={
        'pill ' +
        (order.status === 'settled' ? 'ok' : order.status === 'rejected' || order.status === 'expired' ? 'bad' : 'live')
      }
    >
      {STATUS_LABEL[order.status]}
    </span>
  ) : (
    <span className="pill">Simulated</span>
  )

  return (
    <div className="app">
      {/* Mandatory label: this line must be visible in every screenshot. */}
      <div className="demo-banner">
        <strong>Simulated chat interface — TransPay demo.</strong> Not affiliated with, and not
        connected to, any commercial messaging platform.
      </div>

      <header className="header">
        <BrandMark />
        <div className="header-text">
          <div className="header-title">TransPay · USD → PHP</div>
          <div className="header-sub">
            {order ? (
              <>
                Reference ID <span className="mono">{order.referenceId}</span>
              </>
            ) : (
              'Remittance assistant (demo)'
            )}
          </div>
        </div>
        {statusPill}
      </header>

      <div className="thread" ref={threadRef} role="log" aria-live="polite">
        {items.map((item) => (
          <div className={`row ${item.from}`} key={item.key}>
            {item.card ? (
              item.node
            ) : (
              <div className="bubble">
                {item.node}
                {item.time ? <div className="meta">{item.time}</div> : null}
              </div>
            )}
          </div>
        ))}

        {busy ? (
          <div className="row agent">
            <div className="bubble">
              <span className="typing" aria-label="processing">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <Composer
        order={order}
        busy={busy || (orderQuery.isLoading && Boolean(token))}
        errorMessage={uiError}
        onCreate={(amount) => run(() => createMut.mutate(amount))}
        onConfirmQuote={() => run(() => confirmQuoteMut.mutate())}
        onAddRecipient={(r) => run(() => recipientMut.mutate(r))}
        onIssueDeposit={() => run(() => depositMut.mutate())}
        onConfirmDeposit={() => run(() => confirmDepositMut.mutate())}
        onReset={() =>
          run(() => {
            resetSession()
            qc.removeQueries({ queryKey: ['order'] })
          })
        }
      />

      <div className="footer-note">
        Phase 1 demo · Stellar <strong>testnet</strong> · the rate is a fixed number, not sourced
        from the market · every deposit step is simulated.
      </div>
    </div>
  )
}
