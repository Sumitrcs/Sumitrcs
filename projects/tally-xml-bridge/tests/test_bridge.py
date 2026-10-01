import xml.etree.ElementTree as ET
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from tallybridge import (
    Ledger, LedgerLine, Voucher, VoucherError, ledgers_to_xml, parse_vouchers, read_gst_sales_csv,
    read_journal_csv, required_ledgers, vouchers_to_csv, vouchers_to_xml,
)
from tallybridge.cli import main

EX = Path(__file__).resolve().parent.parent / "examples"
D = Decimal


def test_journal_csv_groups_lines_into_balanced_vouchers():
    vs = read_journal_csv(EX / "journal.csv")
    assert [v.number for v in vs] == ["PMT/001", "INV/001", "RCT/001"]
    sale = vs[1]
    assert sale.voucher_type == "Sales" and sale.party == "Acme Traders"
    assert sale.total == D("59000.00")
    assert sale.narration == "Website development"


def test_unbalanced_voucher_is_rejected(tmp_path):
    p = tmp_path / "bad.csv"
    p.write_text("date,voucher_type,voucher_no,ledger,debit,credit\n2026-04-01,Journal,J1,A,100,\n2026-04-01,Journal,J1,B,,99\n")
    with pytest.raises(VoucherError, match="differ by 1.00"):
        read_journal_csv(p)


def test_line_with_both_sides_is_rejected(tmp_path):
    p = tmp_path / "bad.csv"
    p.write_text("date,voucher_type,voucher_no,ledger,debit,credit\n2026-04-01,Journal,J1,A,100,100\n")
    with pytest.raises(VoucherError, match="both debit and credit"):
        read_journal_csv(p)


def test_xml_uses_tally_sign_convention():
    v = Voucher("Journal", date(2026, 4, 1), "J1", [LedgerLine("Expense", D(100)), LedgerLine("Cash", D(-100))])
    root = ET.fromstring(vouchers_to_xml([v]))
    entries = root.findall(".//ALLLEDGERENTRIES.LIST")
    assert entries[0].findtext("ISDEEMEDPOSITIVE") == "Yes" and entries[0].findtext("AMOUNT") == "-100.00"
    assert entries[1].findtext("ISDEEMEDPOSITIVE") == "No" and entries[1].findtext("AMOUNT") == "100.00"
    assert root.findtext(".//DATE") == "20260401"


def test_round_trip_xml_to_vouchers():
    original = read_journal_csv(EX / "journal.csv")
    parsed = parse_vouchers(vouchers_to_xml(original, company="Demo & Co"))
    assert [(v.number, v.date, [(l.ledger, l.amount) for l in v.lines]) for v in parsed] == [
        (v.number, v.date, [(l.ledger, l.amount) for l in v.lines]) for v in original
    ]


def test_special_characters_are_escaped():
    v = Voucher("Journal", date(2026, 4, 1), "J<1>", [LedgerLine("R&D Expense", D(5)), LedgerLine("Cash", D(-5))],
                narration='Quote " and <tag>')
    xml = vouchers_to_xml([v])
    assert "R&amp;D Expense" in xml
    assert parse_vouchers(xml)[0].narration == 'Quote " and <tag>'


def test_gst_sales_intra_and_inter_state():
    vs = read_gst_sales_csv(EX / "invoices.csv", home_state="Delhi")
    intra, inter, rounded = vs
    assert {l.ledger for l in intra.lines} == {"Acme Traders", "Sales @ 18%", "Output CGST @ 9%", "Output SGST @ 9%"}
    assert intra.lines[0].amount == D("53100.00")
    assert any(l.ledger == "Output IGST @ 18%" and l.amount == D("-2222.22") for l in inter.lines)
    # 8999 + 539.94 + 539.94 = 10078.88 -> 10079 with 0.12 round-off credit
    assert rounded.lines[0].amount == D("10079")
    assert any(l.ledger == "Round Off" and l.amount == D("-0.12") for l in rounded.lines)
    for v in vs:
        v.validate()


def test_required_ledgers_guess_groups():
    vs = read_gst_sales_csv(EX / "invoices.csv", home_state="Delhi")
    groups = {l.name: l.group for l in required_ledgers(vs)}
    assert groups["Acme Traders"] == "Sundry Debtors"
    assert groups["Sales @ 18%"] == "Sales Accounts"
    assert groups["Output IGST @ 18%"] == "Duties & Taxes"
    assert groups["Round Off"] == "Indirect Expenses"


def test_ledger_masters_xml():
    xml = ledgers_to_xml([Ledger("Acme Traders", "Sundry Debtors", gstin="07AAACA1234A1Z5", state="Delhi", opening_balance=D(1000))])
    root = ET.fromstring(xml)
    led = root.find(".//LEDGER")
    assert led.get("NAME") == "Acme Traders"
    assert led.findtext("PARENT") == "Sundry Debtors"
    assert led.findtext("OPENINGBALANCE") == "-1000.00"
    with pytest.raises(VoucherError, match="unknown parent group"):
        ledgers_to_xml([Ledger("X", "Not A Group")])


def test_parse_real_tally_daybook_shape():
    xml = """<ENVELOPE><BODY><DATA><TALLYMESSAGE>
      <VOUCHER VCHTYPE="Payment"><DATE>20260415</DATE><VOUCHERNUMBER>7</VOUCHERNUMBER>
        <LEDGERENTRIES.LIST><LEDGERNAME>Electricity</LEDGERNAME><AMOUNT>-2,450.00</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>2,450.00</AMOUNT></LEDGERENTRIES.LIST>
      </VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>"""
    [v] = parse_vouchers(xml)
    assert v.voucher_type == "Payment" and v.lines[0].amount == D("2450.00")
    v.validate()
    assert "Electricity,2450.00," in vouchers_to_csv([v])


def test_invalid_xml_raises():
    with pytest.raises(VoucherError, match="Invalid XML"):
        parse_vouchers("<ENVELOPE>")


def test_cli_end_to_end(tmp_path, capsys):
    out = tmp_path / "sales.xml"
    masters = tmp_path / "masters.xml"
    assert main(["gst-sales", str(EX / "invoices.csv"), "--state", "Delhi", "-o", str(out), "--masters", str(masters)]) == 0
    assert "3 vouchers" in capsys.readouterr().err
    assert main(["to-csv", str(out)]) == 0
    assert "Output IGST @ 18%" in capsys.readouterr().out
    assert "<LEDGER" in masters.read_text()
    assert main(["journal", str(tmp_path / "missing.csv")]) == 1


def test_ledger_names_never_use_exponent_notation(tmp_path):
    p = tmp_path / "inv.csv"
    p.write_text("date,invoice_no,party,taxable_value,gst_rate,place_of_supply\n2026-10-01,A1,X,100,40,Delhi\n")
    names = {l.ledger for l in read_gst_sales_csv(p, home_state="Delhi")[0].lines}
    assert {"Sales @ 40%", "Output CGST @ 20%", "Output SGST @ 20%"} <= names
