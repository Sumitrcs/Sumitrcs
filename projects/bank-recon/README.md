# bank-recon

[![CI](https://github.com/Sumitrcs/bank-recon/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/bank-recon/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**Automatic bank reconciliation** for small businesses and accountants.
Feed it a bank statement and the bank ledger from your books (Tally, Busy,
Zoho — any CSV export) and it matches the entries and prints a
**Bank Reconciliation Statement** with suggested journal entries for the
items that are only in the bank.

Matching by hand at month-end takes hours. This takes a second and
explains every match it made.

```
$ bankrecon --bank examples/bank_statement.csv --books examples/cash_book.csv \
            --opening-books 120000 --opening-bank 120000
                     BANK RECONCILIATION STATEMENT                      
========================================================================
Balance as per books                                         2,43,459.60
Add: Cheques issued but not yet presented                       7,500.00
    29-06-2026  Orbit Labs - freelance designer                 7,500.00
Less: Deposits not yet credited by bank                        52,000.00
    30-06-2026  Cheque from Nimbus Health                      52,000.00
Add: Credits in bank not in books                               1,342.00
    30-06-2026  INT.PD 01-04-26 TO 30-06-26                     1,342.00
Less: Debits in bank not in books                                  17.70
    28-06-2026  SMS ALERT CHRG INCL GST                            17.70
------------------------------------------------------------------------
Balance as per bank (computed)                               2,00,283.90
Balance as per bank statement                                2,00,283.90
Status                                                      RECONCILED ✓

Matched: reference 2, exact 1, window 4, split 1

Action items
  • 30-06-2026     1,342.00  INT.PD 01-04-26 TO 30-06-26  → Interest credited — pass a receipt to Interest Income A/c
  • 28-06-2026       -17.70  SMS ALERT CHRG INCL GST      → Bank charges — pass a journal to Bank Charges A/c
```

## How matching works

Five passes run from most certain to least certain. Anything matched in one
pass is removed before the next, so the fuzzy passes only see leftovers.

| Pass | Rule | Confidence |
|---|---|---|
| **reference** | Same UTR / cheque number (parsed from the narration) and same amount | 1.00 |
| **exact** | Same amount, same date | 0.95+ |
| **window** | Same amount within ±3 days (configurable) | 0.85+ |
| **fuzzy** | Same amount within ±10 days **and** similar narration | 0.60+ |
| **split** | One line equals the sum of 2–3 lines on the other side (e.g. one deposit slip, several receipts) | 0.60–0.70 |

Pairs are scored globally and accepted greedily from the best score down, so
an early bank line can't "steal" the book entry that fits a later line better.
Narration similarity uses the **overlap coefficient** of meaningful tokens
(bank noise like NEFT, IMPS, UPI and numbers is ignored), blended with a
character-level ratio.

## Features

- Reads CSVs with either a signed `amount` column or `debit`/`credit`
  (`withdrawal`/`deposit`) columns; common Indian date formats; `Dr`/`Cr` suffixes
- Extracts **UTR, RRN and cheque numbers** from narrations
- Exact money maths with `Decimal`
- BRS in the standard format with **Indian digit grouping**
- **Action items** for bank-only entries: bank charges, interest, TDS, EMI, returns
- `--export` writes every match with its type and confidence to CSV
- Exit code `0` when reconciled, `2` when a difference remains — handy in scripts

## Install

```bash
pip install .
bankrecon --bank statement.csv --books ledger.csv --export matches.csv
```

## Use as a library

```python
from decimal import Decimal
from bankrecon import load_entries, reconcile, render

bank = load_entries("statement.csv", "bank")
books = load_entries("ledger.csv", "books")
brs = reconcile(bank, books, opening_books=Decimal("120000"), opening_bank=Decimal("120000"))
print(render(brs))
print(brs.reconciled, brs.difference)
```

## Tests

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
