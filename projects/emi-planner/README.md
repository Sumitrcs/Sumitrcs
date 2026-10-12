# emi-planner

[![CI](https://github.com/Sumitrcs/emi-planner/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/emi-planner/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A command-line planner for home, car and personal loans. It also works as a small Python library.
It answers the questions people actually ask before signing:

- What will my **EMI** be, and how much **interest** will I pay in total?
- If I **prepay** ₹2 lakh next year, should I ask the bank to cut my EMI or my tenure?
- The dealer says **"only 10% flat"**. What is that really?
- With a ₹10,000 **processing fee**, what am I actually paying?
- How big a loan can I **afford** at ₹30,000 a month?

It uses exact decimal arithmetic, has no dependencies and comes with 61 tests.

## Install

```bash
pip install .            # gives you the `emi` command
# or, without installing:
python -m emiplanner emi 25L 8.5 20y
```

Amounts can be written the way you say them: `2500000`, `25,00,000`, `25L`, `1.2cr`, `50k`.
Tenures can be `20y`, `240m`, `2y6m`, or a bare `20`, which means years.

## Examples

All of the output below is real.

```text
$ emi emi 25L 8.5 20y
Loan          ₹25,00,000 at 8.5% for 20 years
EMI           ₹21,696 per month
Interest      ₹27,06,777  (52.0% of everything you pay)
Total paid    ₹52,06,777
```

**Prepay: cut the EMI or the tenure?**

```text
$ emi prepay 25L 8.5 20y --prepay 12:2L
Prepaying ₹2 L on a ₹25 L loan at 8.5% for 20 years:

                            Interest         Saved  Loan ends after
No prepayment             ₹27,06,777             —  20 years
Keep EMI, cut tenure      ₹20,38,503     ₹6,68,274  16 years 8 months (40 EMIs fewer)
Keep tenure, cut EMI      ₹25,03,051     ₹2,03,727  20 years (EMI drops to ₹19,925)

Best for total interest: cutting the tenure.
```

The same ₹2 lakh saves **₹6.68 lakh** one way and only ₹2.04 lakh the other.

**Month-by-month schedule**, with real dates. You can save it as a CSV for Excel:

```text
$ emi schedule 5L 10 1y --start 2026-11 --csv plan.csv
Month           EMI   Interest  Principal   Prepaid       Balance
Nov 2026     43,958      4,167     39,791         0      4,60,209
Dec 2026     43,958      3,835     40,123         0      4,20,086
...
Sep 2027     43,958        724     43,234         0        43,594
Oct 2027     43,957        363     43,594         0             0

12 EMIs (1 year), interest ₹27,495, total paid ₹5,27,495
Wrote plan.csv
```

**Totals per financial year.** These are handy for your income-tax interest and principal proofs:

```text
$ emi schedule 25L 8.5 20y --start 2026-11 --yearly
Period           Interest     Principal     Prepaid        Balance
FY 2026-27         88,257        20,223           0      24,79,777
FY 2027-28       2,08,804        51,548           0      24,28,229
FY 2028-29       2,04,247        56,105           0      23,72,124
...
```

**The truth about "flat" rates, fees and affordability:**

```text
$ emi flat 10 3y
10% flat for 3 years costs the same as 17.92% on a reducing balance.

$ emi apr 5L 11 5y --fees 10000
You receive   ₹4,90,000  (after ₹10,000 fees)
EMI           ₹10,871.21
Quoted rate   11%
Real APR      11.88%  (effective yearly 12.55%)

$ emi afford 30000 8.5 20y
An EMI of ₹30,000 at 8.5% for 20 years repays a loan of up to ₹34,56,925 (₹34.57 L).
```

## As a library

```python
from emiplanner import emi, schedule, flat_to_reducing

emi("25L", 8.5, 240)                                     # Decimal('21696')
plan = schedule(2_500_000, 8.5, 240, prepayments={12: 200_000})
plan.months, plan.total_interest                         # (200, Decimal('2038503.00'))
flat_to_reducing(10, 36)                                 # Decimal('17.92')
```

## How it works

### 1. One month of a loan

Everything comes from what happens in a single month:

```text
interest  = balance × (yearly rate ÷ 12 ÷ 100)
principal = EMI − interest              ← the part that actually reduces your loan
balance   = balance − principal
```

Early on the balance is large, so most of the EMI is interest. Look at month 1 above: ₹4,167 of ₹43,958 is interest.
As the balance shrinks, interest falls and more of each EMI goes to principal.
On a 20-year home loan, interest is more than half of everything you pay.

### 2. The EMI formula

The EMI is the one fixed payment that brings the balance to exactly zero after *n* months:

```text
EMI = P × r × (1 + r)ⁿ / ((1 + r)ⁿ − 1)        r = monthly rate, n = months
```

Banks round the EMI to the rupee. That leaves a few paise over (or short) each month, and the **last EMI** absorbs the difference. That is why the October instalment above is ₹43,957.

### 3. Why prepaying to cut the tenure saves more

After a prepayment the bank can either:

- **keep the EMI**: the loan simply ends earlier, so you skip the last few years of payments; or
- **recalculate the EMI** for the remaining balance over the original remaining months: your EMI drops, but you still pay interest for all 20 years.

The program builds both schedules and compares them. You can see that in `prepayment_savings()` in `loan.py`.

### 4. Flat rate → real rate (solving an equation backwards)

A flat rate charges interest on the *original* amount for the whole loan, even though you repay some of it every month.
There's no formula that turns the flat EMI back into a reducing rate, so we **search** for it with *bisection*:

1. The real rate is somewhere between 0% and 6,000% a year.
2. Try the middle. If its EMI is too low, the answer is in the upper half; otherwise it is in the lower half.
3. Repeat 100 times. Each step halves the range, so the answer becomes extremely precise.

The APR calculation uses the same search. It finds the rate at which your EMIs are worth exactly the money you *received* after fees.

### 5. Money is `Decimal`, never `float`

```python
>>> round(2.675, 2)              # float: 2.675 is really 2.67499999...
2.67
>>> paise(Decimal("2.675"))      # emiplanner
Decimal('2.68')
```

Over 240 instalments, float errors add up. `money.py` keeps every amount as a `Decimal` and rounds to paise with `ROUND_HALF_UP`, as a bank statement does.

## What you'll learn

- Amortization: why interest is front-loaded and how a balance actually falls
- Turning a formula into code, and testing it against an independent implementation
- Bisection: solving equations that have no closed-form answer
- Why `float` is wrong for money, and how to use `decimal.Decimal` properly
- Date edge cases: 31 January + 1 month = 28/29 February; Indian financial years run April–March
- A friendly CLI with `argparse` sub-commands and custom argument types (`25L`, `2y6m`, `12:2L`)

## Try it yourself

1. **Step-up EMI.** Let the EMI grow by 5% each year, as your salary does. How many years does that save?
2. **Rate change.** Add `--rate-change 36:9.25` to change the interest rate from month 36 on, as floating-rate home loans do.
3. **Prepayment penalty.** Some loans charge 2–4% on prepaid amounts. Add a `--penalty` option and show whether prepaying is still worth it.
4. **Invest instead?** Compare prepaying ₹2 L now with investing it at 10% a year for the rest of the loan.
5. **Newton's method.** Replace bisection with Newton's method in `_solve_rate` and count how many steps each takes.

## Run the tests

```bash
pip install -e ".[dev]"
pytest -q          # 61 tests
```

*This tool does arithmetic, not financial advice. Your bank's exact figures can differ slightly because of how it rounds, the day it debits the EMI, or broken-period interest.*

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
