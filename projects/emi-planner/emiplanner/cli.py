"""Command line: `emi <command> ...`. Run `emi -h` for the list."""

from __future__ import annotations

import argparse
import csv
import re
import sys
from datetime import date
from decimal import Decimal

from . import loan
from .money import MoneyError, format_inr, short_inr, to_decimal


def tenure(text: str) -> int:
    """'20y', '20 years', '18m', '2y6m' or a bare number of years → months."""
    t = text.strip().lower().replace(" ", "")
    if re.fullmatch(r"\d+(\.\d+)?", t):
        t += "y"
    m = re.fullmatch(r"(?:(\d+(?:\.\d+)?)y(?:ears?|rs?)?)?(?:(\d+)m(?:onths?)?)?", t)
    if not m or not any(m.groups()):
        raise argparse.ArgumentTypeError(f"tenure like 20y, 240m or 2y6m, not {text!r}")
    months = Decimal(m.group(1) or 0) * 12 + int(m.group(2) or 0)
    if months != int(months) or months < 1:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number of months")
    return int(months)


def amount(text: str) -> Decimal:
    try:
        return to_decimal(text)
    except MoneyError as e:
        raise argparse.ArgumentTypeError(str(e)) from None


def prepayment(text: str) -> tuple[int, Decimal]:
    """'12:2L' = ₹2 lakh extra with the 12th EMI."""
    month, sep, value = text.partition(":")
    if not sep or not month.strip().isdigit():
        raise argparse.ArgumentTypeError(f"prepayment like 12:200000 or 12:2L, not {text!r}")
    return int(month), amount(value)


