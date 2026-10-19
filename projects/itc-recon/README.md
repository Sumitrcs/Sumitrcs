# itc-recon

[![CI](https://github.com/Sumitrcs/itc-recon/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/itc-recon/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**GST input tax credit (ITC) reconciliation in one command.** It matches your purchase register against **GSTR-2B** and tells you exactly what you can claim this month, which bills are at risk, and which suppliers to call.

Every business registered under GST, and every CA firm, does this each month, usually by hand in Excel.
The hard part is that the same bill is rarely written the same way twice (`SST/102/26-27` in your books, `SST-0102/26-27` in 2B), and that is what this tool is built for.

It is written in Go with no dependencies, works offline, and reads the **GSTR-2B JSON downloaded from the GST portal** directly, or a CSV.

```text
$ itc-recon -books purchases.csv -2b gstr2b.json -csv result.csv
ITC reconciliation: purchase register vs GSTR-2B

        ITC in your books  ₹74,400.00
  ITC reported in GSTR-2B  ₹46,980.00
            Claimable now  ₹33,240.00
      At risk (follow up)  ₹41,160.00
      In 2B, not in books   ₹2,940.00

3 matched, 1 probable, 1 amount mismatch, 4 only in books, 2 only in 2B

Suppliers to follow up (ITC at risk):
  24AAFFM3456D1ZL  Mehta Chemicals               1 bill  ₹10,800.00
  07AAACR9012C1ZT  Raj Electricals               2 bills  ₹9,360.00
  29AAGCK5678B1ZA  Karnataka Packaging Co        1 bill  ₹1,500.00

Probable (1):
  29AAGCK5678B1ZA  KPC-7790         20-08-2026  tax ₹3,240.00
      invoice number differs: KPC-7790 vs KPC-779O

Amount mismatch (1):
  29AAGCK5678B1ZA  KPC-7781         03-08-2026  tax ₹4,500.00
      2B differs from books: tax -1,500.00

Only in books (4):
  07AAACR9012C1ZT  REL/55           10-08-2026  tax ₹7,200.00
      not in GSTR-2B: ask the supplier to file
  ...
  27AABCS1234A1Z1  SST/101/26-27    05-08-2026  tax ₹18,000.00
      entered twice: same bill as line 2 of your books
  33AABCT7890E1Z8  TT/441           25-08-2026  tax ₹1,500.00
      GSTIN looks mistyped: 2B has the same bill under 33AABCT7890E1Z9
...
All 11 rows written to result.csv
```

This is real output from the sample files in `testdata/`. Try it yourself:

```bash
go install github.com/Sumitrcs/itc-recon/cmd/itc-recon@latest
itc-recon -books testdata/purchases.csv -2b testdata/gstr2b.json
```

## What it finds

| Result | Meaning | What to do |
|---|---|---|
| **matched** | Same supplier, same invoice number, same amounts | Claim it |
| **probable** | Same supplier, amount and (nearly) date, but the number is written a little differently | Check, then claim |
| **amount mismatch** | Same invoice, different taxable value or tax | Claim the lower amount; ask the supplier to amend |
| **only in books** | Your supplier hasn't reported it yet | Follow up, because you can't claim it until they do |
| **only in 2B** | Reported against your GSTIN but not in your books | Record it, or make sure it's really yours |

It also flags **ITC blocked in 2B** (`itcavl: N`), **GSTINs that fail the checksum** (pointing to the likely correct one), and **bills entered twice** in your books.
The supplier follow-up list leaves out problems that are in your own records.

Options: `-tolerance 1` (rupees treated as rounding), `-days 7` (how far apart a probable match's dates may be), and `-csv file` (every row with both sides' figures, ready for Excel).

### Input files

- **Books**: a CSV with a header row. Column names are flexible (`Invoice No`, `Bill No.`, `inum`, `Taxable Value`, `Integrated Tax`, `IGST` …), so Tally, Busy and Excel exports usually work as they are. You need GSTIN, invoice number, date and taxable value; the tax columns are optional.
- **GSTR-2B**: the JSON from *GST portal → Returns → GSTR-2B → Download JSON* (the B2B section, with either item-wise or invoice-level amounts), or a CSV with the same columns as the books.

Credit notes, amendments and import of goods (IMPG) are not handled yet.

## How it works

### 1. Money is counted in paise

`₹1,23,456.78` becomes the integer `12345678`. Adding floats like `0.1 + 0.2` gives `0.30000000000000004`, and those errors would pile up across hundreds of invoices. Integers are always exact.

### 2. Normalising invoice numbers

Suppliers and accountants write the same number in different ways, so before comparing, each number is reduced to its essentials:

```text
INV/001/24-25   ─┐
inv-1/24-25      ├─►  INV1.24.25
INV 0001 / 24-25 ┘
```

The rules are: upper case, drop spaces and punctuation, and drop leading zeros in each group of digits.
Groups of digits that were separated keep a `.` between them, so `12/3` and `1/23` (two different bills) stay different. A test found that bug in the first version.

### 3. Matching in passes, from certain to likely

1. **Exact.** The key is `GSTIN | normalised number`. A hash map makes this one quick pass.
2. **Probable.** For whatever is left: same supplier, amounts within tolerance, dates within 7 days, and invoice numbers at most **2 edits** apart (*Levenshtein distance*). `KPC-7790` vs `KPC-779O`, with the letter O typed for a zero, is 1 edit.
   All candidate pairs are scored (edits × 100 + days apart) and taken best-first, so each invoice ends up with its closest partner.
3. Anything still unmatched is **only in books** or **only in 2B**.

### 4. How much you can claim

For each matched pair, the claimable ITC is the **lower** of the two tax amounts, and zero if 2B says ITC isn't available.
Everything else in your books is *at risk*, so `books ITC = claimable + at risk` always holds, and a test checks that.

### 5. GSTIN checksum

The 15th character of a GSTIN is a check digit computed from the first 14, with alternating weights 1, 2, 1, 2 … in base 36.
That catches most typing slips: `33AABCT7890E1Z8` fails, and the tool finds `33AABCT7890E1Z9` in 2B with the same bill.

## What you'll learn

- A real accounting workflow, ITC reconciliation, and why it matters for cash flow
- Matching dirty real-world data: normalisation, then exact keys, then fuzzy matching
- Levenshtein (edit) distance with a rolling array
- Greedy assignment with scored candidates
- Exact money handling with integer paise, and Indian digit grouping (`1,23,456.78`)
- Go: `encoding/json` with nested structs, `encoding/csv` with flexible headers, `text/tabwriter`, table-driven and golden-file tests

## Try it yourself

1. **Credit notes.** Add GSTR-2B's `cdnr` section and subtract credit notes from the matching supplier's ITC.
2. **Financial-year-aware numbers.** Make `INV/1/2026-27` match `INV/1/26-27`.
3. **Supplier emails.** For each supplier on the follow-up list, write a polite reminder listing their missing bills.
4. **Carry forward.** Compare month on month: which bills from *last* month's "only in books" turned up in this month's 2B?
5. **A web version.** Compile the matching code to WebAssembly (`GOOS=js GOARCH=wasm`) and run it in the browser, so no data leaves the user's computer.

*This tool helps you prepare; final ITC decisions should follow current GST law and your tax adviser.*

## Run the tests

```bash
go test ./...          # 13 tests, including a golden report
go test -update ./...  # accept an intended change to the report
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
