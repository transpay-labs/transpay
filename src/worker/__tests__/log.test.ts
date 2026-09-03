/**
 * Worker logs go straight into the evidence pack. An access token is the key to
 * an order, a secret seed is the power to spend money — neither may escape in
 * even one line. This test guards that door.
 */
import { describe, expect, it } from 'vitest'
import { redact } from '../log'

const FAKE_SEED = `S${'A'.repeat(55)}`

describe('redact', () => {
  it('redacts by field NAME, including deeply nested ones and snake_case variants', () => {
    const out = redact({
      orderId: 'abc',
      accessToken: 'tok_public_url_key',
      access_token: 'tok_2',
      order: { access_token: 'tok_3', referenceId: 'TP-PHP-20260907-0001' },
      CORRIDOR_TREASURY_SECRET: FAKE_SEED,
      apiKey: 'k',
    })

    const dumped = JSON.stringify(out)
    expect(dumped).not.toContain('tok_public_url_key')
    expect(dumped).not.toContain('tok_2')
    expect(dumped).not.toContain('tok_3')
    expect(dumped).not.toContain(FAKE_SEED)
    // What is SAFE has to be kept, otherwise the log is useless.
    expect(dumped).toContain('TP-PHP-20260907-0001')
    expect(out.orderId).toBe('abc')
  })

  it('redacts by value SHAPE — a seed stuffed into a harmless field is still blocked', () => {
    const out = redact({ message: `Keypair.fromSecret(${FAKE_SEED}) failed` })
    expect(JSON.stringify(out)).not.toContain(FAKE_SEED)
    expect(out.message).toContain('[redacted-seed]')
  })

  it('truncates big fields (signed_xdr, horizon response) instead of dropping them', () => {
    const xdr = 'A'.repeat(600)
    const out = redact({ signedXdr: xdr })
    expect(String(out.signedXdr)).toContain('600 chars')
    expect(String(out.signedXdr).length).toBeLessThan(200)
  })

  it('does not blow up on deep nesting / odd types', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } }
    expect(() => JSON.stringify(redact(deep))).not.toThrow()
    const out = redact({ err: new Error(`boom ${FAKE_SEED}`), when: new Date(0), n: 1, ok: true })
    expect(JSON.stringify(out)).not.toContain(FAKE_SEED)
    expect(out.when).toBe('1970-01-01T00:00:00.000Z')
  })
})