def start_month(text: str) -> date:
    try:
        y, m = text.split("-")[:2]
        return date(int(y), int(m), 5 if text.count("-") == 1 else int(text.split("-")[2]))
    except ValueError:
        raise argparse.ArgumentTypeError(f"date like 2026-11 or 2026-11-05, not {text!r}") from None


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="emi", description="Plan a loan: EMI, schedule, prepayments, real cost.")
    sub = p.add_subparsers(dest="command", required=True)

    def loan_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("amount", type=amount, help="loan amount: 2500000, 25L, 1.2cr")
        sp.add_argument("rate", type=amount, help="yearly interest rate in %%, e.g. 8.5")
        sp.add_argument("tenure", type=tenure, help="20y, 240m, 2y6m (a bare number means years)")

    sp = sub.add_parser("emi", help="monthly EMI and total cost")
    loan_args(sp)

    sp = sub.add_parser("schedule", help="month-by-month amortization table")
    loan_args(sp)
    sp.add_argument("--prepay", type=prepayment, action="append", default=[], metavar="MONTH:AMOUNT",
                    help="extra payment with that month's EMI (repeatable)")
    sp.add_argument("--reduce", choices=["tenure", "emi"], default="tenure",
                    help="after a prepayment, shorten the loan (default) or lower the EMI")
    sp.add_argument("--start", type=start_month, help="first EMI date, e.g. 2026-11 (enables financial years)")
    sp.add_argument("--yearly", action="store_true", help="one line per year instead of per month")
    sp.add_argument("--csv", metavar="FILE", help="also write the full schedule to a CSV file")

    sp = sub.add_parser("prepay", help="how much a prepayment saves, both ways")
    loan_args(sp)
    sp.add_argument("--prepay", type=prepayment, action="append", required=True, metavar="MONTH:AMOUNT")

    sp = sub.add_parser("flat", help="convert a 'flat' rate to the real reducing-balance rate")
    sp.add_argument("rate", type=amount)
    sp.add_argument("tenure", type=tenure)

    sp = sub.add_parser("apr", help="true yearly cost including processing fees")
    loan_args(sp)
    sp.add_argument("--fees", type=amount, required=True, help="processing fee + other upfront charges")

    sp = sub.add_parser("afford", help="largest loan a monthly EMI can pay for")
    sp.add_argument("emi", type=amount)
    sp.add_argument("rate", type=amount)
    sp.add_argument("tenure", type=tenure)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        handler = globals()[f"cmd_{args.command}"]
        handler(args)
    except (loan.LoanError, MoneyError) as e:
        print(f"emi: {e}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        pass
    return 0


def years_months(months: int) -> str:
    y, m = divmod(months, 12)
    parts = [f"{y} year{'s' * (y != 1)}"] if y else []
    if m:
        parts.append(f"{m} month{'s' * (m != 1)}")
    return " ".join(parts)


def cmd_emi(a: argparse.Namespace) -> None:
    s = loan.schedule(a.amount, a.rate, a.tenure)
    share = s.total_interest / s.total_paid * 100
    print(f"Loan          {format_inr(a.amount, 0)} at {a.rate}% for {years_months(a.tenure)}")
    print(f"EMI           {format_inr(s.emi, 0)} per month")
    print(f"Interest      {format_inr(s.total_interest, 0)}  ({share:.1f}% of everything you pay)")
    print(f"Total paid    {format_inr(s.total_paid, 0)}")


def cmd_schedule(a: argparse.Namespace) -> None:
    s = loan.schedule(a.amount, a.rate, a.tenure, prepayments=dict(a.prepay), reduce=a.reduce, start=a.start)
    if a.yearly:
        print(f"{'Period':<11}{'Interest':>14}{'Principal':>14}{'Prepaid':>12}{'Balance':>15}")
        for y in s.by_year():
            print(f"{y['period']:<11}{format_inr(y['interest'], 0, False):>14}{format_inr(y['principal'], 0, False):>14}"
                  f"{format_inr(y['prepayment'], 0, False):>12}{format_inr(y['closing'], 0, False):>15}")
    else:
        print(f"{'Month':<9}{'EMI':>10}{'Interest':>11}{'Principal':>11}{'Prepaid':>10}{'Balance':>14}")
        for r in s.rows:
            label = r.due.strftime("%b %Y") if r.due else str(r.month)
            print(f"{label:<9}{format_inr(r.payment, 0, False):>10}{format_inr(r.interest, 0, False):>11}"
                  f"{format_inr(r.principal, 0, False):>11}{format_inr(r.prepayment, 0, False):>10}"
                  f"{format_inr(r.closing, 0, False):>14}")
    print(f"\n{s.months} EMIs ({years_months(s.months)}), interest {format_inr(s.total_interest, 0)}, "
          f"total paid {format_inr(s.total_paid, 0)}")
    if a.csv:
        with open(a.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["month", "due", "opening", "emi", "interest", "principal", "prepayment", "closing"])
            for r in s.rows:
                w.writerow([r.month, r.due or "", r.opening, r.payment, r.interest, r.principal, r.prepayment, r.closing])
        print(f"Wrote {a.csv}")


def cmd_prepay(a: argparse.Namespace) -> None:
    result = loan.prepayment_savings(a.amount, a.rate, a.tenure, dict(a.prepay))
    none, ten, emi_ = result["none"], result["tenure"], result["emi"]
    total = sum(v for _, v in a.prepay)
    print(f"Prepaying {short_inr(total)} on a {short_inr(a.amount)} loan at {a.rate}% for {years_months(a.tenure)}:\n")
    print(f"{'':<22}{'Interest':>14}{'Saved':>14}  Loan ends after")
    print(f"{'No prepayment':<22}{format_inr(none['interest'], 0):>14}{'—':>14}  {years_months(none['months'])}")
    print(f"{'Keep EMI, cut tenure':<22}{format_inr(ten['interest'], 0):>14}{format_inr(ten['interest_saved'], 0):>14}  "
          f"{years_months(ten['months'])} ({ten['months_saved']} EMIs fewer)")
    print(f"{'Keep tenure, cut EMI':<22}{format_inr(emi_['interest'], 0):>14}{format_inr(emi_['interest_saved'], 0):>14}  "
          f"{years_months(emi_['months'])} (EMI drops to {format_inr(emi_['final_emi'], 0)})")
    best = "cutting the tenure" if ten["interest_saved"] >= emi_["interest_saved"] else "cutting the EMI"
    print(f"\nBest for total interest: {best}.")


def cmd_flat(a: argparse.Namespace) -> None:
    real = loan.flat_to_reducing(a.rate, a.tenure)
    print(f"{a.rate}% flat for {years_months(a.tenure)} costs the same as {real}% on a reducing balance.")


def cmd_apr(a: argparse.Namespace) -> None:
    r = loan.apr(a.amount, a.rate, a.tenure, a.fees)
    print(f"You receive   {format_inr(r['received'], 0)}  (after {format_inr(a.fees, 0)} fees)")
    print(f"EMI           {format_inr(r['emi'])}")
    print(f"Quoted rate   {a.rate}%")
    print(f"Real APR      {r['apr']}%  (effective yearly {r['effective_annual']}%)")


def cmd_afford(a: argparse.Namespace) -> None:
    p = loan.principal_for(a.emi, a.rate, a.tenure)
    print(f"An EMI of {format_inr(a.emi, 0)} at {a.rate}% for {years_months(a.tenure)} "
          f"repays a loan of up to {format_inr(p, 0)} ({short_inr(p)}).")


if __name__ == "__main__":
    sys.exit(main())
