# india-income-tax

Old vs New regime income tax calculator for **FY 2025-26 (AY 2026-27)** — a
single static page backed by a pure, fully tested tax engine.

Most online calculators get the edge cases wrong. This one handles them:

- **Section 87A rebate** — ₹60,000 (new) / ₹12,500 (old)
- **Marginal relief on the rebate** — at ₹12.1 L taxable income you pay
  ₹10,000 + cess, not ₹61,500
- **Surcharge with marginal relief** at ₹50 L, ₹1 Cr, ₹2 Cr, ₹5 Cr, and the
  25% cap in the new regime
- **HRA exemption** — least of actual HRA, rent − 10% of basic, 50%/40% of basic
- **Senior and super-senior** exemption limits (old regime)
- **Rounding** of income and tax to the nearest ₹10 (sections 288A/288B)
- **Break-even deductions** — how much you must claim before the old regime
  wins, found by binary search

## Run it

No build step. Serve the folder with any static server:

```bash
npm start          # or: python3 -m http.server
```

Open <http://localhost:3000> and change any field — everything recalculates live.

## Use the engine directly

```js
import { compareRegimes, computeTax } from "./src/tax.js";

computeTax({ salary: 12_75_000 }, "new").totalTax; // 0

const r = compareRegimes({
  salary: 15_00_000,
  sec80C: 1_50_000,
  homeLoanInterest: 2_00_000,
  hra: { basic: 6_00_000, hraReceived: 3_00_000, rentPaid: 4_20_000, metro: true },
});
r.better;  // "old"
r.savings; // amount saved by choosing it
```

## Slabs used

| New regime | Rate | Old regime (below 60) | Rate |
|---|---|---|---|
| 0 – 4 L | 0% | 0 – 2.5 L | 0% |
| 4 – 8 L | 5% | 2.5 – 5 L | 5% |
| 8 – 12 L | 10% | 5 – 10 L | 20% |
| 12 – 16 L | 15% | above 10 L | 30% |
| 16 – 20 L | 20% | | |
| 20 – 24 L | 25% | | |
| above 24 L | 30% | | |

Standard deduction: ₹75,000 (new) and ₹50,000 (old). Cess: 4%.

> Scope: resident individuals, income taxed at normal slab rates. Capital
> gains at special rates are out of scope. Not tax advice.

## Tests

```bash
npm test
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
