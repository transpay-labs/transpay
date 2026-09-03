import { describe, expect, it } from 'vitest'
import { InvalidTransitionError } from '@/src/domain/errors'
import { assertTransition, canTransition, isTerminal } from '@/src/domain/state'
import { ALLOWED_TRANSITIONS, ORDER_STATUSES, TERMINAL_STATUSES } from '@/src/domain/types'

describe('state machine (pure, no DB)', () => {
  it('canTransition matches ALLOWED_TRANSITIONS across the whole matrix', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to)).toBe(ALLOWED_TRANSITIONS[from].includes(to))
      }
    }
  })

  it('a terminal status goes nowhere, not even back to itself', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true)
      expect(ALLOWED_TRANSITIONS[status]).toHaveLength(0)
      for (const to of ORDER_STATUSES) expect(canTransition(status, to)).toBe(false)
    }
  })

  it('no status has a self-transition', () => {
    for (const status of ORDER_STATUSES) expect(canTransition(status, status)).toBe(false)
  })

  it('the full happy path draft -> settled is legal at every step', () => {
    const path = [
      'draft',
      'quoted',
      'confirmed',
      'recipient_added',
      'awaiting_deposit',
      'settlement_ready',
      'settling',
      'settled',
    ] as const
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true)
    }
  })

  it('assertTransition throws InvalidTransitionError carrying a RejectReason', () => {
    expect(() => assertTransition('quoted', 'settled')).toThrowError(InvalidTransitionError)
    try {
      assertTransition('draft', 'settling')
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError)
      const e = err as InvalidTransitionError
      expect(e.from).toBe('draft')
      expect(e.to).toBe('settling')
      expect(e.rejectReason).toBe('invalid_transition')
    }
    expect.assertions(5)
  })

  it('assertTransition stays silent when the transition is legal', () => {
    expect(() => assertTransition('awaiting_deposit', 'settlement_ready')).not.toThrow()
  })

  it('every non-terminal status has a path to an end state', () => {
    for (const status of ORDER_STATUSES) {
      if (TERMINAL_STATUSES.includes(status)) continue
      expect(ALLOWED_TRANSITIONS[status].length).toBeGreaterThan(0)
    }
  })
})
