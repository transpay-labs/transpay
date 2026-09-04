# Screenshots — the request screens (Deliverable 1)

Seven captures of one transfer order moving through every state of the chat
flow, taken from the running application with Chrome at 2x, in order.

**The interface is simulated.** It is not WhatsApp, not Messenger, and not
connected to any commercial messaging platform. Every screen carries that
statement in a banner across the top, and the footer repeats that the rate is a
fixed number rather than a market rate and that the deposit step is simulated.
The chat form was chosen because that is where remittance requests are
coordinated today; nothing here imitates another product's name, logo or layout.

| File | What it shows |
| --- | --- |
| `01-empty-chat.png` | The opening screen: the assistant asks for a USD amount. |
| `02-quote.png` | The quote: amount, 1% fee placeholder, converted amount, fixed rate, PHP the recipient gets, and the reference ID — labelled as the memo that will appear on the Stellar ledger. |
| `03-quote-confirmed.png` | The sender has confirmed the rate (`Rate locked`), and the recipient's bank details are being asked for. |
| `04-recipient.png` | Recipient captured. The account number is masked to its last four digits everywhere it is displayed. |
| `05-deposit-instruction.png` | The simulated USD deposit instruction, with its own deposit reference and an explicit note that there is no real bank account. |
| `06-awaiting-settlement.png` | The deposit has been marked as made, and the transfer is queued for the Stellar testnet. |
| `07-settled.png` | Settled. The transaction hash, the memo shown to equal the reference ID, the amount in USDC, the ledger sequence, and a link to the block explorer. |

`07-settled.png` contains the whole transcript, so it doubles as a single-image
record of the entire flow.

## The order in these screenshots

| | |
| --- | --- |
| Reference ID | `TP-PHP-20260903-0027` |
| Transaction | `7cc414d47a9bb91ad9454337c6421d7ff60f05480abaae7e7f78d145758acc2c` |
| Ledger | 4484446 |
| Explorer | https://stellar.expert/explorer/testnet/tx/7cc414d47a9bb91ad9454337c6421d7ff60f05480abaae7e7f78d145758acc2c |
| Captured | 2026-09-03T14:30:23.620Z |

**This order is not one of the twenty in the D1 and D2 result tables, and its
reference ID deliberately does not overlap with them.** A reference ID is unique
within one database, not across the world, so screenshots taken on a different
corridor could otherwise show the same string as a different order in the
tables. This capture ran on its own corridor with its own payout float, which is
also why it does not disturb the reconciliation in `../d2/`: the payout float
audited there received exactly the ten settlements in that report and nothing
else.

The transaction above is real and can be checked on the explorer like any other.
