"""Loan maths: EMI, amortization schedule, prepayments, flat rates and APR.

All of it follows from one idea. Each month the bank charges interest on what
you still owe, and the rest of your EMI pays the loan down:

    interest  = balance × monthly rate
    principal = EMI − interest
    balance   = balance − principal

The EMI formula is just the fixed payment that makes this reach exactly zero
after n months.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, localcontext

from .money import PAISA, RUPEE, Amount, paise, to_decimal

MAX_MONTHS = 100 * 12


class LoanError(ValueError):
    pass


def monthly_rate(annual_rate_pct: Amount) -> Decimal:
    """12% a year is 1% a month (banks quote nominal rates, compounded monthly)."""
    rate = to_decimal(annual_rate_pct)
    if rate < 0:
        raise LoanError("interest rate can't be negative")
    return rate / 1200


def emi(principal: Amount, annual_rate_pct: Amount, months: int, rounding: Decimal = RUPEE) -> Decimal:
    """The fixed monthly instalment, rounded to the rupee by default (as banks do).

    EMI = P × r × (1 + r)^n / ((1 + r)^n − 1)
    """
    p = _positive(principal, "loan amount")
    _check_months(months)
    r = monthly_rate(annual_rate_pct)
    with localcontext() as ctx:
        ctx.prec = 40
        if r == 0:
            exact = p / months
        else:
            growth = (1 + r) ** months
            exact = p * r * growth / (growth - 1)
    return exact.quantize(rounding, rounding="ROUND_HALF_UP")


def principal_for(monthly_emi: Amount, annual_rate_pct: Amount, months: int) -> Decimal:
    """How big a loan an EMI can carry — the EMI formula solved for P."""
    e = _positive(monthly_emi, "EMI")
    _check_months(months)
    r = monthly_rate(annual_rate_pct)
    with localcontext() as ctx:
        ctx.prec = 40
        if r == 0:
            return paise(e * months)
        growth = (1 + r) ** months
        return paise(e * (growth - 1) / (r * growth))


@dataclass(frozen=True)
class Row:
    month: int
    due: date | None
    opening: Decimal
    payment: Decimal
    interest: Decimal
    principal: Decimal
    prepayment: Decimal
    closing: Decimal


@dataclass
class Schedule:
    principal: Decimal
    annual_rate: Decimal
    emi: Decimal
    rows: list[Row] = field(default_factory=list)

    @property
    def months(self) -> int:
        return len(self.rows)

    @property
    def total_interest(self) -> Decimal:
        return sum((r.interest for r in self.rows), Decimal(0))

    @property
    def total_prepaid(self) -> Decimal:
        return sum((r.prepayment for r in self.rows), Decimal(0))

    @property
    def total_paid(self) -> Decimal:
        return sum((r.payment + r.prepayment for r in self.rows), Decimal(0))

    def by_year(self) -> list[dict]:
        """Totals per loan year, or per Indian financial year (April–March) when
        the schedule has dates — handy for income-tax proofs."""
        key: Callable[[Row], str]
        if self.rows and self.rows[0].due:
            key = lambda r: _financial_year(r.due)  # noqa: E731
        else:
            key = lambda r: f"Year {(r.month - 1) // 12 + 1}"  # noqa: E731
        out: dict[str, dict] = {}
        for row in self.rows:
            y = out.setdefault(key(row), {"period": key(row), "interest": Decimal(0), "principal": Decimal(0),
                                          "prepayment": Decimal(0), "closing": row.closing})
            y["interest"] += row.interest
            y["principal"] += row.principal
            y["prepayment"] += row.prepayment
            y["closing"] = row.closing
        return list(out.values())


def schedule(
    principal: Amount,
    annual_rate_pct: Amount,
    months: int | None = None,
    *,
    monthly_emi: Amount | None = None,
    prepayments: Mapping[int, Amount] | None = None,
    reduce: str = "tenure",
    start: date | None = None,
    rounding: Decimal = RUPEE,
) -> Schedule:
    """Builds the month-by-month amortization table.

    ``prepayments`` maps a month number to an extra payment made with that
    month's EMI. Afterwards the bank either keeps your EMI and shortens the
    loan (``reduce="tenure"``) or keeps the end date and lowers the EMI
    (``reduce="emi"``).

    Give ``months`` (the EMI is worked out) or ``monthly_emi`` (the loan runs
    until it is repaid), or both.
    """
    p = _positive(principal, "loan amount")
    rate = to_decimal(annual_rate_pct)
    r = monthly_rate(rate)
    if reduce not in ("tenure", "emi"):
        raise LoanError("reduce must be 'tenure' or 'emi'")
    if months is None and monthly_emi is None:
        raise LoanError("give the tenure in months, the EMI, or both")
    if months is not None:
        _check_months(months)
    if reduce == "emi" and months is None:
        raise LoanError("reducing the EMI needs a fixed tenure to spread the balance over")

    payment = to_decimal(monthly_emi) if monthly_emi is not None else emi(p, rate, months, rounding)
    if payment <= paise(p * r):
        raise LoanError(
            f"an EMI of {payment} doesn't even cover the first month's interest ({paise(p * r)}); "
            "the loan would never be repaid"
        )
    extra = {int(m): to_decimal(a) for m, a in (prepayments or {}).items()}
    if any(a < 0 for a in extra.values()) or any(m < 1 for m in extra):
        raise LoanError("prepayments need a month ≥ 1 and an amount ≥ 0")

    plan = Schedule(principal=p, annual_rate=rate, emi=payment)
    balance = p
    month = 0
    while balance > 0:
        month += 1
        if month > MAX_MONTHS:
            raise LoanError(f"loan isn't repaid within {MAX_MONTHS // 12} years at this EMI")
        opening = balance
        interest = paise(balance * r)
        principal_part = payment - interest
        # The last instalment clears whatever is left — also absorbing the
        # few rupees that rounding the EMI leaves over.
        if principal_part >= balance or month == months:
            principal_part = balance
        balance -= principal_part
        prepay = min(extra.get(month, Decimal(0)), balance)
        balance -= prepay
        plan.rows.append(Row(month, _add_months(start, month - 1) if start else None, opening,
                             interest + principal_part, interest, principal_part, prepay, balance))
        if prepay and reduce == "emi" and balance > 0:
            payment = emi(balance, rate, months - month, rounding)
    return plan


def prepayment_savings(principal: Amount, annual_rate_pct: Amount, months: int,
                       prepayments: Mapping[int, Amount]) -> dict[str, dict]:
    """Compares no prepayment with both ways a bank can apply one."""
    base = schedule(principal, annual_rate_pct, months)
    out = {}
    for mode in ("tenure", "emi"):
        s = schedule(principal, annual_rate_pct, months, prepayments=prepayments, reduce=mode)
        out[mode] = {
            "months": s.months,
            "months_saved": base.months - s.months,
            "interest": s.total_interest,
            "interest_saved": base.total_interest - s.total_interest,
            "final_emi": s.rows[-2].payment if s.months > 1 else s.rows[-1].payment,
        }
    out["none"] = {"months": base.months, "interest": base.total_interest}
    return out


def _solve_rate(f: Callable[[Decimal], Decimal], target: Decimal, high: Decimal = Decimal(5)) -> Decimal:
    """Monthly rate r in [0, high] with f(r) == target, for f increasing in r.

    Bisection: halve the interval 100 times. Slower than Newton's method but it
    can't diverge, and 100 halvings is far more precision than paise need.
    """
    low = Decimal(0)
    with localcontext() as ctx:
        ctx.prec = 40
        for _ in range(100):
            mid = (low + high) / 2
            if f(mid) < target:
                low = mid
            else:
                high = mid
    return (low + high) / 2


def _emi_per_rupee(r: Decimal, n: int) -> Decimal:
    if r == 0:
        return Decimal(1) / n
    growth = (1 + r) ** n
    return r * growth / (growth - 1)


def flat_to_reducing(flat_rate_pct: Amount, months: int) -> Decimal:
    """The real (reducing-balance) yearly rate hidden behind a flat rate.

    A flat rate charges interest on the *original* amount for the whole loan,
    even though you repay part of it every month. "10% flat" for 3 years:
    interest = 10% × 3 = 30% of the loan, EMI = 130% / 36. This finds the
    reducing rate with the same EMI.
    """
    _check_months(months)
    flat = to_decimal(flat_rate_pct)
    target = (1 + flat / 100 * months / 12) / months
    r = _solve_rate(lambda x: _emi_per_rupee(x, months), target)
    return (r * 1200).quantize(PAISA)


def apr(principal: Amount, annual_rate_pct: Amount, months: int, fees: Amount = 0) -> dict[str, Decimal]:
    """True cost of a loan once upfront fees are counted.

    With a ₹10,000 processing fee on a ₹5 L loan you only receive ₹4.9 L but
    repay EMIs calculated on ₹5 L. The APR is the rate at which those EMIs are
    worth exactly what you received.
    """
    p = _positive(principal, "loan amount")
    charges = to_decimal(fees)
    received = p - charges
    if charges < 0 or received <= 0:
        raise LoanError("fees must be ≥ 0 and less than the loan amount")
    payment = emi(p, annual_rate_pct, months, rounding=PAISA)
    # Present value of the EMIs falls as the rate rises; solve on 1/PV so the
    # function increases with r, as _solve_rate expects.
    def inverse_pv(r: Decimal) -> Decimal:
        return _emi_per_rupee(r, months) / payment

    r = _solve_rate(inverse_pv, 1 / received)
    with localcontext() as ctx:
        ctx.prec = 40
        effective = ((1 + r) ** 12 - 1) * 100
    return {
        "emi": payment,
        "received": received,
        "apr": (r * 1200).quantize(PAISA),
        "effective_annual": effective.quantize(PAISA),
    }


def _positive(value: Amount, what: str) -> Decimal:
    d = to_decimal(value)
    if d <= 0:
        raise LoanError(f"{what} must be more than zero")
    return d


def _check_months(months: int) -> None:
    if not isinstance(months, int) or isinstance(months, bool) or not 1 <= months <= MAX_MONTHS:
        raise LoanError(f"tenure must be a whole number of months from 1 to {MAX_MONTHS}")


def _add_months(d: date, n: int) -> date:
    """Same day n months later, clamped to the month's end (31 Jan + 1 → 28/29 Feb)."""
    total = d.month - 1 + n
    year, month = d.year + total // 12, total % 12 + 1
    days_in_month = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
                     31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return date(year, month, min(d.day, days_in_month))


def _financial_year(d: date) -> str:
    start = d.year if d.month >= 4 else d.year - 1
    return f"FY {start}-{(start + 1) % 100:02d}"
