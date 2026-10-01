# ledger-cli

A fast, single-binary **plain-text double-entry accounting** tool written in Go.
Your books live in a human-readable text file you can version with git; the
tool validates them and produces a trial balance, P&L and balance sheet.

Inspired by the plain-text accounting idea (ledger / hledger), with Indian
number formatting (`1,23,456.78`) built in.

## Features

- Readable journal format with comments, cleared (`*`) / pending (`!`) flags
- **Strict double entry**: every transaction must balance to the paisa
- **Amount inference** for one posting per transaction
- **Balance assertions** (`= 1,82,000`) catch reconciliation mistakes early
- **Account declarations** — typos like `Assets:Bnak` become errors
- Reports: `balance`, `register`, `trial`, `pnl`, `bs`, `check`
- Date filtering with `--from` / `--to`
- Integer fixed-point money — no floating point anywhere
- Errors point to the exact line in your journal

## Install

```bash
go install github.com/Sumitrcs/ledger-cli@latest
```

## Journal format

```
account Assets:Bank:HDFC
account Expenses:Rent
account Equity:Capital

2026-04-01 * Capital introduced
    Assets:Bank:HDFC           2,00,000.00
    Equity:Capital                          ; amount inferred

2026-04-02 * Office rent — April
    Expenses:Rent                18,000
    Assets:Bank:HDFC             = 1,82,000.00   ; inferred + asserted
```

## Reports

```
$ ledger -f examples/books.journal balance
       2,51,161.00  Assets
       2,46,801.00    Bank:HDFC
          4,360.00    Cash
      -2,00,000.00  Equity:Capital
         23,889.50  Expenses
            999.00    Internet
         18,000.00    Rent
          4,250.50    Software
            640.00    Travel
        -60,000.00  Income:Services
        -10,000.00    Consulting
        -50,000.00    Web
        -15,050.50  Liabilities
         -4,250.50    CreditCard
        -10,800.00    GST:Output
------------------
              0.00
```

```
$ ledger -f examples/books.journal bs
ASSETS
       2,51,161.00    Assets
       2,46,801.00      Bank:HDFC
          4,360.00      Cash
       2,51,161.00  Total assets

LIABILITIES
         15,050.50    Liabilities
          4,250.50      CreditCard
         10,800.00      GST:Output
EQUITY
       2,00,000.00    Equity:Capital
         36,110.50    Retained earnings (current period)
       2,51,161.00  Total liabilities + equity
```

Other commands:

```bash
ledger -f books.journal trial                         # trial balance
ledger -f books.journal pnl --from 2026-04-01 --to 2027-03-31
ledger -f books.journal register Assets:Bank          # running balance
ledger -f books.journal check                         # validate only (great in CI)
```

## Project layout

```
journal/   parser, amount type, balance assertions
report/    balance tree, register, trial balance, P&L, balance sheet
main.go    CLI
```

## Tests

```bash
go test ./...
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
