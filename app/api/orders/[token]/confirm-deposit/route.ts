/**
 * POST /api/orders/[token]/confirm-deposit — awaiting_deposit -> settlement_ready.
 *
 * SIMULATES the bank reporting that the USD arrived. The server reads the
 * expected amount from deposit_references itself and does NOT accept an amount
 * from the client — so the mismatched_amount branch cannot be triggered by
 * sending a made-up number.
 *
 * `depositReference` is optional: it defaults to this order's own reference.
 * Sending a different one is allowed so the D2 negative script can simulate
 * "one deposit, two orders"; the UI never sends this field.
 */
import { confirmDeposit } from '@/src/domain/orders'
import { handle, readJson } from '@/app/_lib/http'
import { requireDepositReference, requireOrderByToken, toPublicOrder } from '@/app/_lib/orders'
import { accessTokenSchema, confirmDepositSchema } from '@/app/_lib/schemas'
import { db } from '@/src/db/client'
import { ordersRepo } from '@/src/db/repo'
import type { OrderResponse } from '@/app/_lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle<OrderResponse>(async () => {
    const { token } = await ctx.params
    const order = await requireOrderByToken(accessTokenSchema.parse(token))
    const body = confirmDepositSchema.parse(await readJson(req))

    const depositReference = body.depositReference ?? (await requireDepositReference(order.id))

    // The amount comes from the DB. This is the easiest place to wrongly trust the client — do not.
    const fresh = await ordersRepo.findById(db, order.id)
    if (!fresh) throw new Error('order disappeared mid-request')

    const updated = await confirmDeposit(order.id, {
      depositReference,
      usdAmount: fresh.usdAmount,
    })
    return { order: await toPublicOrder(updated) }
  })
}
