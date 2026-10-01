# gem-bid-analyzer

A command-line toolkit for suppliers bidding on India's **Government
e-Marketplace (GeM)**. It answers the three questions every bid team asks:

1. **Can we bid?** — check a company profile against the bid's eligibility
   criteria (turnover, experience, past performance, OEM authorisation,
   certifications, EMD) including **MSE / Startup exemptions**, and get the
   exact document checklist to upload.
2. **Who wins and how much?** — rank offers (L1, L2 …) and split the quantity
   under **MSE purchase preference** and **Make in India (PPP-MII)** rules.
3. **What should we quote?** — suggest a price from past winning prices
   while protecting a minimum margin.

## 1. Eligibility check

```
$ gembid check examples/bid.json examples/profile.json
Bid GEM/2026/B/1234567: Desktop Computer i5 16GB × 120
Bidder: RCS Informatic

  ◎ Average turnover       EXEMPT  avg of 2023-24, 2024-25, 2025-26 = ₹26.17 L vs required ₹30.00 L — exempt as MSE
  ✔ Experience             PASS    4 years vs required 3
  ✔ Past performance       PASS    largest similar order 40 units (Municipal Corporation) vs required 36 units (30% of 120)
  ✔ OEM authorisation      PASS    authorisation on file
  ✔ Certification: ISO 9001 PASS    available
  ✔ Certification: BIS     PASS    available
  ◎ EMD                    EXEMPT  ₹1.44 L — exempt as MSE
  • Make in India          INFO    Class-I supplier (55% local content)

VERDICT: ELIGIBLE — go ahead

Documents to upload:
  [ ] Incorporation / registration certificate
  [ ] Copies of past purchase orders
  [ ] Completion / installation certificates
  [ ] OEM authorisation certificate
  [ ] ISO 9001 certificate
  [ ] BIS certificate
  [ ] Local content self-declaration
```

Exit code is `0` when eligible and `2` when not, so it slots into scripts
that screen dozens of bids each morning.

## 2. Evaluation with purchase preference

```
$ gembid evaluate examples/offers.csv --quantity 120
Ranking
  L1  Alpha Systems                  58,200.00  
  L1  Cyber Point                    58,200.00  Class-II
  L2  Bharat Tech                    59,850.00  MSE, Class-II
  L3  RCS Informatic                 61,900.00  MSE, Class-I
  L4  Delta Infotech                 67,400.00  MSE, Class-I

Award
  Alpha Systems                   30 × 58,200.00 =   1,746,000.00   (L1)
  RCS Informatic                  60 × 58,200.00 =   3,492,000.00   (Class-I local supplier matched L1 (within 20%))
  Bharat Tech                     30 × 58,200.00 =   1,746,000.00   (MSE matched L1 (within 15%))
  Total                                                    6,984,000.00

note: RCS Informatic quoted 61900 vs L1 58200; matched to L1 under PPP-MII.

note: Bharat Tech (MSE) quoted 59850; offered to match L1 58200.
```

How allocation works (all margins and shares are configurable flags):

| Rule | Default | Effect |
|---|---|---|
| Make in India | Class-I within **20%** of a non-Class-I L1 | matches L1 for **50%** of a divisible bid, or the whole order if indivisible |
| MSE preference | MSE within **15%** of a non-MSE L1 | matches L1 for up to **25%** of the quantity |
| Ties | equal prices share an L-rank | MSEs are listed first |

## 3. Price advice

```
$ gembid price --history 61200,59800,60500,62900,58750,63400,60100 --cost 46000
Past winning prices: 7 samples, lowest 58750, 25th pct 59950.00, median 60500.00
Your break-even (cost + GST): 54280.00
Suggested quote: 59650.25 (margin 9.9%)
Quote just below the 25th percentile of past winning prices.
```

It aims just under the 25th percentile of past winners; if that breaks your
minimum margin it falls back to the margin floor, and if even the median is
below your floor it tells you to skip the bid.

## Install

```bash
pip install .
```

Inputs are plain JSON / CSV — see `examples/` for the formats.

## Tests

```bash
pip install -e ".[dev]"
pytest
```

> **Disclaimer:** procurement rules change and each bid's ATC can override
> defaults. The policy values here are configurable for that reason — always
> verify against the specific bid document and the latest government orders.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
