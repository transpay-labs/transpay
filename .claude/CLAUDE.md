# CLAUDE.md — TransPay Phase 1

Chat-style USD→PHP transfer-order prototype. Each order settles as a real USDC
payment on **Stellar Testnet**, with the order's reference ID carried in the
transaction memo. It is not a money service, not a real messenger, and there is
no real PHP payout — the deliverable is the settlement evidence in `evidence/`.

**When two rules below conflict: safety > correctness > minimality > style.**

---

## 1. Hard rules

These are not style preferences. Each one maps to something that can lose money,
leak a key, or invalidate the delivered evidence.

- **Testnet only.** `src/stellar/config.ts:35` throws unless
  `STELLAR_NETWORK === 'testnet'`. It is a hard block with no escape hatch —
  never add one, never introduce a mainnet Horizon URL or mainnet key.
- **Never print, log, or write a Stellar seed** (`S` + 55 base32 chars) into any
  file, test fixture, commit message, `evidence/` artifact, or your own output.
  `.env`, `.env.secrets`, `.env.secrets.production`, `.env.secrets.screenshots`
  are mode 0600 and hold `STELLAR_ISSUER_SECRET`, `CORRIDOR_TREASURY_SECRET`,
  `CORRIDOR_PAYOUT_SECRET`. Read `.env.example` instead — it documents every
  variable. If you think a key was exposed, stop and say so; it must be rotated.
- **Never `git commit --no-verify`.** `.githooks/pre-commit` is this repo's only
  secrets guardrail (wired by the `prepare` script). Its own failure message
  advertises the bypass — ignore that. If the hook fires, you have a real
  problem to fix.
- **Never commit or push unless asked.** Branch is `main` and the repo is
  PUBLIC. If asked to commit while on `main`, branch first. Never `reset --hard`,
  `checkout .`, `clean -fd`, `stash drop`, force-push, or rebase a pushed commit.
- **Ask before running anything that touches the ledger:** `pnpm
  stellar:bootstrap`, `pnpm evidence:d1`, `pnpm evidence:d2`, `pnpm worker`.
  They consume treasury sequence numbers and write committed artifacts.
  `stellar:bootstrap` in particular mints a *new* corridor and orphans the
  evidence already committed. An evidence corridor is single-use per handover.
- **Never run two workers at once.** `scripts/start.mjs:12` — two instances race
  for the treasury's sequence number. Check for a running one first.
- **`evidence/**` is generated, never hand-edited.** `INDEX.md`, the `d1-*`/`d2-*`
  files, `run.json`, `run.log.jsonl` are all script output in timestamped
  folders. `tx/*.xdr` and `tx/*.horizon.json` are the durable originals —
  Stellar Expert links die at the 2026-12-16 testnet reset.
- **Migrations:** `src/db/migrations/*.sql` is drizzle-kit output and already
  applied. Change `src/db/schema.ts` and run `pnpm db:generate` — never hand-edit
  an applied migration, never `drizzle-kit push`. Confirm `DATABASE_URL` points
  at local Docker before `pnpm db:migrate`; it can point at deployed Railway.
  Never `docker compose down -v`, `DROP`, or `TRUNCATE` without asking.
- **No floats for money, anywhere.** BigInt over the smallest unit at 7 decimals,
  via `src/domain/money.ts`. The UI number, the DB number and the memo number
  must match exactly.
- **The worker settles strictly one order at a time.** The `await` inside the
  `for` loop in `src/worker/index.ts:75` is deliberate. This is a correctness
  constraint on a shared treasury sequence, not a missed optimisation — no
  `Promise.all`, no pool, no concurrency knob.

---

## 2. Commands

pnpm only (`pnpm@10.18.2`), Node `>=22 <25` (`.nvmrc` = 24.13.1). ESM.

```
docker compose up -d --wait   # Postgres on localhost:5434 (NOT 5432)
pnpm install                  # "Ignored build scripts: esbuild" is expected
pnpm db:migrate
pnpm dev                      # web on :3000
pnpm worker                   # settlement worker, separate terminal
pnpm test                     # vitest
pnpm typecheck                # tsc --noEmit — the cheap gate, run before "done"
npx tsx scripts/verify-evidence.ts   # offline evidence re-check, no net, no DB
```

`pnpm dev`, `pnpm worker` and `docker compose up` do not exit — background them,
never block on them, don't leave them running past the session.

**`pnpm start` is not a local start.** It is `scripts/start.mjs`, the Railway
dispatcher, and exits 1 without `SERVICE_ROLE=web|worker`. Local prod serve is
`pnpm build && pnpm start:next`.

**Gotchas that fail late or confusingly:**

- Port 5434 must be changed in **two** places if taken: `docker-compose.yml` and
  `DATABASE_URL` in `.env`.
- `pnpm evidence:d1` drives the real HTTP API, so the web app must already be
  running (`EVIDENCE_BASE_URL`, default `http://localhost:3000`).
- Stop `pnpm worker` before `pnpm evidence:d2` — both compete for the sequence.
- Missing `STELLAR_USDC_ISSUER` fails **silently and late**: orders reach
  `settlement_ready` and the worker logs `worker.settle_threw` forever.
- `pnpm stellar:bootstrap` does not write `.env`; the values are pasted by hand.

---

## 3. Testing reality

12 test files. **7 of them need Postgres up** — they connect at import with no
skip guard, so without Docker you get connection errors, not red tests. Don't
debug your change until you've established which it is.

- Run with no infra: `quote`, `reference-format`, `state`, `token` (in
  `src/domain/__tests__/`) and `worker/__tests__/log`.
