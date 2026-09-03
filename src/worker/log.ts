/**
 * STRUCTURED LOGGING — one JSON line per event.
 *
 * Hard constraint: NEVER let a secret or an access_token escape. The worker's
 * logs go into the evidence pack, and an access_token is the key to an order.
 * `redact()` blocks both by FIELD NAME and by VALUE SHAPE (an S...56 seed),
 * because nobody will remember to declare fields added later in the list.
 */

export type LogLevel = 'info' | 'warn' | 'error'

/** Forbidden field names — matched case-insensitively and across underscores. */
const FORBIDDEN_KEY = /(secret|seed|password|access[_-]?token|authorization|api[_-]?key)/i
/** Big but not secret fields: truncated instead of dropped, so logs stay readable. */
const TRUNCATE_KEY = /(signed[_-]?xdr|xdr|raw|horizon[_-]?response)/i
/** A Stellar secret seed. Blocked even when someone stuffs it into a harmless field. */
const SECRET_SEED = /\bS[A-Z2-7]{55}\b/g

const MAX_STRING = 120

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.replace(SECRET_SEED, '[redacted-seed]')
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return { name: value.name, message: redactValue(value.message, depth) }
  if (depth >= 4) return '[depth-limit]'
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1))
  if (typeof value === 'object') return redact(value as Record<string, unknown>, depth + 1)
  return String(value)
}

export function redact(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEY.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    if (TRUNCATE_KEY.test(key) && typeof value === 'string' && value.length > MAX_STRING) {
      out[key] = `${value.slice(0, MAX_STRING)}…(${value.length} chars)`
      continue
    }
    out[key] = redactValue(value, depth)
  }
  return out
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) })
  if (level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

export const consoleLogger: Logger = {
  info: (event, fields = {}) => emit('info', event, fields),
  warn: (event, fields = {}) => emit('warn', event, fields),
  error: (event, fields = {}) => emit('error', event, fields),
}

/** Silent logger — the default in tests, so test output is not littered with JSON. */
export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }
