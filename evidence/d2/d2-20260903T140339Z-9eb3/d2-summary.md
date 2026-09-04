# D2 — Settlement on Stellar Testnet

**Positive group: 10/10 real USDC transactions confirmed on the ledger.**  
**Negative group: 5/5 attempts correctly rejected, transactions produced: 0.**

- Run ID: `d2-20260903T140339Z-9eb3`
- Started / finished (UTC): 2026-09-03 14:03:39Z → 2026-09-03 14:07:38Z
- Network: Stellar **Testnet** · Horizon `https://horizon-testnet.stellar.org`
- Asset: `USDC`, issuer `GBXS3FGFQ6O24VR4HJI73IZVUKTPM3PG6ZKYVDLSTAKPOTHJVBXFQ4BX`
- USD-side treasury (money leaves here): [`GCNZRHSTDPQDDRZDJK4UD62XR4P34OODALMLMYOGIAKAX6YHFDVNWOPS`](https://stellar.expert/explorer/testnet/account/GCNZRHSTDPQDDRZDJK4UD62XR4P34OODALMLMYOGIAKAX6YHFDVNWOPS)
- PHP-side payout float (money arrives here): [`GCQJHCQCSZXBQUEJTRXZ442PLA6E6GNTXXVYW44WMLYZLAR24SVB37SX`](https://stellar.expert/explorer/testnet/account/GCQJHCQCSZXBQUEJTRXZ442PLA6E6GNTXXVYW44WMLYZLAR24SVB37SX)
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
| 1 | TP-PHP-20260903-0011 | TP-PHP-20260903-0011 | yes | 11.0000000 | 10.8900000 | 4484130 | 2026-09-03 14:03:57Z | 26688372…c0cb9d03 | [open](https://stellar.expert/explorer/testnet/tx/26688372fb3c9fdc895cf83886d787f1464f179c46edeed95de1d165c0cb9d03) | settled | PASS |
| 2 | TP-PHP-20260903-0012 | TP-PHP-20260903-0012 | yes | 23.5000000 | 23.2650000 | 4484136 | 2026-09-03 14:04:27Z | 6442a89f…2a586244 | [open](https://stellar.expert/explorer/testnet/tx/6442a89f53dc6f57406845cb8b1833f05acc249d66dcf18aaff9bd6d2a586244) | settled | PASS |
| 3 | TP-PHP-20260903-0013 | TP-PHP-20260903-0013 | yes | 47.2500000 | 46.7775000 | 4484142 | 2026-09-03 14:04:57Z | ddb87aa7…ba9361eb | [open](https://stellar.expert/explorer/testnet/tx/ddb87aa7878e2c24a72de87fdb9b40a09cbcd107021a6414a69c02e2ba9361eb) | settled | PASS |
| 4 | TP-PHP-20260903-0014 | TP-PHP-20260903-0014 | yes | 8.7500000 | 8.6625000 | 4484144 | 2026-09-03 14:05:07Z | f3a193fa…71161db2 | [open](https://stellar.expert/explorer/testnet/tx/f3a193fa99c6d014c173b7917d793f967a70261d931f0c659d71d81f71161db2) | settled | PASS |
| 5 | TP-PHP-20260903-0015 | TP-PHP-20260903-0015 | yes | 156.4000000 | 154.8360000 | 4484153 | 2026-09-03 14:05:52Z | 8ab9ca37…55809c39 | [open](https://stellar.expert/explorer/testnet/tx/8ab9ca377f1f6d86f8425bc85ddb60838a977985671ea673f14a4fe255809c39) | settled | PASS |
| 6 | TP-PHP-20260903-0016 | TP-PHP-20260903-0016 | yes | 99.9900000 | 98.9901000 | 4484157 | 2026-09-03 14:06:12Z | 78b0b6c7…4b7c6102 | [open](https://stellar.expert/explorer/testnet/tx/78b0b6c7d88a0bba37abe5f89abbbcb1fa4a3c8b943331e9a2004a074b7c6102) | settled | PASS |
| 7 | TP-PHP-20260903-0017 | TP-PHP-20260903-0017 | yes | 5.5000000 | 5.4450000 | 4484161 | 2026-09-03 14:06:32Z | 8b57d311…6a37a501 | [open](https://stellar.expert/explorer/testnet/tx/8b57d3118e25a02ad4d056bc6392536ae549b08c885f58e3062845fd6a37a501) | settled | PASS |
| 8 | TP-PHP-20260903-0018 | TP-PHP-20260903-0018 | yes | 302.1000000 | 299.0790000 | 4484165 | 2026-09-03 14:06:52Z | c553107f…93385d6c | [open](https://stellar.expert/explorer/testnet/tx/c553107f40fc6ac897f2dbd9bd5811823793dfde27e15b7e442f9c5c93385d6c) | settled | PASS |
| 9 | TP-PHP-20260903-0019 | TP-PHP-20260903-0019 | yes | 64.3300000 | 63.6867000 | 4484168 | 2026-09-03 14:07:07Z | 00d79c86…de7d7456 | [open](https://stellar.expert/explorer/testnet/tx/00d79c86573c85799fa6dadb57961fecfaf26a4e09c34e93323e4e05de7d7456) | settled | PASS |
| 10 | TP-PHP-20260903-0020 | TP-PHP-20260903-0020 | yes | 18.6800000 | 18.4932000 | 4484172 | 2026-09-03 14:07:27Z | 446c9d0b…22796b08 | [open](https://stellar.expert/explorer/testnet/tx/446c9d0b7e1f65bf9059680fca3622df8386a6adbc5073ce4d96634122796b08) | settled | PASS |

**`Memo = Reference ID` is the most important column in this deliverable.** The
memo lives on the public ledger, not in the builder’s database. It is the point
at which a transaction proves for itself which order it belongs to.

The `USDC settled` figure is the USD amount **after** the 1% fee is
deducted — the part that is actually converted to PHP — not the gross amount.

### Local originals (these survive the testnet reset on 2026-12-16)

| # | Reference ID | Full transaction hash | Raw signed XDR | Horizon JSON |
| --- | --- | --- | --- | --- |
| 1 | TP-PHP-20260903-0011 | `26688372fb3c9fdc895cf83886d787f1464f179c46edeed95de1d165c0cb9d03` | `tx/TP-PHP-20260903-0011.xdr` | `tx/TP-PHP-20260903-0011.horizon.json` |
| 2 | TP-PHP-20260903-0012 | `6442a89f53dc6f57406845cb8b1833f05acc249d66dcf18aaff9bd6d2a586244` | `tx/TP-PHP-20260903-0012.xdr` | `tx/TP-PHP-20260903-0012.horizon.json` |
| 3 | TP-PHP-20260903-0013 | `ddb87aa7878e2c24a72de87fdb9b40a09cbcd107021a6414a69c02e2ba9361eb` | `tx/TP-PHP-20260903-0013.xdr` | `tx/TP-PHP-20260903-0013.horizon.json` |
| 4 | TP-PHP-20260903-0014 | `f3a193fa99c6d014c173b7917d793f967a70261d931f0c659d71d81f71161db2` | `tx/TP-PHP-20260903-0014.xdr` | `tx/TP-PHP-20260903-0014.horizon.json` |
| 5 | TP-PHP-20260903-0015 | `8ab9ca377f1f6d86f8425bc85ddb60838a977985671ea673f14a4fe255809c39` | `tx/TP-PHP-20260903-0015.xdr` | `tx/TP-PHP-20260903-0015.horizon.json` |
| 6 | TP-PHP-20260903-0016 | `78b0b6c7d88a0bba37abe5f89abbbcb1fa4a3c8b943331e9a2004a074b7c6102` | `tx/TP-PHP-20260903-0016.xdr` | `tx/TP-PHP-20260903-0016.horizon.json` |
| 7 | TP-PHP-20260903-0017 | `8b57d3118e25a02ad4d056bc6392536ae549b08c885f58e3062845fd6a37a501` | `tx/TP-PHP-20260903-0017.xdr` | `tx/TP-PHP-20260903-0017.horizon.json` |
| 8 | TP-PHP-20260903-0018 | `c553107f40fc6ac897f2dbd9bd5811823793dfde27e15b7e442f9c5c93385d6c` | `tx/TP-PHP-20260903-0018.xdr` | `tx/TP-PHP-20260903-0018.horizon.json` |
| 9 | TP-PHP-20260903-0019 | `00d79c86573c85799fa6dadb57961fecfaf26a4e09c34e93323e4e05de7d7456` | `tx/TP-PHP-20260903-0019.xdr` | `tx/TP-PHP-20260903-0019.horizon.json` |
| 10 | TP-PHP-20260903-0020 | `446c9d0b7e1f65bf9059680fca3622df8386a6adbc5073ce4d96634122796b08` | `tx/TP-PHP-20260903-0020.xdr` | `tx/TP-PHP-20260903-0020.horizon.json` |

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
| 1 | duplicate reference | Re-submitted the deposit reference already used by positive order #1 | TP-PHP-20260903-0022 | rejected | duplicate_deposit_reference | 0 | yes | PASS |
| 2 | duplicate reference | Re-submitted the deposit reference already used by positive order #2 | TP-PHP-20260903-0023 | rejected | duplicate_deposit_reference | 0 | yes | PASS |
| 3 | duplicate reference | Re-submitted the deposit reference already used by positive order #3 | TP-PHP-20260903-0024 | rejected | duplicate_deposit_reference | 0 | yes | PASS |
| 4 | mismatched amount/order | The order's own deposit reference, but the amount paid in is 5.00 USD too high | TP-PHP-20260903-0025 | rejected | mismatched_amount | 0 | yes | PASS |
| 5 | mismatched amount/order | A deposit reference belonging to a different order (never used before) | TP-PHP-20260903-0026 | rejected | mismatched_order | 0 | yes | PASS |

- Settlement legs produced by these 5 cases: **0**.
- Payout float USDC balance before and after the negative group: `730.1250000` → `730.1250000` (change: `0.0000000`).
- The per-case log is in `run.log.jsonl` under the event `d2.negative_rejected`,
  including the exact string that was submitted and the error the system returned.

One helper order was created separately so that an **unused** deposit reference
existed for the "mismatched order" case (`TP-PHP-20260903-0021`). It is not one
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

Open the payout float on the block explorer — [`GCQJHCQCSZXBQUEJTRXZ442PLA6E6GNTXXVYW44WMLYZLAR24SVB37SX`](https://stellar.expert/explorer/testnet/account/GCQJHCQCSZXBQUEJTRXZ442PLA6E6GNTXXVYW44WMLYZLAR24SVB37SX) —
read its USDC balance, and compare it with `730.1250000` above.
The account has received nothing else, ever, so the two numbers can only agree if
the settlements in this report are exactly the transactions that happened.

---

## Observed metric — NOT a pass/fail condition

- **Average time from confirming the deposit reference to binding the settlement: 5.03 seconds.**
- Average time through to ledger confirmation (settled): 12.767 seconds.

Both figures are **observational**: they are recorded for monitoring and are
**not** pass/fail conditions for D2. They depend on the Stellar Testnet ledger
close interval (roughly 5 seconds) and on the worker poll interval, and say
nothing about the quality of the evidence.

"Binding the settlement" is the moment the transaction hash is written to the
database and attached to the order. It happens *before* the transaction is sent
to the network — that ordering is the double-spend protection, not an accident.

| Reference ID | Deposit reference confirmed (UTC) | Settlement bound / submitted (UTC) | Ledger confirmed (UTC) | Deposit confirm → settlement bind (s) | Deposit confirm → ledger confirmed (s) |
| --- | --- | --- | --- | --- | --- |
| TP-PHP-20260903-0011 | 2026-09-03 14:03:48Z | 2026-09-03 14:03:54Z | 2026-09-03 14:04:01Z | 6.235 | 12.698 |
| TP-PHP-20260903-0012 | 2026-09-03 14:04:20Z | 2026-09-03 14:04:25Z | 2026-09-03 14:04:28Z | 4.52 | 7.496 |
| TP-PHP-20260903-0013 | 2026-09-03 14:04:45Z | 2026-09-03 14:04:54Z | 2026-09-03 14:04:58Z | 8.798 | 12.908 |
| TP-PHP-20260903-0014 | 2026-09-03 14:05:03Z | 2026-09-03 14:05:03Z | 2026-09-03 14:05:37Z | 0.47 | 34.241 |
| TP-PHP-20260903-0015 | 2026-09-03 14:05:45Z | 2026-09-03 14:05:49Z | 2026-09-03 14:05:53Z | 4.145 | 7.907 |
| TP-PHP-20260903-0016 | 2026-09-03 14:06:00Z | 2026-09-03 14:06:07Z | 2026-09-03 14:06:16Z | 7.029 | 15.673 |
| TP-PHP-20260903-0017 | 2026-09-03 14:06:21Z | 2026-09-03 14:06:26Z | 2026-09-03 14:06:34Z | 5.117 | 12.501 |
| TP-PHP-20260903-0018 | 2026-09-03 14:06:46Z | 2026-09-03 14:06:48Z | 2026-09-03 14:06:52Z | 1.759 | 5.6 |
| TP-PHP-20260903-0019 | 2026-09-03 14:07:02Z | 2026-09-03 14:07:05Z | 2026-09-03 14:07:08Z | 3.642 | 5.985 |
| TP-PHP-20260903-0020 | 2026-09-03 14:07:15Z | 2026-09-03 14:07:24Z | 2026-09-03 14:07:28Z | 8.585 | 12.656 |

---

## Verify one settlement yourself, in 5 minutes

1. Pick any row in the positive table above — row 1 will do.
2. Note the `Reference ID` in that row.
3. Click the `Stellar Expert` link in the same row (or paste the full
   transaction hash into `https://stellar.expert/explorer/testnet/tx/<hash>`).
4. On that page find the **Memo** field. It must be exactly the `Reference ID`
   from step 2.
5. Optionally cross-check the amount and the destination against the
   `USDC settled` column and the payout float `GCQJHCQCSZXBQUEJTRXZ442PLA6E6GNTXXVYW44WMLYZLAR24SVB37SX`.
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
