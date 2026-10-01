# gst-invoice-engine

A small, dependency-free engine that turns invoice line items into a fully
computed **Indian GST tax invoice** — exact to the paisa.

I wrote this after seeing billing tools drift by a few paise on large
invoices because they did tax maths in floating point. Here every amount
lives as an **integer number of paise**; rupees only appear when parsing
input and formatting output.

## Features

- **Place of supply rules** — intra-state (CGST + SGST/UTGST), inter-state (IGST),
  SEZ (always IGST) and exports (state code `96`)
- **Zero-rated supplies** under LUT/bond
- **UTGST** automatically for UTs without a legislature (Chandigarh, Ladakh, …)
- **Compensation cess**, line discounts (percent or flat), fractional quantities
- **Reverse charge** — tax shown on invoice but excluded from amount payable
- **HSN-wise summary** grouped by HSN + rate (as needed for GSTR-1 Table 12)
- **Round-off** to the nearest rupee with a separate round-off line
- **Amount in words** in the Indian system (thousand, lakh, crore)
- **Invoice numbering** that resets each financial year and enforces the
  16-character limit from Rule 46

## Quick start

```ts
import { computeInvoice, formatINR } from "gst-invoice-engine";

const inv = computeInvoice({
  supplierState: "07",   // Delhi
  placeOfSupply: "27",   // Maharashtra -> IGST
  lines: [
    { description: "Laptop", hsn: "8471", quantity: 2, rate: 52000, gstRate: 18 },
    { description: "Mouse", hsn: "8471", quantity: 2, rate: 499, gstRate: 18, discount: { percent: 10 } },
  ],
});

console.log(formatINR(inv.totals.igst));       // ₹18,881.68
console.log(formatINR(inv.totals.grandTotal)); // ₹1,23,780.00
console.log(inv.amountInWords);
```

Run the bundled example:

```bash
npm run example
```

```
Invoice RCS/2026-27/0001  (inter-state)

1. Website development        998314     1 x  ₹45,000.00  taxable   ₹45,000.00
2. Domain + hosting (1 yr)    998315     1 x   ₹4,999.00  taxable    ₹4,999.00
3. Printed brochures          4911     500 x       ₹7.50  taxable    ₹3,375.00

Taxable value   ₹53,374.00
IGST            ₹9,404.82
Round off       ₹0.18
Grand total     ₹62,779.00
Rupees Sixty Two Thousand Seven Hundred Seventy Nine Only
```

## Design notes

| Decision | Why |
|---|---|
| Integer paise everywhere | No `0.1 + 0.2` surprises on 10-lakh invoices |
| CGST and SGST rounded independently | Matches the GST portal and most ERPs |
| Percentages scaled by 10⁴ before multiplying | Rates like 0.25% and 1.5% stay exact |
| Pluggable `SeriesStore` for numbering | Swap the in-memory counter for Redis/Postgres in production |

## Tests

```bash
npm test
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
