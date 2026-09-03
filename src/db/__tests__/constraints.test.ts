/**
 * INTEGRATION TESTS — proving the constraints live in the DB LAYER, not the app layer.
 *
 * Every case below genuinely tries to write bad data via raw SQL (bypassing Drizzle,
 * bypassing the repo) and then asserts Postgres threw the right SQLSTATE and the right
 * constraint name. If someone drops a constraint from the migration, these go red —
 * no app layer can save it.
 *
 * The test data uses the date 2099-12-31 inside reference_id so it never collides with
 * other agents/tests running concurrently on the same DB, and it cleans up before + after.
 */
import 'dotenv/config'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MEMO_MAX_BYTES } from '@/src/domain/types'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set — see .env.example')

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} })

/** This test file's own namespace. */
const REF_PREFIX = 'TP-PHP-20991231-'
const REF_PREFIX_VND = 'TP-VND-20991231-'
const REF_LIKE = '%-20991231-%'
const TOKEN_PREFIX = 'dbtest2099-token-'
const HASH_PREFIX = 'dbtest2099hash'

const PG_UNIQUE_VIOLATION = '23505'
const PG_CHECK_VIOLATION = '23514'

let seq = 0
const nextRef = () => `${REF_PREFIX}${String(++seq).padStart(4, '0')}`
const nextToken = () => `${TOKEN_PREFIX}${++seq}`
const nextHash = () => `${HASH_PREFIX}${++seq}`

type PgErrorShape = { code?: string; constraint_name?: string; message?: string }

/** Runs fn and returns the error instead of throwing — so the error can be asserted. */
async function capture(fn: () => Promise<unknown>): Promise<PgErrorShape | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e as PgErrorShape
  }
}

async function cleanup() {
  await sql`delete from settlements where order_id in (
    select id from transfer_orders where reference_id like ${REF_LIKE}
  )`
  await sql`delete from transfer_orders where reference_id like ${REF_LIKE}`
  await sql`delete from reference_counters where day = '2099-12-31'`
}

async function insertOrder(
  overrides: Partial<{ referenceId: string; accessToken: string; corridor: 'PHP' | 'VND' }> = {},
) {
  const referenceId = overrides.referenceId ?? nextRef()
  const accessToken = overrides.accessToken ?? nextToken()
  const corridor = overrides.corridor ?? 'PHP'
  const [row] = await sql<{ id: string }[]>`
    insert into transfer_orders (reference_id, access_token, corridor, status, usd_amount)
    values (${referenceId}, ${accessToken}, ${corridor}, 'settlement_ready', '100.0000000')
    returning id
  `
  return { id: row.id, referenceId, accessToken }
}

/** A new leg always starts in the default `submitted` status (exactly what the worker writes). */
async function insertSettlement(
  orderId: string,
  overrides: Partial<{ txHash: string; memo: string }> = {},
) {
  const txHash = overrides.txHash ?? nextHash()
  const memo = overrides.memo ?? 'TP-PHP-20991231-0001'
  const [row] = await sql<{ id: string; status: string }[]>`
    insert into settlements (
      order_id, tx_hash, signed_xdr,
      source_account, destination_account, asset_code, asset_issuer, amount, memo
    ) values (
      ${orderId}, ${txHash}, 'AAAAdGVzdA==',
      'GTREASURY', 'GPAYOUT', 'USDC', 'GISSUER', '100.0000000', ${memo}
    )
    returning id, status
  `
  return { id: row.id, status: row.status, txHash, memo }
}

beforeAll(async () => {
  await cleanup()
})

beforeEach(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await sql.end({ timeout: 5 })
})

// ─── Did the migration actually create the constraints ─────────────────────

