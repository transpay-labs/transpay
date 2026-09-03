/**
 * POST /api/orders/[token]/recipient — confirmed -> recipient_added.
 *
 * An order has exactly one recipient (unique index recipients_order_id_key); a
 * second call returns 409 invalid_transition from the state machine.
 */
import { addRecipient } from '@/src/domain/orders'
import { handle, readJson } from '@/app/_lib/http'
import { requireOrderByToken, toPublicOrder } from '@/app/_lib/orders'
import { accessTokenSchema, recipientSchema } from '@/app/_lib/schemas'
import type { OrderResponse } from '@/app/_lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle<OrderResponse>(async () => {
    const { token } = await ctx.params
    const order = await requireOrderByToken(accessTokenSchema.parse(token))
    const recipient = recipientSchema.parse(await readJson(req))
    return { order: await toPublicOrder(await addRecipient(order.id, recipient)) }
  })
}
