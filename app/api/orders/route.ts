/**
 * POST /api/orders — create a transfer order (draft -> quoted).
 *
 * This is the ONLY response that contains `accessToken`. The client must keep
 * it; every later step goes through /api/orders/[token].
 */
import { createOrder } from '@/src/domain/orders'
import { handle, readJson } from '@/app/_lib/http'
import { toPublicOrder } from '@/app/_lib/orders'
import { createOrderSchema } from '@/app/_lib/schemas'
import type { CreateOrderResponse } from '@/app/_lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  return handle<CreateOrderResponse>(async () => {
    const { usdAmount } = createOrderSchema.parse(await readJson(req))

    // The quote (fx, fee, php estimate, expiry) is computed by the domain — never sent by the client.
    const order = await createOrder({ usdAmount })

    return { order: await toPublicOrder(order), accessToken: order.accessToken }
  }, 201)
}
