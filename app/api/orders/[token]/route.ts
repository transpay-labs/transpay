/**
 * GET /api/orders/[token] — read an order by access token.
 *
 * No endpoint reads by reference_id: references are sequential, hence guessable.
 * The response does not contain the access token (see toPublicOrder).
 */
import { handle } from '@/app/_lib/http'
import { requireOrderByToken, toPublicOrder } from '@/app/_lib/orders'
import { accessTokenSchema } from '@/app/_lib/schemas'
import type { OrderResponse } from '@/app/_lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle<OrderResponse>(async () => {
    const { token } = await ctx.params
    const order = await requireOrderByToken(accessTokenSchema.parse(token))
    return { order: await toPublicOrder(order) }
  })
}
