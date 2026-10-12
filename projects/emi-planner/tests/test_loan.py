from datetime import date
from decimal import Decimal

import pytest

from emiplanner import (
    LoanError, apr, emi, flat_to_reducing, prepayment_savings, principal_for, schedule,
)
from emiplanner.loan import _add_months
from emiplanner.money import PAISA

D = Decimal


def float_emi(p, rate, n):
    """Independent textbook formula in plain floats, to check against."""
    r = rate / 1200
    return p * r * (1 + r) ** n / ((1 + r) ** n - 1)


@pytest.mark.parametrize("p, rate, n", [(2_500_000, 8.5, 240), (500_000, 10.5, 60), (100_000, 13, 12),
                                        (7_350_000, 9.15, 300), (40_000, 18, 6)])
def test_emi_matches_the_formula(p, rate, n):
    assert emi(p, rate, n) == D(round(float_emi(p, rate, n)))
    assert abs(emi(p, rate, n, rounding=PAISA) - D(str(float_emi(p, rate, n)))) < D("0.01")


def test_zero_interest_loan():
    assert emi(120_000, 0, 12) == 10_000
    s = schedule(120_000, 0, 12)
    assert s.total_interest == 0 and s.months == 12


@pytest.mark.parametrize("p, rate, n", [(2_500_000, 8.5, 240), (333_333, 11.25, 37), (999, 24, 3)])
def test_schedule_adds_up(p, rate, n):
    s = schedule(p, rate, n)
    assert s.months == n
    assert s.rows[-1].closing == 0
    assert sum(r.principal for r in s.rows) == p
    assert s.total_paid == p + s.total_interest
    # Every month: opening − principal = closing, and the EMI never changes except the last one.
    for r in s.rows:
        assert r.opening - r.principal - r.prepayment == r.closing
        assert r.payment == r.interest + r.principal
    assert {r.payment for r in s.rows[:-1]} == {s.emi}
    # Rounding the EMI to the rupee leaves up to ₹0.50 a month too much or too
    # little; with interest that grows like a savings plan, and the last
    # instalment absorbs it.
    r = rate / 1200
    assert abs(s.rows[-1].payment - s.emi) <= D(0.5 * ((1 + r) ** n - 1) / r)
    # With the EMI kept to the paisa, the last instalment is within a rupee.
    exact = schedule(p, rate, n, rounding=PAISA)
    assert abs(exact.rows[-1].payment - exact.emi) < 1


def test_interest_falls_and_principal_rises_over_time():
    rows = schedule(1_000_000, 9, 120).rows
    assert all(a.interest >= b.interest for a, b in zip(rows, rows[1:-1]))
    assert all(a.principal <= b.principal for a, b in zip(rows, rows[1:-1]))


def test_prepayment_cut_tenure_keeps_the_emi():
    base = schedule(2_500_000, 8.5, 240)
    s = schedule(2_500_000, 8.5, 240, prepayments={12: 200_000})
    assert s.rows[11].prepayment == 200_000
    assert {r.payment for r in s.rows[:-1]} == {base.emi}
    assert s.months < 240
    assert sum(r.principal + r.prepayment for r in s.rows) == 2_500_000


def test_prepayment_cut_emi_keeps_the_end_date():
    s = schedule(2_500_000, 8.5, 240, prepayments={12: 200_000}, reduce="emi")
    assert s.months == 240
    before, after = s.rows[11].payment, s.rows[12].payment
    assert after < before
    # The new EMI is exactly the EMI for the remaining balance over the remaining months.
    assert after == emi(s.rows[11].closing, 8.5, 228)


def test_cutting_tenure_saves_more_interest():
    r = prepayment_savings(2_500_000, 8.5, 240, {12: 200_000, 24: 100_000})
    assert r["tenure"]["interest_saved"] > r["emi"]["interest_saved"] > 0
    assert r["tenure"]["months_saved"] > 0 and r["emi"]["months_saved"] == 0


def test_prepaying_everything_closes_the_loan():
    s = schedule(100_000, 12, 12, prepayments={3: 10**9})
    assert s.months == 3 and s.rows[-1].closing == 0
    assert s.rows[-1].prepayment == s.rows[-1].opening - s.rows[-1].principal


def test_schedule_from_emi_only():
    s = schedule(1_000_000, 9, monthly_emi=20_000)
    assert s.rows[-1].closing == 0
    assert 55 <= s.months <= 65


def test_dates_and_financial_years():
    s = schedule(500_000, 10, 24, start=date(2027, 1, 31))
    assert [r.due for r in s.rows[:3]] == [date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 31)]
    years = s.by_year()
    assert [y["period"] for y in years] == ["FY 2026-27", "FY 2027-28", "FY 2028-29"]
    assert sum(y["interest"] for y in years) == s.total_interest
    assert years[-1]["closing"] == 0
    assert schedule(500_000, 10, 24).by_year()[1]["period"] == "Year 2"


def test_add_months_clamps_to_month_end():
    assert _add_months(date(2024, 1, 31), 1) == date(2024, 2, 29)
    assert _add_months(date(2023, 1, 31), 1) == date(2023, 2, 28)
    assert _add_months(date(2026, 11, 5), 14) == date(2028, 1, 5)


def test_flat_rate_is_much_higher_than_it_looks():
    assert flat_to_reducing(10, 36) == D("17.92")
    assert flat_to_reducing(0, 12) == 0
    # Check the other way round: the reducing rate gives the same EMI as the flat deal.
    real = flat_to_reducing(7, 60)
    flat_emi = 100_000 * (1 + D("0.07") * 5) / 60
    assert abs(emi(100_000, real, 60, rounding=PAISA) - flat_emi) < 1


def test_apr_with_and_without_fees():
    no_fees = apr(500_000, 11, 60, 0)
    assert no_fees["apr"] == D("11.00")
    assert no_fees["effective_annual"] == D("11.57")  # (1 + 0.11/12)^12 − 1
    with_fees = apr(500_000, 11, 60, 10_000)
    assert with_fees["received"] == 490_000
    assert with_fees["apr"] == D("11.88")


def test_afford_is_the_inverse_of_emi():
    p = principal_for(30_000, 8.5, 240)
    assert emi(p, 8.5, 240, rounding=PAISA) == D("30000.00")
    assert principal_for(10_000, 0, 12) == 120_000


@pytest.mark.parametrize("call, message", [
    (lambda: emi(0, 8, 12), "loan amount must be more than zero"),
    (lambda: emi(1000, -1, 12), "can't be negative"),
    (lambda: emi(1000, 8, 0), "tenure must be"),
    (lambda: schedule(1_000_000, 12, monthly_emi=10_000), "doesn't even cover the first month's interest"),
    (lambda: schedule(1000, 8), "give the tenure"),
    (lambda: schedule(1000, 8, 12, reduce="sideways"), "reduce must be"),
    (lambda: schedule(1000, 8, monthly_emi=100, reduce="emi"), "needs a fixed tenure"),
    (lambda: apr(1000, 8, 12, fees=1000), "fees must be"),
])
def test_helpful_errors(call, message):
    with pytest.raises(LoanError, match=message):
        call()
