# D1 — Transfer order creation (USD → PHP) · 10 runs

**Result: 10/10 passed.**

- Run ID: `d1-20260903T081003Z-21f8`
- Started / finished (UTC): 2026-09-03 08:10:03Z → 2026-09-03 08:10:03Z
- Corridor: USD → PHP. The FX rate is a fixed placeholder — Phase 1 does not
  call any market rate provider.
- Distinct USD amounts: 10/10 · distinct banks: 10/10 · distinct account numbers: 10/10
- This table contains **only** the 10 orders created by this run.
  136 other orders currently in the database (earlier smoke tests) were
  filtered out. Nothing was deleted.

## A run counts as passed only when all three conditions hold

1. **The FX quote is correct.** The fee and the PHP estimate are recomputed
   from scratch by an independent calculation inside the evidence script and
   compared against what the database stored. The two must match exactly.
2. **The sender confirmation was recorded.** The order carries a
   `confirmed_at` timestamp *and* a `quoted → confirmed` row in the event log.
3. **The record is complete.** USD amount, PHP estimate, quote (rate, fee,
   expiry), recipient bank details, and reference ID are all present.

No transaction reaches the ledger in D1: the orders stop at the
`awaiting_deposit` state. The real settlements are deliverable D2.

## Table 1 — Quote and sender confirmation

| # | Reference ID | USD amount | FX rate USD→PHP | Fee USD (1%) | PHP estimate | Quote issued (UTC) | Quote expires (UTC) | Sender confirmed (UTC) | Status | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0138 | 25.0000000 | 56.5000000 | 0.2500000 | 1398.38 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 2 | TP-PHP-20260903-0139 | 40.5000000 | 56.5000000 | 0.4050000 | 2265.37 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 3 | TP-PHP-20260903-0140 | 132.7500000 | 56.5000000 | 1.3275000 | 7425.37 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 4 | TP-PHP-20260903-0141 | 6.2500000 | 56.5000000 | 0.0625000 | 349.59 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 5 | TP-PHP-20260903-0142 | 500.0000000 | 56.5000000 | 5.0000000 | 27967.50 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 6 | TP-PHP-20260903-0143 | 77.7700000 | 56.5000000 | 0.7777000 | 4350.06 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 7 | TP-PHP-20260903-0144 | 15.1000000 | 56.5000000 | 0.1510000 | 844.62 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 8 | TP-PHP-20260903-0145 | 260.9000000 | 56.5000000 | 2.6090000 | 14593.44 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 9 | TP-PHP-20260903-0146 | 92.4500000 | 56.5000000 | 0.9245000 | 5171.19 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |
| 10 | TP-PHP-20260903-0147 | 3.9900000 | 56.5000000 | 0.0399000 | 223.18 | 2026-09-03 08:10:03Z | 2026-09-03 08:25:03Z | 2026-09-03 08:10:03Z | awaiting_deposit | PASS |

A quote is valid for 15 minutes from the moment it is issued, and the script checks that exact figure.

## Table 2 — Recipient bank details and deposit reference

| # | Reference ID | Recipient | Bank | Bank code | Account number | Deposit reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0138 | Maria Santos | BDO Unibank | BNORPHMM | 004561230011 | DEP-PHP-20260903-0138-BA23Z81A |
| 2 | TP-PHP-20260903-0139 | Jose Rivera | Bank of the Philippine Islands | BOPIPHMM | 008812457720 | DEP-PHP-20260903-0139-66V3DSM4 |
| 3 | TP-PHP-20260903-0140 | Angelica Dela Cruz | Metropolitan Bank & Trust Co. | MBTCPHMM | 013300998812 | DEP-PHP-20260903-0140-XKE97TST |
| 4 | TP-PHP-20260903-0141 | Ramon Bautista | Land Bank of the Philippines | TLBPPHMM | 019745003366 | DEP-PHP-20260903-0141-0BBGFNWA |
| 5 | TP-PHP-20260903-0142 | Cristina Villanueva | Philippine National Bank | PNBMPHMM | 010288114509 | DEP-PHP-20260903-0142-J2PBYNM1 |
| 6 | TP-PHP-20260903-0143 | Eduardo Mendoza | Security Bank Corporation | SETCPHMM | 000045619982 | DEP-PHP-20260903-0143-MEN8PTN7 |
| 7 | TP-PHP-20260903-0144 | Lorna Aquino | UnionBank of the Philippines | UBPHPHMM | 109933450077 | DEP-PHP-20260903-0144-1YK9M2G8 |
| 8 | TP-PHP-20260903-0145 | Benigno Ocampo | Rizal Commercial Banking Corp. | RCBCPHMM | 450012876341 | DEP-PHP-20260903-0145-Q761YHKR |
| 9 | TP-PHP-20260903-0146 | Imelda Reyes | China Banking Corporation | CHBKPHMM | 201778334455 | DEP-PHP-20260903-0146-BMCTW0BF |
| 10 | TP-PHP-20260903-0147 | Rodrigo Pascual | Development Bank of the Philippines | DBPHPHMM | 077611220034 | DEP-PHP-20260903-0147-PJ50KHES |

Every run uses a different bank, a different account holder and a different
account number. These recipients are **fabricated test data** created for the
evidence pack — Phase 1 connects to no real bank and performs no KYC.

The deposit reference (`DEP-…`) is a **simulated** payment instruction. It is
not the order reference ID and it never appears on the ledger.

## Table 3 — The three conditions, per run

| # | Reference ID | 1. FX quote correct | 2. Sender confirmation recorded | 3. Record complete | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0138 | yes | yes | yes | PASS | — |
| 2 | TP-PHP-20260903-0139 | yes | yes | yes | PASS | — |
| 3 | TP-PHP-20260903-0140 | yes | yes | yes | PASS | — |
| 4 | TP-PHP-20260903-0141 | yes | yes | yes | PASS | — |
| 5 | TP-PHP-20260903-0142 | yes | yes | yes | PASS | — |
| 6 | TP-PHP-20260903-0143 | yes | yes | yes | PASS | — |
| 7 | TP-PHP-20260903-0144 | yes | yes | yes | PASS | — |
| 8 | TP-PHP-20260903-0145 | yes | yes | yes | PASS | — |
| 9 | TP-PHP-20260903-0146 | yes | yes | yes | PASS | — |
| 10 | TP-PHP-20260903-0147 | yes | yes | yes | PASS | — |

## Observed metric (not a pass/fail condition)

- Average time from order creation to sender confirmation: **0.005 seconds**. This is an automated script, so the number reflects machine speed, not user behaviour.

## Files in this folder

| File | Contents |
| --- | --- |
| `d1-orders.md` | This document |
| `d1-orders.csv` | Every column of all three tables, opens in Excel |
| `d1-checks.csv` | The three-condition table on its own |
| `run.json` | Machine-readable record of this run |
| `run.log.jsonl` | Step-by-step log, one JSON object per event |

None of these files contains an order access token or a wallet secret key:
the script scans every byte before writing and aborts if it finds one.
