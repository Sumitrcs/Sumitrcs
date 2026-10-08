from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from bankrecon import (
    Entry, InputError, MatchConfig, Reconciler, extract_reference, load_entries, parse_amount,
    parse_date, reconcile, render, similarity, suggest,
)
from bankrecon.cli import main

EX = Path(__file__).resolve().parent.parent / "examples"
D = Decimal


def e(id, d, desc, amt, ref=None):
    return Entry(id, date.fromisoformat(d), desc, D(str(amt)), ref)


def test_parsing_helpers():
    assert parse_date("05/06/2026") == date(2026, 6, 5)
    assert parse_date("05-Jun-2026") == date(2026, 6, 5)
    assert parse_amount("1,23,456.78") == D("123456.78")
    assert parse_amount("500.00 Dr") == D("-500.00")
    assert parse_amount("(250)") == D("-250")
    assert parse_amount("") == 0
    with pytest.raises(InputError):
        parse_date("2026/31/12")
    with pytest.raises(InputError):
        parse_amount("abc")


def test_reference_extraction():
    assert extract_reference("NEFT/HDFCN26152345678/ACME") == "HDFCN26152345678"
    assert extract_reference("CHQ NO 004512 PAID RENT") == "004512"
    assert extract_reference("UTR: SBIN0012345678 salary") == "SBIN0012345678"
    assert extract_reference("cash deposit") is None


def test_similarity_ignores_noise_words():
    assert similarity("NEFT/BHARAT FOODS LTD", "Bharat Foods - SEO retainer") > 0.3
    assert similarity("AWS INDIA", "Rent June") < 0.3


def test_reference_beats_amount_only_match():
    bank = [e("b1", "2026-06-10", "CHQ NO 000111 X", -500)]
    books = [e("k1", "2026-06-10", "Vendor A", -500), e("k2", "2026-06-12", "Vendor B", -500, "000111")]
    m = Reconciler(bank, books).run()
    assert m[0].kind == "reference" and m[0].books[0].id == "k2"


def test_greedy_global_ranking_prefers_closest_dates():
    # Two equal amounts: each bank line should pair with the book entry closest in date.
    bank = [e("b1", "2026-06-01", "x", 1000), e("b2", "2026-06-04", "y", 1000)]
    books = [e("k1", "2026-06-04", "y", 1000), e("k2", "2026-06-01", "x", 1000)]
    pairs = {m.bank[0].id: m.books[0].id for m in Reconciler(bank, books).run()}
    assert pairs == {"b1": "k2", "b2": "k1"}


def test_window_is_respected():
    bank = [e("b1", "2026-06-20", "payment", -999)]
    books = [e("k1", "2026-06-01", "unrelated", -999)]
    assert Reconciler(bank, books, MatchConfig(window_days=3, fuzzy_window_days=10)).run() == []


def test_fuzzy_requires_similar_narration():
    bank = [e("b1", "2026-06-10", "IMPS/ZOMATO MEDIA", -450)]
    books = [e("k1", "2026-06-02", "Zomato team lunch", -450), e("k2", "2026-06-03", "Courier", -450)]
    m = Reconciler(bank, books).run()
    assert len(m) == 1 and m[0].kind == "fuzzy" and m[0].books[0].id == "k1"


def test_split_one_bank_line_to_many_book_entries():
    bank = [e("b1", "2026-06-06", "CASH DEPOSIT", 25000)]
    books = [e("k1", "2026-06-05", "cash 1", 15000), e("k2", "2026-06-05", "cash 2", 10000), e("k3", "2026-06-05", "other", 7000)]
    m = Reconciler(bank, books).run()
    assert m[0].kind == "split" and {x.id for x in m[0].books} == {"k1", "k2"}


def test_split_many_bank_lines_to_one_book_entry():
    bank = [e("b1", "2026-06-06", "part 1", -300), e("b2", "2026-06-07", "part 2", -200)]
    books = [e("k1", "2026-06-06", "vendor payment", -500)]
    m = Reconciler(bank, books).run()
    assert m[0].kind == "split" and len(m[0].bank) == 2


def test_brs_on_examples_reconciles():
    bank = load_entries(EX / "bank_statement.csv", "bank")
    books = load_entries(EX / "cash_book.csv", "books")
    brs = reconcile(bank, books, D(120000), D(120000))
    assert brs.reconciled
    assert [x.id for x in brs.cheques_issued_not_presented] == ["PMT-205"]
    assert [x.id for x in brs.deposits_not_credited] == ["RCT-106"]
    assert len(brs.credits_not_in_books) == 1 and len(brs.debits_not_in_books) == 1
    text = render(brs)
    assert "RECONCILED" in text and "Interest credited" in text


def test_brs_detects_a_real_difference():
    bank = [e("b1", "2026-06-01", "deposit", 1000)]
    books = [e("k1", "2026-06-01", "deposit", 1000)]
    brs = reconcile(bank, books, opening_books=D(0), opening_bank=D(50))
    assert not brs.reconciled and brs.difference == 50


def test_suggestions():
    assert "charges" in suggest(e("b", "2026-01-01", "SMS ALERT CHRG", -10)).lower()
    assert "Interest" in suggest(e("b", "2026-01-01", "INT.PD Q1", 10))
    assert "investigate" in suggest(e("b", "2026-01-01", "random", 10))


def test_cli(tmp_path, capsys):
    out_csv = tmp_path / "matches.csv"
    code = main(["--bank", str(EX / "bank_statement.csv"), "--books", str(EX / "cash_book.csv"),
                 "--opening-books", "120000", "--opening-bank", "120000", "--export", str(out_csv)])
    assert code == 0
    assert "RECONCILED" in capsys.readouterr().out
    rows = out_csv.read_text().splitlines()
    assert rows[0].startswith("status,match_type")
    assert any(r.startswith("bank_only") for r in rows)
