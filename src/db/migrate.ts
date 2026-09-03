import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set — see .env.example')

const client = postgres(url, { max: 1 })

await migrate(drizzle(client), { migrationsFolder: './src/db/migrations' })
await client.end()

console.log('migrations applied')
