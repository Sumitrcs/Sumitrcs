import csv
from decimal import Decimal

import pytest

from emiplanner.cli import main, tenure
from emiplanner.money import MoneyError, format_inr, paise, short_inr, to_decimal

D = Decimal


@pytest.mark.parametrize("text, value", [
    ("2500000", 2_500_000), ("25,00,000", 2_500_000), ("₹25 L", 2_500_000), ("25lakh", 2_500_000),
    ("1.2cr", 12_000_000), ("1.25 Crore", 12_500_000), ("50k", 50_000), ("8.5", D("8.5")),
])
def test_amount_parsing(text, value):
    assert to_decimal(text) == value


def test_floats_are_taken_at_face_value():
    assert to_decimal(8.1) == D("8.1")


@pytest.mark.parametrize("bad", ["abc", "", "1e", "nan", "inf"])
def test_bad_amounts(bad):
    with pytest.raises(MoneyError):
        to_decimal(bad)


@pytest.mark.parametrize("value, text", [
    (D("0"), "₹0.00"), (D("999.5"), "₹999.50"), (D("1000"), "₹1,000.00"), (D("123456.789"), "₹1,23,456.79"),
    (D("12345678"), "₹1,23,45,678.00"), (D("-2500000"), "-₹25,00,000.00"),
])
def test_indian_grouping(value, text):
    assert format_inr(value) == text


def test_short_and_rounding():
    assert short_inr(D(2_500_000)) == "₹25 L"
    assert short_inr(D(12_350_000)) == "₹1.24 Cr"
    assert short_inr(D(8678)) == "₹8,678"
    assert paise(D("0.005")) == D("0.01")
    assert paise(D("2.675")) == D("2.68")  # float rounding would give 2.67


@pytest.mark.parametrize("text, months", [("20y", 240), ("20", 240), ("240m", 240), ("2y6m", 30),
                                          ("1.5y", 18), ("18 months", 18), ("3 years", 36)])
def test_tenure(text, months):
    assert tenure(text) == months


def run(capsys, *args):
    code = main(list(args))
    out = capsys.readouterr()
    return code, out.out, out.err


def test_cli_emi(capsys):
    code, out, _ = run(capsys, "emi", "25L", "8.5", "20y")
    assert code == 0
    assert "EMI           ₹21,696 per month" in out
    assert "Total paid    ₹52,06,777" in out


def test_cli_prepay(capsys):
    _, out, _ = run(capsys, "prepay", "25L", "8.5", "20y", "--prepay", "12:2L")
    assert "Keep EMI, cut tenure" in out and "40 EMIs fewer" in out
    assert "Best for total interest: cutting the tenure." in out


def test_cli_schedule_csv(capsys, tmp_path):
    path = tmp_path / "plan.csv"
    _, out, _ = run(capsys, "schedule", "5L", "10", "1y", "--start", "2026-11", "--csv", str(path))
    assert out.splitlines()[1].startswith("Nov 2026")
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    assert len(rows) == 12 and rows[-1]["closing"] == "0.00"
    assert sum(D(r["principal"]) for r in rows) == 500_000


def test_cli_other_commands(capsys):
    assert "17.92% on a reducing balance" in run(capsys, "flat", "10", "3y")[1]
    assert "Real APR      11.88%" in run(capsys, "apr", "5L", "11", "5y", "--fees", "10000")[1]
    assert "₹34.57 L" in run(capsys, "afford", "30000", "8.5", "20y")[1]


def test_cli_errors_go_to_stderr(capsys):
    code, out, err = run(capsys, "schedule", "10L", "12", "20y", "--prepay", "1:0")
    assert code == 0
    code, out, err = run(capsys, "afford", "0", "8", "1y")
    assert code == 1 and err.startswith("emi: EMI must be more than zero")
    with pytest.raises(SystemExit):
        main(["emi", "25L", "8.5", "twenty"])
