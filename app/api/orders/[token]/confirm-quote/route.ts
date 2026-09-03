/**
 * POST /api/orders/[token]/confirm-quote — quoted -> confirmed.
 *
 * Takes no parameters: the quote is already in the DB, the user merely accepts
 * it. An expired quote ⇒ the domain moves the order to 'expired' and throws ⇒
 * 409 quote_expired.
 */
import { confirmQuote } from '@/src/domain/orders'
import { handle } from '@/app/_lib/http'
import { requireOrderByToken, toPublicOrder } from '@/app/_lib/orders'
import { accessTokenSchema } from '@/app/_lib/schemas'
import type { OrderResponse } from '@/app/_lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle<OrderResponse>(async () => {
    const { token } = await ctx.params
    const order = await requireOrderByToken(accessTokenSchema.parse(token))
    return { order: await toPublicOrder(await confirmQuote(order.id)) }
  })
}
