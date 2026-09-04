# D1 — Transfer order creation (USD → PHP) · 10 runs

**Result: 10/10 passed.**

- Run ID: `d1-20260903T140328Z-bdfe`
- Started / finished (UTC): 2026-09-03 14:03:28Z → 2026-09-03 14:03:29Z (1.672 s)
- Driven over HTTP against `http://localhost:3000` — **50 requests**, 1628 ms of HTTP time in total.
- Corridor: USD → PHP. The FX rate is a fixed placeholder — Phase 1 does not
  call any market rate provider.
- Distinct USD amounts: 10/10 · distinct banks: 10/10 · distinct account numbers: 10/10
- This table contains **only** the 10 orders created by this run.
  0 other orders currently in the database (earlier smoke tests) were
  filtered out. Nothing was deleted.

## How the run reaches the app

Every order in these tables was created the way the chat interface creates
one: five HTTP requests to the running web app, in the order
`app/components/ChatApp.tsx` issues them through `app/_lib/api-client.ts`.
The script holds no shortcut into the domain layer — it only has an access
token and a URL, exactly like the browser.

| Step | Request | Expected status |
| --- | --- | --- |
| 1. Amount entered, quote issued | `POST /api/orders` | 201 |
| 2. Sender accepts the quote | `POST /api/orders/[token]/confirm-quote` | 200 |
| 3. Recipient bank details | `POST /api/orders/[token]/recipient` | 200 |
| 4. Deposit instructions issued | `POST /api/orders/[token]/deposit-reference` | 200 |
| 5. Read the order back | `GET /api/orders/[token]` | 200 |

Table 4 lists the status every one of those requests actually returned. The
sixth endpoint of the flow, `POST /api/orders/[token]/confirm-deposit`, is
deliberately **not** called: it would move the order to `settlement_ready`,
the worker would settle it, and D1 would spend testnet USDC on a deliverable
that needs no transaction at all.

The `quoted → confirmed` rows in the event log carry actor `user` — the value
the route handler records for a request coming from a client. It is not the
name of this script, which is a further trace that the transition arrived
through the API.

The base URL is configurable (`EVIDENCE_BASE_URL`), so the identical script
and the identical checks can be pointed at a deployed instance.

## A run counts as passed only when all three conditions hold

1. **The FX quote is correct.** The fee and the PHP estimate are recomputed
   from scratch by an independent calculation inside the evidence script and
   compared against what the database stored. The two must match exactly.
2. **The sender confirmation was recorded.** The order carries a
   `confirmed_at` timestamp *and* a `quoted → confirmed` row in the event log.
3. **The record is complete.** USD amount, PHP estimate, quote (rate, fee,
   expiry), recipient bank details, and reference ID are all present.

The figures in the tables below are read from the **database** after the HTTP
flow finished, not from the API responses — so the API and the stored record
have to agree for a run to pass. A disagreement between the two aborts the
whole run instead of scoring a single failure: a broken API contract makes
every row untrustworthy, not just one.

No transaction reaches the ledger in D1: the orders stop at the
`awaiting_deposit` state. The real settlements are deliverable D2.

## Table 1 — Quote and sender confirmation

| # | Reference ID | USD amount | FX rate USD→PHP | Fee USD (1%) | PHP estimate | Quote issued (UTC) | Quote expires (UTC) | Sender confirmed (UTC) | Status | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0001 | 25.0000000 | 56.5000000 | 0.2500000 | 1398.38 | 2026-09-03 14:03:28Z | 2026-09-03 14:18:28Z | 2026-09-03 14:03:28Z | awaiting_deposit | PASS |
| 2 | TP-PHP-20260903-0002 | 40.5000000 | 56.5000000 | 0.4050000 | 2265.37 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |
| 3 | TP-PHP-20260903-0003 | 132.7500000 | 56.5000000 | 1.3275000 | 7425.37 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |
| 4 | TP-PHP-20260903-0004 | 6.2500000 | 56.5000000 | 0.0625000 | 349.59 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |
| 5 | TP-PHP-20260903-0005 | 500.0000000 | 56.5000000 | 5.0000000 | 27967.50 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |
| 6 | TP-PHP-20260903-0006 | 77.7700000 | 56.5000000 | 0.7777000 | 4350.06 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |
| 7 | TP-PHP-20260903-0007 | 15.1000000 | 56.5000000 | 0.1510000 | 844.62 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |
| 8 | TP-PHP-20260903-0008 | 260.9000000 | 56.5000000 | 2.6090000 | 14593.44 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |
| 9 | TP-PHP-20260903-0009 | 92.4500000 | 56.5000000 | 0.9245000 | 5171.19 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |
| 10 | TP-PHP-20260903-0010 | 3.9900000 | 56.5000000 | 0.0399000 | 223.18 | 2026-09-03 14:03:29Z | 2026-09-03 14:18:29Z | 2026-09-03 14:03:29Z | awaiting_deposit | PASS |

A quote is valid for 15 minutes from the moment it is issued, and the script checks that exact figure.

## Table 2 — Recipient bank details and deposit reference

