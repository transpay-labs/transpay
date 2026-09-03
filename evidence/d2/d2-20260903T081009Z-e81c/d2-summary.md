# D2 — Settlement on Stellar Testnet

**Positive group: 10/10 real USDC transactions confirmed on the ledger.**  
**Negative group: 5/5 attempts correctly rejected, transactions produced: 0.**

- Run ID: `d2-20260903T081009Z-e81c`
- Started / finished (UTC): 2026-09-03 08:10:09Z → 2026-09-03 08:13:08Z
- Network: Stellar **Testnet** · Horizon `https://horizon-testnet.stellar.org`
- Asset: `USDC`, issuer `GD3WPI6M3JVWL66FPNC5SAPTBF4SRFZ4VEBVYG22Q2EAVQFVH5WBH7HF`
- USD-side treasury (money leaves here): [`GALWUJLFFNJ6FGL6LMHNEA7SVZ7IWSP3FROQRF5RESDIR5MBQH4U4CBX`](https://stellar.expert/explorer/testnet/account/GALWUJLFFNJ6FGL6LMHNEA7SVZ7IWSP3FROQRF5RESDIR5MBQH4U4CBX)
- PHP-side payout float (money arrives here): [`GCQQLXJEP3DRCNY6JYUMYAR7BM6WU34XG42W2BPSYPVMORTTVY3VMPK3`](https://stellar.expert/explorer/testnet/account/GCQQLXJEP3DRCNY6JYUMYAR7BM6WU34XG42W2BPSYPVMORTTVY3VMPK3)
- This document contains **only** the orders created by this run. Older orders
  in the database (smoke tests and earlier runs) were filtered out, not deleted.

> **The two numbers must not be added together.** A negative case is rejected
> *before* any transaction is built, so it cannot have a transaction hash and
> is not part of the positive group’s 10/10. The original SOW merged the two
> counts and contradicted itself; this report keeps them apart.

---

## POSITIVE group — 10 real USDC transactions

Passes when: a real USDC transaction exists on Testnet, its hash is bound to
the right order (the memo on the ledger equals the order reference ID), and a
Stellar Expert link is available.

| # | Reference ID | Memo on ledger | Memo = Reference ID | USD ordered | USDC settled | Ledger seq | Ledger time (UTC) | Tx hash | Stellar Expert | Order status | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0148 | TP-PHP-20260903-0148 | yes | 11.0000000 | 10.8900000 | 4479892 | 2026-09-03 08:10:47Z | 1edf2371…0be73201 | [open](https://stellar.expert/explorer/testnet/tx/1edf2371e625eb3788e6f7f320ea4508336ade7f2a408b97644dabf90be73201) | settled | PASS |
| 2 | TP-PHP-20260903-0149 | TP-PHP-20260903-0149 | yes | 23.5000000 | 23.2650000 | 4479894 | 2026-09-03 08:10:57Z | ae441cc0…91e536c8 | [open](https://stellar.expert/explorer/testnet/tx/ae441cc0c081b3cc4d240918e2a646002c44d349d0946f28ed58f21791e536c8) | settled | PASS |
| 3 | TP-PHP-20260903-0150 | TP-PHP-20260903-0150 | yes | 47.2500000 | 46.7775000 | 4479897 | 2026-09-03 08:11:12Z | 2b478234…27c6636a | [open](https://stellar.expert/explorer/testnet/tx/2b4782345e2cac79de82d96221715f751512a3d90c6be8dd3e6840fe27c6636a) | settled | PASS |
| 4 | TP-PHP-20260903-0151 | TP-PHP-20260903-0151 | yes | 8.7500000 | 8.6625000 | 4479902 | 2026-09-03 08:11:37Z | 3fa00115…650e130d | [open](https://stellar.expert/explorer/testnet/tx/3fa0011558b1f170a5ada4d06bd58ce8a874d05b784c307622d5a405650e130d) | settled | PASS |
| 5 | TP-PHP-20260903-0152 | TP-PHP-20260903-0152 | yes | 156.4000000 | 154.8360000 | 4479904 | 2026-09-03 08:11:47Z | afaae5bd…931398a4 | [open](https://stellar.expert/explorer/testnet/tx/afaae5bd006c33c2157ca98a0c5856d67864981f6ba7ae7857bf42c3931398a4) | settled | PASS |
| 6 | TP-PHP-20260903-0153 | TP-PHP-20260903-0153 | yes | 99.9900000 | 98.9901000 | 4479908 | 2026-09-03 08:12:07Z | ddba85c4…7e092f21 | [open](https://stellar.expert/explorer/testnet/tx/ddba85c4ae850c6a3a616929f4f4c747a8fcef5e40f801a668b4f0317e092f21) | settled | PASS |
| 7 | TP-PHP-20260903-0154 | TP-PHP-20260903-0154 | yes | 5.5000000 | 5.4450000 | 4479911 | 2026-09-03 08:12:22Z | dd6eef6d…ce295806 | [open](https://stellar.expert/explorer/testnet/tx/dd6eef6d17c31e6f054ae16b1cab3baa6b7e8d1647310cbe97b34c9dce295806) | settled | PASS |
| 8 | TP-PHP-20260903-0155 | TP-PHP-20260903-0155 | yes | 302.1000000 | 299.0790000 | 4479913 | 2026-09-03 08:12:32Z | 94c5d417…a228cb02 | [open](https://stellar.expert/explorer/testnet/tx/94c5d417b9dc07c5d035e85f000a3051022c1143879e6a2c97e4fd97a228cb02) | settled | PASS |
| 9 | TP-PHP-20260903-0156 | TP-PHP-20260903-0156 | yes | 64.3300000 | 63.6867000 | 4479915 | 2026-09-03 08:12:42Z | 3883d280…11df94b5 | [open](https://stellar.expert/explorer/testnet/tx/3883d28076e593890dd7921487adb9cf7fb1f557de1991f03ba33f3111df94b5) | settled | PASS |
| 10 | TP-PHP-20260903-0157 | TP-PHP-20260903-0157 | yes | 18.6800000 | 18.4932000 | 4479918 | 2026-09-03 08:12:57Z | bea9145e…a320b624 | [open](https://stellar.expert/explorer/testnet/tx/bea9145e65b74cded8741057c307765a943156de169af04e8b3f873fa320b624) | settled | PASS |

**`Memo = Reference ID` is the most important column in this deliverable.** The
memo lives on the public ledger, not in the builder’s database. It is the point
at which a transaction proves for itself which order it belongs to.

The `USDC settled` figure is the USD amount **after** the 1% fee is
deducted — the part that is actually converted to PHP — not the gross amount.

### Local originals (these survive the testnet reset on 2026-12-16)

| # | Reference ID | Full transaction hash | Raw signed XDR | Horizon JSON |
| --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0148 | `1edf2371e625eb3788e6f7f320ea4508336ade7f2a408b97644dabf90be73201` | `tx/TP-PHP-20260903-0148.xdr` | `tx/TP-PHP-20260903-0148.horizon.json` |
| 2 | TP-PHP-20260903-0149 | `ae441cc0c081b3cc4d240918e2a646002c44d349d0946f28ed58f21791e536c8` | `tx/TP-PHP-20260903-0149.xdr` | `tx/TP-PHP-20260903-0149.horizon.json` |
| 3 | TP-PHP-20260903-0150 | `2b4782345e2cac79de82d96221715f751512a3d90c6be8dd3e6840fe27c6636a` | `tx/TP-PHP-20260903-0150.xdr` | `tx/TP-PHP-20260903-0150.horizon.json` |
| 4 | TP-PHP-20260903-0151 | `3fa0011558b1f170a5ada4d06bd58ce8a874d05b784c307622d5a405650e130d` | `tx/TP-PHP-20260903-0151.xdr` | `tx/TP-PHP-20260903-0151.horizon.json` |
| 5 | TP-PHP-20260903-0152 | `afaae5bd006c33c2157ca98a0c5856d67864981f6ba7ae7857bf42c3931398a4` | `tx/TP-PHP-20260903-0152.xdr` | `tx/TP-PHP-20260903-0152.horizon.json` |
| 6 | TP-PHP-20260903-0153 | `ddba85c4ae850c6a3a616929f4f4c747a8fcef5e40f801a668b4f0317e092f21` | `tx/TP-PHP-20260903-0153.xdr` | `tx/TP-PHP-20260903-0153.horizon.json` |
| 7 | TP-PHP-20260903-0154 | `dd6eef6d17c31e6f054ae16b1cab3baa6b7e8d1647310cbe97b34c9dce295806` | `tx/TP-PHP-20260903-0154.xdr` | `tx/TP-PHP-20260903-0154.horizon.json` |
| 8 | TP-PHP-20260903-0155 | `94c5d417b9dc07c5d035e85f000a3051022c1143879e6a2c97e4fd97a228cb02` | `tx/TP-PHP-20260903-0155.xdr` | `tx/TP-PHP-20260903-0155.horizon.json` |
| 9 | TP-PHP-20260903-0156 | `3883d28076e593890dd7921487adb9cf7fb1f557de1991f03ba33f3111df94b5` | `tx/TP-PHP-20260903-0156.xdr` | `tx/TP-PHP-20260903-0156.horizon.json` |
| 10 | TP-PHP-20260903-0157 | `bea9145e65b74cded8741057c307765a943156de169af04e8b3f873fa320b624` | `tx/TP-PHP-20260903-0157.xdr` | `tx/TP-PHP-20260903-0157.horizon.json` |

Paths are relative to this run folder. After **16 December 2026** the Stellar
Testnet is reset: Horizon history is wiped and every Stellar Expert link above
returns 404. The two files kept here per transaction are the originals that do
not depend on the network — the raw signed XDR (the exact signed bytes, which
hash back to the transaction hash in the table) and the full Horizon JSON
captured at confirmation time (ledger sequence, timestamp, memo,
source/destination, amount).

To re-check them with no network and no database:

```
npx tsx scripts/verify-evidence.ts
```

---

## NEGATIVE group — 5 attempts that must be rejected

3 duplicate deposit references + 2 mismatched amount / mismatched order.

Passes when: the order is **rejected**, **no transaction is produced**, and the
rejection is logged.

| # | Group | What was submitted | Order reference | Final status | Reject reason | Settlement tx created | Reject logged | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | duplicate reference | Re-submitted the deposit reference already used by positive order #1 | TP-PHP-20260903-0159 | rejected | duplicate_deposit_reference | 0 | yes | PASS |
| 2 | duplicate reference | Re-submitted the deposit reference already used by positive order #2 | TP-PHP-20260903-0160 | rejected | duplicate_deposit_reference | 0 | yes | PASS |
| 3 | duplicate reference | Re-submitted the deposit reference already used by positive order #3 | TP-PHP-20260903-0161 | rejected | duplicate_deposit_reference | 0 | yes | PASS |
| 4 | mismatched amount/order | The order's own deposit reference, but the amount paid in is 5.00 USD too high | TP-PHP-20260903-0162 | rejected | mismatched_amount | 0 | yes | PASS |
| 5 | mismatched amount/order | A deposit reference belonging to a different order (never used before) | TP-PHP-20260903-0163 | rejected | mismatched_order | 0 | yes | PASS |

- Settlement legs produced by these 5 cases: **0**.
- Payout float USDC balance before and after the negative group: `730.1250000` → `730.1250000` (change: `0.0000000`).
- The per-case log is in `run.log.jsonl` under the event `d2.negative_rejected`,
  including the exact string that was submitted and the error the system returned.

One helper order was created separately so that an **unused** deposit reference
existed for the "mismatched order" case (`TP-PHP-20260903-0158`). It is not one
of the 5 cases and it produced no transaction.

---

## Reconciling the ledger against the database

This corridor was created fresh, and the payout float started at **exactly
zero USDC** with no payment history at all. That makes the strongest form
of reconciliation available: **the balance you can read off the public block
explorer right now must equal the sum of the amounts in the table above.** You do
not have to trust any "before" or "after" figure supplied by us.

| Measure | Value |
| --- | --- |
| Payout float balance when this corridor was created | `0.0000000` — exactly zero |
| Total USDC across the 10 positive legs of this run (per the database) | `730.1250000` |
| Total USDC across **every** confirmed leg recorded for this corridor (per the database) | `730.1250000` (10 legs) |
| **Payout float balance on the ledger right now** | **`730.1250000`** |
| **Absolute balance matches the database?** | **EXACT MATCH** |
| Incoming USDC payments in the payout float's entire ledger history | **10** payments, totalling `730.1250000` |
| Confirmed legs for this corridor in the database | **10** legs, totalling `730.1250000` |
| **Every credit on the ledger accounted for by the database?** | **YES — payment for payment, no unexplained inflow** |
| Other operations in the payout float's history | `create_account` |

### Second, independent check: the change in balance

| Measure | Value |
| --- | --- |
| Payout float before the 10 positive legs | `0.0000000` |
| Payout float after the 10 positive legs | `730.1250000` |
| Change on the ledger | `730.1250000` |
| Money **in** matches the database? | **EXACT MATCH** |
| Treasury balance before / after | `100000.0000000` → `99269.8750000` (change `-730.1250000`) |
| Money **out** matches the database? | **EXACT MATCH** |
| Change during the negative group | `0.0000000` |

The treasury loses exactly what the payout float gains, which is also the point
made in section 5 of the README: these are two accounts in two different roles,
not one account paying itself.

Stellar network fees are paid in XLM, not in USDC, so every figure above matches
exactly to 7 decimal places with no fee residue.

The absolute comparison is made against **every** confirmed leg recorded for this
corridor, not only the ten in this run, so it stays correct if the evidence
scripts are run again. Legs belonging to earlier, retired corridors are still in
the database and are excluded by destination account and asset issuer — they are
filtered out, not deleted.

The balance is checked **payment by payment**, not just as a total. The script
reads the payout float's entire incoming payment history from the ledger and
requires the number of credits and their sum to equal the legs recorded in the
database. A matching total alone would not be enough: a single stray payment from
somewhere else would break the claim that this account received nothing but the
settlements in this report, and only an operation-by-operation comparison catches
that. This check is the reason the previous corridor was retired — see
limitation 6 in the README.

### How to check this yourself in one step

Open the payout float on the block explorer — [`GCQQLXJEP3DRCNY6JYUMYAR7BM6WU34XG42W2BPSYPVMORTTVY3VMPK3`](https://stellar.expert/explorer/testnet/account/GCQQLXJEP3DRCNY6JYUMYAR7BM6WU34XG42W2BPSYPVMORTTVY3VMPK3) —
read its USDC balance, and compare it with `730.1250000` above.
The account has received nothing else, ever, so the two numbers can only agree if
the settlements in this report are exactly the transactions that happened.

---

## Observed metric — NOT a pass/fail condition

- **Average time from confirming the deposit reference to binding the settlement: 5.605 seconds.**
- Average time through to ledger confirmation (settled): 11.025 seconds.

Both figures are **observational**: they are recorded for monitoring and are
**not** pass/fail conditions for D2. They depend on the Stellar Testnet ledger
close interval (roughly 5 seconds) and on the worker poll interval, and say
nothing about the quality of the evidence.

"Binding the settlement" is the moment the transaction hash is written to the
database and attached to the order. It happens *before* the transaction is sent
to the network — that ordering is the double-spend protection, not an accident.

| Reference ID | Deposit reference confirmed (UTC) | Settlement bound / submitted (UTC) | Ledger confirmed (UTC) | Deposit confirm → settlement bind (s) | Deposit confirm → ledger confirmed (s) |
| --- | --- | --- | --- | --- | --- |
| TP-PHP-20260903-0148 | 2026-09-03 08:10:18Z | 2026-09-03 08:10:41Z | 2026-09-03 08:10:49Z | 23.212 | 30.891 |
| TP-PHP-20260903-0149 | 2026-09-03 08:10:51Z | 2026-09-03 08:10:52Z | 2026-09-03 08:10:57Z | 0.352 | 5.544 |
| TP-PHP-20260903-0150 | 2026-09-03 08:11:06Z | 2026-09-03 08:11:10Z | 2026-09-03 08:11:12Z | 3.679 | 5.589 |
| TP-PHP-20260903-0151 | 2026-09-03 08:11:20Z | 2026-09-03 08:11:31Z | 2026-09-03 08:11:37Z | 11.727 | 17.225 |
| TP-PHP-20260903-0152 | 2026-09-03 08:11:41Z | 2026-09-03 08:11:41Z | 2026-09-03 08:11:48Z | 0.344 | 6.982 |
| TP-PHP-20260903-0153 | 2026-09-03 08:11:55Z | 2026-09-03 08:12:01Z | 2026-09-03 08:12:08Z | 6.638 | 13.142 |
| TP-PHP-20260903-0154 | 2026-09-03 08:12:13Z | 2026-09-03 08:12:18Z | 2026-09-03 08:12:22Z | 4.194 | 8.5 |
| TP-PHP-20260903-0155 | 2026-09-03 08:12:27Z | 2026-09-03 08:12:27Z | 2026-09-03 08:12:33Z | 0.347 | 6 |
| TP-PHP-20260903-0156 | 2026-09-03 08:12:36Z | 2026-09-03 08:12:36Z | 2026-09-03 08:12:43Z | 0.357 | 7.797 |
| TP-PHP-20260903-0157 | 2026-09-03 08:12:49Z | 2026-09-03 08:12:54Z | 2026-09-03 08:12:58Z | 5.2 | 8.582 |

---

## Verify one settlement yourself, in 5 minutes

1. Pick any row in the positive table above — row 1 will do.
2. Note the `Reference ID` in that row.
3. Click the `Stellar Expert` link in the same row (or paste the full
   transaction hash into `https://stellar.expert/explorer/testnet/tx/<hash>`).
4. On that page find the **Memo** field. It must be exactly the `Reference ID`
   from step 2.
5. Optionally cross-check the amount and the destination against the
   `USDC settled` column and the payout float `GCQQLXJEP3DRCNY6JYUMYAR7BM6WU34XG42W2BPSYPVMORTTVY3VMPK3`.
6. For the whole set at once: open the payout float account on the explorer and
   check that its USDC balance equals `730.1250000` — the total of the
   amount column. The account started at zero and has received nothing else.

The memo is on the public ledger, not in the builder’s database — which is why
step 4 requires no trust in us. If the memo matches, that transaction belongs to
that order.

## Files in this folder

| File | Contents |
| --- | --- |
| `d2-summary.md` | This document |
| `d2-positive.csv` | The positive group, every column |
| `d2-negative.csv` | The negative group, every column |
| `d2-metrics.csv` | Per-leg timings |
| `tx/<reference>.xdr` | Raw signed XDR of each transaction |
| `tx/<reference>.horizon.json` | Full Horizon JSON plus the database record |
| `run.json` | Machine-readable record of this run |
| `run.log.jsonl` | Step-by-step log, one JSON object per event |

None of these files contains an order access token or a wallet secret key: the
script scans every byte before writing and aborts if it finds one.
