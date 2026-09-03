/**
 * POST /api/orders/[token]/deposit-reference — recipient_added -> awaiting_deposit.
 *
 * Issues the USD deposit instructions (MOCK). This is NOT the settlement, only
 * the trigger — the expected amount comes from the order in the DB, never from
 * the client.
 */
import { issueDepositReference } from '@/src/domain/orders'
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
    const { order: updated } = await issueDepositReference(order.id)
    // depositReference travels inside PublicOrder.deposit — it is not returned separately.
    return { order: await toPublicOrder(updated) }
  })
}
