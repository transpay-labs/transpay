/**
 * CLIENT FETCHER. Imports only from `./types` (type-only), so it does not pull
 * db/stellar into the browser bundle.
 *
 * The access token travels only in this client's own URL path; it is never
 * logged and never sent anywhere else.
 */
import type {
  ApiErrorBody,
  CreateOrderResponse,
  OrderResponse,
  OrderStatus,
} from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message)
    this.name = 'ApiError'
  }
  get code(): string {
    return this.body.error
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  })

  const text = await res.text()
  const parsed: unknown = text ? JSON.parse(text) : {}

  if (!res.ok) {
    const body = parsed as ApiErrorBody
    throw new ApiError(res.status, {
      error: body?.error ?? 'unknown_error',
      message: body?.message ?? 'Something went wrong.',
      currentStatus: body?.currentStatus,
      issues: body?.issues,
    })
  }
  return parsed as T
}

export const api = {
  createOrder: (usdAmount: string) =>
    request<CreateOrderResponse>('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ usdAmount }),
    }),

  getOrder: (token: string) => request<OrderResponse>(`/api/orders/${token}`),

  confirmQuote: (token: string) =>
    request<OrderResponse>(`/api/orders/${token}/confirm-quote`, { method: 'POST' }),

  addRecipient: (
    token: string,
    recipient: { fullName: string; bankName: string; accountNumber: string; bankCode?: string },
  ) =>
    request<OrderResponse>(`/api/orders/${token}/recipient`, {
      method: 'POST',
      body: JSON.stringify(recipient),
    }),

  issueDepositReference: (token: string) =>
    request<OrderResponse>(`/api/orders/${token}/deposit-reference`, { method: 'POST' }),

  // Do not send the amount: the server re-reads it from the DB.
  confirmDeposit: (token: string) =>
    request<OrderResponse>(`/api/orders/${token}/confirm-deposit`, { method: 'POST' }),
}

/** A live status ⇒ the UI must poll until settled/rejected. */
export const POLLING_STATUSES: readonly OrderStatus[] = ['settlement_ready', 'settling']

export function isPolling(status: OrderStatus | undefined): boolean {
  return status !== undefined && POLLING_STATUSES.includes(status)
}