- Need Postgres: everything in `src/db/__tests__/`, plus `orders.db`,
  `reference.db`, and `worker/__tests__/{lock,recover,settle}`.
- `fileParallelism: false` and 60s timeouts are deliberate — the DB tests share
  one Postgres.

**`app/` is not collected at all.** `vitest.config.ts` has
`include: ['src/**/*.test.ts']`, and there is no jsdom, Testing Library,
Playwright, or MSW. A test placed under `app/` will be silently ignored.

**Never hit real Horizon from a test.** Settlement code is tested through the
injected `StellarPort` seam (`src/worker/ports.ts`) using
`src/worker/__tests__/fake-stellar.ts`.

Adding test infrastructure is a separate, requested task — don't add it as a
side effect of a bug fix. Propose it and wait.

---

## 4. Layout

```
app/api/orders/**            the 5-call chat flow; order token lives in the path
app/components/ChatApp.tsx   simulated chat UI (not a messenger integration)
app/_lib/http.ts             the ONLY error→HTTP map
src/domain/                  pure logic: state, money, quote, reference, token
src/db/{schema,repo,migrations}
src/stellar/{config,horizon,settlement,accounts,errors}
src/worker/{index,settle,recover,lock,ports,log}
scripts/{bootstrap-accounts,evidence-d1,evidence-d2,verify-evidence,start.mjs}
evidence/                    generated packs, one timestamped folder per run
```

Path alias `@/*` → `./*`, declared in both `tsconfig.json` and
`vitest.config.ts` — they must stay in sync.

---

## 5. Invariants worth knowing before you edit

- **Lifecycle:** `draft → quoted → confirmed → recipient_added →
  awaiting_deposit → settlement_ready → settling → settled`, plus terminal
  `rejected` / `expired`. Transitions are read from `ALLOWED_TRANSITIONS` in
  `src/domain/types.ts` — never copy the table elsewhere.
- **Only a Horizon confirmation may move `settling → settled`.**
- Every transition writes exactly one `order_events` row (`src/domain/state.ts`).
- Reference ID is `TP-{CORRIDOR}-{YYYYMMDD}-{SEQ4}`, must fit MEMO_TEXT's 28
  bytes — **it is the memo**. SEQ4 is allocated in one atomic upsert.
- Error bodies never echo `err.message`: domain messages contain the internal
  order UUID. 404 deliberately does not distinguish wrong-token from no-order.
- The long "why" comment blocks in `src/worker/settle.ts`, `src/stellar/errors.ts`,
  `src/worker/config.ts`, `scripts/start.mjs` and `docker-compose.yml` record
  incidents that already happened. Do not compress or delete them.

Before changing settlement, corridor, or evidence behaviour, read
`README.md` §6 (Known limitations) and §7 (The order lifecycle).

---

## 6. How to work here

**Resolve, then decide, then ask.**
1. Try to answer it yourself first — the code, the 33KB README, `.env.example`,
   the tests, git history. Most ambiguity here is already answered in the repo.
2. Still open? Classify it:
   - *Reversible* (naming, placement, one of two equivalent patterns): pick what
     matches nearby code, state the choice in one line, keep going. Don't ask.
   - *Consequential but recoverable* (API shape, new dependency, schema change):
     take the smallest option, state it up front as an assumption.
   - *Irreversible or dangerous* — anything that moves value on-ledger, touches
     a treasury key, destroys or migrates data, force-pushes, or publishes to
     this public repo: **stop and ask, always**, even if you think you know.
3. In a non-interactive run you may never block. Take the safest reversible
   option and list every open question in the final report.

If a simpler approach exists, say so in one sentence — then keep working. An
objection does not require stopping.

**Minimum code that solves the problem.** No unrequested features, no
abstractions for single-use code, no configurability nobody asked for.

**Don't invent recovery paths for cases that can't occur — but never guess at
"can't occur."** The test is trust, not imagination. Always handle: anything
crossing a trust boundary (HTTP bodies, params, env); anything a network or
ledger returned, *including success-shaped responses carrying a failure inside*,
timeouts, and partial writes; anything two processes can hit at once (constraint
violations, lock contention, sequence numbers); anything where being wrong sends
the money twice. `src/stellar/errors.ts` and `src/worker/settle.ts` exist
entirely for cases that look impossible — read them before deleting a branch you
think is dead. When a state genuinely should be unreachable, fail loudly rather
than inventing a silent recovery. What this rule bans is `try/catch` around pure
local computation and null-checks on values you built three lines above.

**Surgical changes.** Match surrounding style for formatting, naming and idiom,
even if you'd do it differently — *except* for security and correctness: never
reproduce a pattern that mishandles secrets, interpolates untrusted input into
SQL, skips validation at an untrusted boundary, or logs sensitive data. Write it
correctly and say in one line that you deviated. Don't refactor working code or
"improve" adjacent comments. Remove imports and helpers **your** change
orphaned; leave pre-existing dead code and mention it — unless it is dangerous
(an unreferenced path that could move money or sign with a treasury key), in
which case say so explicitly rather than leaving it there.

**Verify with the strongest tool available, and say which one you used:** an
automated test where a harness covers the code; otherwise a script or `curl`
against the locally running app; otherwise a written manual reproduction with
observed before/after. A test written to reproduce a bug is exempt from "every
changed line traces to the request" — it *is* the request. Never edit, skip, or
delete a test to reach green. If you could not verify, say so plainly rather
than reporting success you didn't observe.

**Before reporting done:** run `git diff --stat` and justify every changed file
against the request; revert hunks you can't. Name the command you ran to verify
and what it printed. Flag any touch to a migration, a lockfile, a generated
file, or `evidence/`. Confirm no secret reached a file, a log, or your report.
