import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set — see .env.example')

/**
 * One connection pool for the whole app. The worker runs in its own process and so
 * gets its own pool; that is deliberate: the worker submits sequentially and never
 * competes for the sequence with web requests.
 */
const client = postgres(url, { max: 10 })

export const db = drizzle(client, { schema })
export { schema }
export type Db = typeof db