describe('the migration created every constraint in the real DB', () => {
  it('has all 3 enums with the right labels', async () => {
    const rows = await sql<{ typname: string; labels: string[] }[]>`
      select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      where t.typname in ('order_status', 'settlement_status', 'corridor')
      group by t.typname
    `
    const byName = Object.fromEntries(rows.map((r) => [r.typname, r.labels]))
    expect(byName['corridor']).toEqual(['PHP', 'VND'])
    expect(byName['settlement_status']).toEqual(['submitted', 'confirmed', 'failed'])
    expect(byName['order_status']).toEqual([
      'draft',
      'quoted',
      'confirmed',
      'recipient_added',
      'awaiting_deposit',
      'settlement_ready',
      'settling',
      'settled',
      'rejected',
      'expired',
    ])
  })

  it('has the mandatory CHECK constraints', async () => {
    const rows = await sql<{ conname: string }[]>`
      select conname from pg_constraint
      where contype = 'c'
        and conrelid in ('transfer_orders'::regclass, 'settlements'::regclass)
    `
    const names = rows.map((r) => r.conname)
    expect(names).toContain('reference_id_format')
    expect(names).toContain('reference_id_fits_memo')
    expect(names).toContain('reference_id_matches_corridor')
    expect(names).toContain('usd_amount_positive')
    expect(names).toContain('memo_fits')
  })

  it('settlements_active_order_key is a PARTIAL unique index with predicate status <> failed', async () => {
    const [row] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'settlements' and indexname = 'settlements_active_order_key'
    `
    expect(row, 'index settlements_active_order_key is missing').toBeTruthy()
    expect(row.indexdef).toMatch(/CREATE UNIQUE INDEX/i)
    expect(row.indexdef).toMatch(/\(order_id\)/)
    // The predicate is what allows a retry after one leg has failed permanently.
    expect(row.indexdef).toMatch(/WHERE \(status <> 'failed'/i)
  })

  it('reference_counters has a composite primary key (corridor, day)', async () => {
    const rows = await sql<{ attname: string }[]>`
      select a.attname
      from pg_constraint c
      join unnest(c.conkey) with ordinality as k(attnum, ord) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.conrelid = 'reference_counters'::regclass and c.contype = 'p'
      order by k.ord
    `
    expect(rows.map((r) => r.attname)).toEqual(['corridor', 'day'])
  })
})

// ─── reference_id ──────────────────────────────────────────────────────────

describe('transfer_orders.reference_id', () => {
  // Group 1: the string still starts with 'TP-PHP-', so only the format regex can fire —
  // the exact constraint name can be asserted.
  it.each([
    ['missing date/seq digits', 'TP-PHP-2026-1'],
    ['seq only 3 digits', 'TP-PHP-20991231-001'],
    ['date only 6 digits', 'TP-PHP-209912-0001'],
    ['extra suffix', 'TP-PHP-20991231-0001-X'],
    ['contains whitespace', 'TP-PHP-20991231-0001 '],
  ])('rejects a malformed reference_id: %s', async (_label, badRef) => {
    const err = await capture(() => insertOrder({ referenceId: badRef }))
    expect(err, `Postgres ACCEPTED a bad reference_id: ${badRef}`).not.toBeNull()
    expect(err!.code).toBe(PG_CHECK_VIOLATION)
    expect(err!.constraint_name).toBe('reference_id_format')
  })

  // Group 2: the prefix itself is wrong ⇒ it violates reference_id_format and
  // reference_id_matches_corridor at the same time. Postgres only reports whichever
  // constraint fired first, so assert only "a CHECK rejected it", not which one.
  it.each([
    ['completely wrong prefix', 'ORDER-1'],
    ['lowercase', 'tp-php-20991231-0001'],
    ['corridor not in the enum', 'TP-USD-20991231-0001'],
    ['empty string', ''],
  ])('rejects a reference_id with a bad prefix: %s', async (_label, badRef) => {
    const err = await capture(() => insertOrder({ referenceId: badRef }))
    expect(err, `Postgres ACCEPTED a bad reference_id: ${badRef}`).not.toBeNull()
    expect(err!.code).toBe(PG_CHECK_VIOLATION)
    expect(['reference_id_format', 'reference_id_matches_corridor']).toContain(
      err!.constraint_name,
    )
  })

  it('rejects a reference_id longer than 28 bytes', async () => {
    const tooLong = `TP-PHP-20991231-0001${'9'.repeat(20)}` // 40 bytes
    expect(Buffer.byteLength(tooLong, 'utf8')).toBeGreaterThan(MEMO_MAX_BYTES)
    const err = await capture(() => insertOrder({ referenceId: tooLong }))
    expect(err, 'Postgres ACCEPTED a reference_id over the memo limit').not.toBeNull()
    expect(err!.code).toBe(PG_CHECK_VIOLATION)
    // The regex blocks it first, so either constraint firing is fine — what has to be
    // proven is that a >28 byte string CANNOT reach the DB. That
    // reference_id_fits_memo exists at all is asserted separately in the migration group.
    expect(['reference_id_format', 'reference_id_fits_memo']).toContain(err!.constraint_name)
  })

  it('accepts a well-formed reference_id', async () => {
    const ok = await insertOrder({ referenceId: `${REF_PREFIX}0042` })
    expect(ok.id).toBeTruthy()
  })

  it('rejects a corridor that disagrees with the corridor inside reference_id', async () => {
    // Order corridor='PHP' but reference 'TP-VND-...': if it got through, that wrong
    // string would go straight into the memo on the ledger and could never be corrected.
    const err = await capture(
      () => insertOrder({ referenceId: `${REF_PREFIX_VND}0001`, corridor: 'PHP' }),
    )
    expect(err, 'a corridor-mismatched reference_id made it into the DB').not.toBeNull()
    expect(err!.code).toBe(PG_CHECK_VIOLATION)
    expect(err!.constraint_name).toBe('reference_id_matches_corridor')
  })

  it('accepts corridor VND when reference_id is TP-VND too', async () => {
    const ok = await insertOrder({ referenceId: `${REF_PREFIX_VND}0002`, corridor: 'VND' })
    expect(ok.id).toBeTruthy()
  })

  it('rejects two orders with the same reference_id', async () => {
    const ref = nextRef()
    await insertOrder({ referenceId: ref })
    const err = await capture(() => insertOrder({ referenceId: ref }))
    expect(err, 'Postgres ACCEPTED a duplicate reference_id').not.toBeNull()
    expect(err!.code).toBe(PG_UNIQUE_VIOLATION)
    expect(err!.constraint_name).toBe('transfer_orders_reference_id_key')
  })

  it('rejects two orders with the same access_token', async () => {
    const token = nextToken()
    await insertOrder({ accessToken: token })
    const err = await capture(() => insertOrder({ accessToken: token }))
    expect(err, 'Postgres ACCEPTED a duplicate access_token').not.toBeNull()
    expect(err!.code).toBe(PG_UNIQUE_VIOLATION)
    expect(err!.constraint_name).toBe('transfer_orders_access_token_key')
  })

  it('rejects usd_amount <= 0', async () => {
    const err = await capture(
      () => sql`
        insert into transfer_orders (reference_id, access_token, corridor, usd_amount)
        values (${nextRef()}, ${nextToken()}, 'PHP', '0')
      `,
    )
    expect(err).not.toBeNull()
    expect(err!.constraint_name).toBe('usd_amount_positive')
  })
})

// ─── settlements ───────────────────────────────────────────────────────────

describe('settlements.tx_hash', () => {
  it('rejects two settlements with the same tx_hash', async () => {
    const a = await insertOrder()
    const b = await insertOrder()
    const hash = nextHash()
    await insertSettlement(a.id, { txHash: hash })

    const err = await capture(() => insertSettlement(b.id, { txHash: hash }))
    expect(err, 'Postgres ACCEPTED a duplicate tx_hash').not.toBeNull()
    expect(err!.code).toBe(PG_UNIQUE_VIOLATION)
    expect(err!.constraint_name).toBe('settlements_tx_hash_key')
  })
})

describe('settlements.memo — must fit MEMO_TEXT at 28 bytes', () => {
  it('rejects a memo longer than 28 bytes (ASCII)', async () => {
    const order = await insertOrder()
    const memo = 'X'.repeat(MEMO_MAX_BYTES + 1)
    const err = await capture(() => insertSettlement(order.id, { memo }))
    expect(err, 'Postgres ACCEPTED a 29 byte memo').not.toBeNull()
    expect(err!.code).toBe(PG_CHECK_VIOLATION)
    expect(err!.constraint_name).toBe('memo_fits')
  })

  it('measures with octet_length, not character count (multi-byte)', async () => {
    const order = await insertOrder()
    // Under the 28 character mark but 30 UTF-8 bytes — a constraint using length() lets it through.
    const memo = '\u0111'.repeat(15)
    expect(memo.length).toBeLessThanOrEqual(MEMO_MAX_BYTES)
    expect(Buffer.byteLength(memo, 'utf8')).toBeGreaterThan(MEMO_MAX_BYTES)
    const err = await capture(() => insertSettlement(order.id, { memo }))
    expect(err, 'the constraint is counting characters instead of bytes').not.toBeNull()
    expect(err!.constraint_name).toBe('memo_fits')
  })

  it('accepts a memo of exactly 28 bytes', async () => {
    const order = await insertOrder()
    const res = await insertSettlement(order.id, { memo: 'Y'.repeat(MEMO_MAX_BYTES) })
    expect(res.id).toBeTruthy()
  })
})

// ─── D2: duplicate settlement defence ──────────────────────────────────────

describe('D2 — 1 order ⇒ at most 1 live settlement leg', () => {
  it('rejects a second settlement while the first is submitted', async () => {
    const order = await insertOrder()
    const first = await insertSettlement(order.id)
    expect(first.status).toBe('submitted') // the column default, per invariant #6

    const err = await capture(() => insertSettlement(order.id))
    expect(err, 'A DUPLICATE SETTLEMENT GOT THROUGH — the D2 constraint is not working').not.toBeNull()
    expect(err!.code).toBe(PG_UNIQUE_VIOLATION)
    expect(err!.constraint_name).toBe('settlements_active_order_key')
  })

  it('rejects a second settlement once the first is confirmed', async () => {
    const order = await insertOrder()
    const first = await insertSettlement(order.id)
    await sql`
      update settlements set status = 'confirmed', ledger_seq = 12345, confirmed_at = now()
      where tx_hash = ${first.txHash}
    `
    const err = await capture(() => insertSettlement(order.id))
    expect(err, 'an already settled order still allowed a new leg').not.toBeNull()
    expect(err!.code).toBe(PG_UNIQUE_VIOLATION)
    expect(err!.constraint_name).toBe('settlements_active_order_key')
  })

  it('ALLOWS a new leg after the old one is marked failed (a legitimate retry)', async () => {
    const order = await insertOrder()
    const first = await insertSettlement(order.id)

    // Before failing: blocked.
    const blocked = await capture(() => insertSettlement(order.id))
    expect(blocked!.constraint_name).toBe('settlements_active_order_key')

    await sql`
      update settlements set status = 'failed', failure_reason = 'tx_timeout'
      where tx_hash = ${first.txHash}
    `

    // After failing: the new leg must get in.
    const retry = await insertSettlement(order.id)
    expect(retry.id).toBeTruthy()

    const rows = await sql<{ status: string }[]>`
      select status from settlements where order_id = ${order.id} order by submitted_at
    `
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'submitted'])
  })

  it('many failed legs at once is still valid, but only 1 live leg', async () => {
    const order = await insertOrder()
    for (let i = 0; i < 3; i++) {
      const leg = await insertSettlement(order.id)
      await sql`update settlements set status = 'failed' where tx_hash = ${leg.txHash}`
    }
    await insertSettlement(order.id) // the first live leg — OK

    const err = await capture(() => insertSettlement(order.id))
    expect(err!.constraint_name).toBe('settlements_active_order_key')

    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from settlements
      where order_id = ${order.id} and status <> 'failed'
    `
    expect(count).toBe('1')
  })
})

// ─── reference_counters ────────────────────────────────────────────────────

describe('reference_counters', () => {
  it('rejects a duplicate (corridor, day)', async () => {
    await sql`insert into reference_counters (corridor, day, next_seq) values ('PHP', '2099-12-31', 1)`
    const err = await capture(
      () => sql`insert into reference_counters (corridor, day, next_seq) values ('PHP', '2099-12-31', 2)`,
    )
    expect(err, 'the composite PK did not block the duplicate').not.toBeNull()
    expect(err!.code).toBe(PG_UNIQUE_VIOLATION)
  })

  it('same day but a different corridor is valid', async () => {
    await sql`insert into reference_counters (corridor, day) values ('PHP', '2099-12-31')`
    await sql`insert into reference_counters (corridor, day) values ('VND', '2099-12-31')`
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from reference_counters where day = '2099-12-31'
    `
    expect(count).toBe('2')
  })
})

// ─── Relationships ─────────────────────────────────────────────────────────

describe('relational constraints', () => {
  it('settlements block deleting an order (on delete restrict) — evidence cannot evaporate', async () => {
    const order = await insertOrder()
    await insertSettlement(order.id)
    const err = await capture(() => sql`delete from transfer_orders where id = ${order.id}`)
    expect(err, 'an order was deleted despite still having a settlement').not.toBeNull()
    expect(err!.code).toBe('23503') // foreign_key_violation
  })

  it('at most 1 recipient per order', async () => {
    const order = await insertOrder()
    await sql`
      insert into recipients (order_id, full_name, bank_name, account_number)
      values (${order.id}, 'Juan Dela Cruz', 'BDO', '000123456')
    `
    const err = await capture(
      () => sql`
        insert into recipients (order_id, full_name, bank_name, account_number)
        values (${order.id}, 'Maria Clara', 'BPI', '000999999')
      `,
    )
    expect(err).not.toBeNull()
    expect(err!.constraint_name).toBe('recipients_order_id_key')
  })

  it('deposit_reference is globally unique', async () => {
    const a = await insertOrder()
    const b = await insertOrder()
    const ref = `DEP-2099-${seq}`
    await sql`
      insert into deposit_references (order_id, deposit_reference, expected_usd_amount)
      values (${a.id}, ${ref}, '100.0000000')
    `
    const err = await capture(
      () => sql`
        insert into deposit_references (order_id, deposit_reference, expected_usd_amount)
        values (${b.id}, ${ref}, '100.0000000')
      `,
    )
    expect(err).not.toBeNull()
    expect(err!.constraint_name).toBe('deposit_references_reference_key')
  })
})
