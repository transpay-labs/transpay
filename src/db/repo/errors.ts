/**
 * Translates raw Postgres errors into TYPED errors.
 *
 * Why this exists: the duplicate-settlement constraint lives in the DB layer (see
 * schema.ts, invariant #3). Upper layers must be able to tell "the DB rejected a
 * duplicate" (routine, recoverable) from "the DB is broken" (must blow up).
 */

/** SQLSTATE 23505 — unique_violation. */
const PG_UNIQUE_VIOLATION = '23505'
/** SQLSTATE 23514 — check_violation. */
const PG_CHECK_VIOLATION = '23514'

/** Error shape of the `postgres` driver (postgres-js). */
type PgErrorLike = {
  code?: string
  constraint_name?: string
  detail?: string
  message?: string
}

function asPgError(e: unknown): PgErrorLike | null {
  if (typeof e !== 'object' || e === null) return null
  const c = (e as PgErrorLike).code
  return typeof c === 'string' ? (e as PgErrorLike) : null
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const pg = asPgError(e)
  if (!pg || pg.code !== PG_UNIQUE_VIOLATION) return false
  return constraint === undefined || pg.constraint_name === constraint
}

export function isCheckViolation(e: unknown, constraint?: string): boolean {
  const pg = asPgError(e)
  if (!pg || pg.code !== PG_CHECK_VIOLATION) return false
  return constraint === undefined || pg.constraint_name === constraint
}

/**
 * The kinds of conflict `insertSubmitted` can hit.
 *   - `duplicate_tx_hash`    : the same tx was already written (repeated submit).
 *   - `active_settlement`    : the order already has a live leg (submitted/confirmed).
 *                              THIS is D2's duplicate-settlement rejection mechanism.
 */
export type SettlementConflictKind = 'duplicate_tx_hash' | 'active_settlement'

export class SettlementConflictError extends Error {
  readonly kind: SettlementConflictKind
  /** Name of the Postgres constraint that blocked it — goes straight into evidence. */
  readonly constraintName: string

  constructor(kind: SettlementConflictKind, constraintName: string, options?: { cause?: unknown }) {
    super(
      kind === 'duplicate_tx_hash'
        ? `duplicate settlement tx_hash (constraint ${constraintName})`
        : `order already has a live settlement leg (constraint ${constraintName})`,
      options,
    )
    this.name = 'SettlementConflictError'
    this.kind = kind
    this.constraintName = constraintName
  }
}

export function isSettlementConflict(e: unknown): e is SettlementConflictError {
  return e instanceof SettlementConflictError
}

/** Constraint names — must match the migration SQL exactly, never guessed. */
export const CONSTRAINTS = {
  settlementsTxHash: 'settlements_tx_hash_key',
  settlementsActiveOrder: 'settlements_active_order_key',
  settlementsMemoFits: 'memo_fits',
  ordersReferenceId: 'transfer_orders_reference_id_key',
  ordersAccessToken: 'transfer_orders_access_token_key',
  ordersReferenceFormat: 'reference_id_format',
  ordersReferenceFitsMemo: 'reference_id_fits_memo',
} as const
