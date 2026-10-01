# tally-xml-bridge

Move accounting data between **spreadsheets and Tally Prime** without typing
a single voucher by hand.

- **CSV → Tally XML**: journal-style rows become balanced vouchers (Sales,
  Purchase, Payment, Receipt, Journal, Contra, Credit/Debit Note)
- **Invoice register → GST sales vouchers**: CGST + SGST for intra-state, IGST
  for inter-state, automatic round-off line
- **Ledger masters**: every ledger used is created with a sensible parent group
  (Sundry Debtors, Duties & Taxes, Sales Accounts…) so imports never fail on
  "ledger does not exist"
- **Tally XML → CSV**: turn a Day Book export into a spreadsheet
- **Push** an XML file straight into a running Tally via its HTTP gateway (port 9000)

Built for accountants who receive data in Excel from clients every month.

## Quick start

```bash
pip install .

# 1. GST sales register -> vouchers + masters
tallybridge gst-sales examples/invoices.csv --state Delhi \
    --company "RCS Informatic" -o sales.xml --masters masters.xml

# 2. In Tally: Gateway of Tally > Import > Masters (masters.xml), then Vouchers (sales.xml)
#    or push directly when Tally is running with the gateway enabled:
tallybridge push masters.xml
tallybridge push sales.xml

# Export a Day Book from Tally as XML and convert it to CSV
tallybridge to-csv daybook.xml -o daybook.csv
```

### Input formats

**Invoice register** (`examples/invoices.csv`):

```csv
date,invoice_no,party,taxable_value,gst_rate,place_of_supply
01-05-2026,RCS/26-27/0101,Acme Traders,45000,18,Delhi
03-05-2026,RCS/26-27/0102,Bharat Foods Pvt Ltd,12345.67,18,Maharashtra
```

becomes

| Ledger | Dr | Cr |
|---|---|---|
| Bharat Foods Pvt Ltd | 14,568.00 | |
| Sales @ 18% | | 12,345.67 |
| Output IGST @ 18% | | 2,222.22 |
| Round Off | | 0.11 |

**Journal rows** (`examples/journal.csv`), grouped by `voucher_no`:

```csv
date,voucher_type,voucher_no,ledger,debit,credit,narration
2026-04-05,Sales,INV/001,Acme Traders,59000,,Website development
2026-04-05,Sales,INV/001,Sales @ 18%,,50000,
2026-04-05,Sales,INV/001,Output CGST @ 9%,,4500,
2026-04-05,Sales,INV/001,Output SGST @ 9%,,4500,
```

## Things this handles for you

- **Tally's sign convention** — debit lines need `ISDEEMEDPOSITIVE=Yes` with a
  *negative* `AMOUNT`. Getting this wrong silently flips entries.
- **Validation before export** — unbalanced vouchers, zero lines, a line with
  both debit and credit, unknown voucher types or parent groups are rejected
  with the voucher number in the error.
- **Exact money** — `Decimal` everywhere, tax rounded half-up to the paisa.
- **XML escaping** — `R&D Expense`, `Kiran Studio & Co.` and quotes in narrations.
- Reads both `ALLLEDGERENTRIES.LIST` and `LEDGERENTRIES.LIST` from exports.

## Library use

```python
from tallybridge import read_gst_sales_csv, vouchers_to_xml, required_ledgers, ledgers_to_xml

vouchers = read_gst_sales_csv("invoices.csv", home_state="Delhi")
open("sales.xml", "w").write(vouchers_to_xml(vouchers, company="My Company"))
open("masters.xml", "w").write(ledgers_to_xml(required_ledgers(vouchers)))
```

## Tests

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