| # | Reference ID | Recipient | Bank | Bank code | Account number | Deposit reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0001 | Maria Santos | BDO Unibank | BNORPHMM | 004561230011 | DEP-PHP-20260903-0001-VSKK9BH8 |
| 2 | TP-PHP-20260903-0002 | Jose Rivera | Bank of the Philippine Islands | BOPIPHMM | 008812457720 | DEP-PHP-20260903-0002-1XPHGRA6 |
| 3 | TP-PHP-20260903-0003 | Angelica Dela Cruz | Metropolitan Bank & Trust Co. | MBTCPHMM | 013300998812 | DEP-PHP-20260903-0003-0ESXXPBE |
| 4 | TP-PHP-20260903-0004 | Ramon Bautista | Land Bank of the Philippines | TLBPPHMM | 019745003366 | DEP-PHP-20260903-0004-2C1H2PT7 |
| 5 | TP-PHP-20260903-0005 | Cristina Villanueva | Philippine National Bank | PNBMPHMM | 010288114509 | DEP-PHP-20260903-0005-TTTWRGQ7 |
| 6 | TP-PHP-20260903-0006 | Eduardo Mendoza | Security Bank Corporation | SETCPHMM | 000045619982 | DEP-PHP-20260903-0006-NEZRVX33 |
| 7 | TP-PHP-20260903-0007 | Lorna Aquino | UnionBank of the Philippines | UBPHPHMM | 109933450077 | DEP-PHP-20260903-0007-3YW6W4R9 |
| 8 | TP-PHP-20260903-0008 | Benigno Ocampo | Rizal Commercial Banking Corp. | RCBCPHMM | 450012876341 | DEP-PHP-20260903-0008-S7KAXMAW |
| 9 | TP-PHP-20260903-0009 | Imelda Reyes | China Banking Corporation | CHBKPHMM | 201778334455 | DEP-PHP-20260903-0009-GTJVQMVC |
| 10 | TP-PHP-20260903-0010 | Rodrigo Pascual | Development Bank of the Philippines | DBPHPHMM | 077611220034 | DEP-PHP-20260903-0010-JTY80A61 |

Every run uses a different bank, a different account holder and a different
account number. These recipients are **fabricated test data** created for the
evidence pack — Phase 1 connects to no real bank and performs no KYC.

The deposit reference (`DEP-…`) is a **simulated** payment instruction. It is
not the order reference ID and it never appears on the ledger.

## Table 3 — The three conditions, per run

| # | Reference ID | 1. FX quote correct | 2. Sender confirmation recorded | 3. Record complete | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0001 | yes | yes | yes | PASS | — |
| 2 | TP-PHP-20260903-0002 | yes | yes | yes | PASS | — |
| 3 | TP-PHP-20260903-0003 | yes | yes | yes | PASS | — |
| 4 | TP-PHP-20260903-0004 | yes | yes | yes | PASS | — |
| 5 | TP-PHP-20260903-0005 | yes | yes | yes | PASS | — |
| 6 | TP-PHP-20260903-0006 | yes | yes | yes | PASS | — |
| 7 | TP-PHP-20260903-0007 | yes | yes | yes | PASS | — |
| 8 | TP-PHP-20260903-0008 | yes | yes | yes | PASS | — |
| 9 | TP-PHP-20260903-0009 | yes | yes | yes | PASS | — |
| 10 | TP-PHP-20260903-0010 | yes | yes | yes | PASS | — |

## Table 4 — HTTP status of every step

| # | Reference ID | POST /api/orders | POST …/confirm-quote | POST …/recipient | POST …/deposit-reference | GET /api/orders/[token] | Status read back from the API | order_events actor | HTTP time, 5 calls (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0001 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 1143 |
| 2 | TP-PHP-20260903-0002 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 69 |
| 3 | TP-PHP-20260903-0003 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 60 |
| 4 | TP-PHP-20260903-0004 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 50 |
| 5 | TP-PHP-20260903-0005 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 48 |
| 6 | TP-PHP-20260903-0006 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 55 |
| 7 | TP-PHP-20260903-0007 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 48 |
| 8 | TP-PHP-20260903-0008 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 58 |
| 9 | TP-PHP-20260903-0009 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 45 |
| 10 | TP-PHP-20260903-0010 | 201 | 200 | 200 | 200 | 200 | awaiting_deposit | user | 52 |

The access token itself appears in none of these files: it travels only in
the request URL, and every route printed here is the token-free template.

## Observed metric (not a pass/fail condition)

- Average time from order creation to sender confirmation: **0.046 seconds**. This is an automated script talking to a local server, so the number reflects machine and network speed, not user behaviour.

## Files in this folder

| File | Contents |
| --- | --- |
| `d1-orders.md` | This document |
| `d1-orders.csv` | Every column of all four tables, opens in Excel |
| `d1-checks.csv` | The three-condition table on its own |
| `d1-http.csv` | The HTTP status of each of the 50 requests, per order |
| `run.json` | Machine-readable record of this run, including the base URL |
| `run.log.jsonl` | Step-by-step log, one JSON object per event and per request |

None of these files contains an order access token or a wallet secret key:
the script scans every byte before writing and aborts if it finds one.
