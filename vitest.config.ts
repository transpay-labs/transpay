import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '')

export default defineConfig({
  // tsconfig maps paths `@/*` -> `./*`; vitest needs the equivalent alias.
  resolve: { alias: { '@': root } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The DB tests share one Postgres, so run files serially to keep them off each other's data.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
