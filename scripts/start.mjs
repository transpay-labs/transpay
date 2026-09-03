/**
 * Dispatcher for Railway.
 *
 * Railway CLI 4.x cannot set a per-service start command, and web and worker
 * share one repo. So both services run this same command and `SERVICE_ROLE`
 * decides which process actually comes up.
 *
 *   SERVICE_ROLE=web     → next start   (has PORT, has a public domain)
 *   SERVICE_ROLE=worker  → settlement worker  (no PORT, no domain)
 *
 * Set it wrong or leave it empty and this fails early instead of silently
 * running the wrong role — running two worker instances means going straight
 * back to racing for the treasury's sequence number.
 */
import { spawn } from 'node:child_process'

/** Run a command to completion; reject on a non-zero exit code. */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'inherit' })
    c.on('error', reject)
    c.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exit ${code}`)),
    )
  })
}

const role = process.env.SERVICE_ROLE
const CMDS = {
  web: ['pnpm', ['exec', 'next', 'start', '-p', process.env.PORT ?? '3000']],
  worker: ['pnpm', ['exec', 'tsx', 'src/worker/index.ts']],
}

if (!role || !(role in CMDS)) {
  console.error(
    `start: SERVICE_ROLE must be one of ${Object.keys(CMDS).join(' | ')}, got ${JSON.stringify(role)}`,
  )
  process.exit(1)
}

// Railway's Postgres only listens on the private network and has no public URL —
// so migrations must run FROM THE INSIDE; you cannot migrate from a dev machine.
// Only `web` runs them (the worker running in parallel would race it), and it runs
// them BEFORE Next comes up: if a migration fails, better not to boot at all than
// to serve on the wrong schema.
if (role === 'web') {
  console.log('start: running migrations before opening the web service')
  try {
    await run('pnpm', ['exec', 'tsx', 'src/db/migrate.ts'])
  } catch (err) {
    console.error('start: MIGRATION FAILED — not booting web.', err?.message ?? err)
    process.exit(1)
  }
}

// The worker can come up before web. Wait for the schema instead of crash-looping.
if (role === 'worker') {
  try {
    await run('pnpm', ['exec', 'tsx', 'scripts/wait-for-schema.ts'])
  } catch (err) {
    console.error('start: the schema never appeared — not booting the worker.', err?.message ?? err)
    process.exit(1)
  }
}

const [cmd, args] = CMDS[role]
console.log(`start: SERVICE_ROLE=${role} → ${cmd} ${args.join(' ')}`)

const child = spawn(cmd, args, { stdio: 'inherit' })

// Forward signals so the worker gets a graceful shutdown (it finishes the order
// it is processing before exiting, and releases the advisory lock on the treasury).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => child.kill(sig))
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
