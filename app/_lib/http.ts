/**
 * ERROR → HTTP MAP for every route handler.
 *
 * Convention:
 *   - 400: bad client input (Zod, an amount that cannot be parsed).
 *   - 404: the token resolves to no order. Deliberately does NOT distinguish
 *     "wrong token" from "order does not exist" — no token probing.
 *   - 409: state conflict (already confirmed, quote expired, duplicate deposit).
 *   - 500: everything else. The body carries only a generic error code; the
 *     details go to the server log.
 *
 * An error body NEVER copies a domain `err.message` verbatim: those messages
 * contain the internal order UUID. Each error code has one fixed, safe sentence.
 */
import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import {
  AmountMismatchError,
  DomainError,
  DuplicateDepositReferenceError,
  InvalidTransitionError,
  OrderMismatchError,
  QuoteExpiredError,
} from '@/src/domain/errors'
import type { ApiErrorBody } from './types'

/** Errors raised by the HTTP layer itself (404, junk input in a path param). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage)
    this.name = 'HttpError'
  }
}

export const notFound = () =>
  new HttpError(404, 'order_not_found', 'No transaction was found for this link.')

function errorResponse(status: number, body: ApiErrorBody): NextResponse<ApiErrorBody> {
  return NextResponse.json(body, {
    status,
    // The response carries data private to one order — never cache it anywhere.
    headers: { 'cache-control': 'no-store' },
  })
}

/** The safe answer for each class of domain error. */
function mapDomainError(err: DomainError): { status: number; body: ApiErrorBody } {
  if (err instanceof InvalidTransitionError) {
    return {
      status: 409,
      body: {
        error: 'invalid_transition',
        message: 'This transaction is no longer at this step. Reload to see the latest status.',
        ...(err.actual ? { currentStatus: err.actual } : {}),
      },
    }
  }
  if (err instanceof QuoteExpiredError) {
    return {
      status: 409,
      body: {
        error: 'quote_expired',
        message: 'The exchange rate has expired. Create a new transaction to get a new rate.',
        currentStatus: 'expired',
      },
    }
  }
  if (err instanceof DuplicateDepositReferenceError) {
    return {
      status: 409,
      body: {
        error: 'duplicate_deposit_reference',
        message: 'This deposit reference has already been used for another transaction.',
        currentStatus: 'rejected',
      },
    }
  }
  if (err instanceof AmountMismatchError) {
    return {
      status: 409,
      body: {
        error: 'mismatched_amount',
        message: 'The deposited amount does not match the quoted amount.',
        currentStatus: 'rejected',
      },
    }
  }
  if (err instanceof OrderMismatchError) {
    return {
      status: 409,
      body: {
        error: 'mismatched_order',
        message: 'This deposit reference does not belong to this transaction.',
        currentStatus: 'rejected',
      },
    }
  }
  // Any other DomainError class (should one be added later) — still a business conflict.
  return {
    status: 409,
    body: { error: err.rejectReason, message: 'This action is not possible in the current state.' },
  }
}

function toResponse(err: unknown): NextResponse<ApiErrorBody> {
  if (err instanceof HttpError) {
    return errorResponse(err.status, { error: err.code, message: err.publicMessage })
  }

  if (err instanceof ZodError) {
    return errorResponse(400, {
      error: 'invalid_input',
      message: 'The submitted data is invalid.',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }

  if (err instanceof DomainError) {
    const { status, body } = mapDomainError(err)
    return errorResponse(status, body)
  }

  // computeQuote / toUnits throw RangeError when an amount cannot be parsed.
  if (err instanceof RangeError) {
    return errorResponse(400, { error: 'invalid_amount', message: 'The amount is invalid.' })
  }

  // Empty body / not JSON.
  if (err instanceof SyntaxError) {
    return errorResponse(400, { error: 'invalid_json', message: 'The body must be valid JSON.' })
  }

  console.error('[api] unexpected error:', err)
  return errorResponse(500, { error: 'internal_error', message: 'Something went wrong on our side. Please try again later.' })
}

/** Wraps a handler body: JSON no-store on success, mapped error on throw. */
export async function handle<T>(fn: () => Promise<T>, okStatus = 200): Promise<NextResponse> {
  try {
    const data = await fn()
    return NextResponse.json(data, {
      status: okStatus,
      headers: { 'cache-control': 'no-store' },
    })
  } catch (err) {
    return toResponse(err)
  }
}

/** JSON body, empty allowed (some steps take no parameters at all). */
export async function readJson(req: Request): Promise<unknown> {
  const raw = await req.text()
  if (!raw.trim()) return {}
  return JSON.parse(raw) as unknown
}
