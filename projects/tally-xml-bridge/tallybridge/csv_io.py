"""CSV inputs and outputs.

Journal-style CSV (one row per ledger line, grouped by voucher number):

    date,voucher_type,voucher_no,ledger,debit,credit,narration

Invoice-style CSV for GST sales (one row per invoice):

    date,invoice_no,party,taxable_value,gst_rate,place_of_supply[,sales_ledger]
"""

from __future__ import annotations

import csv
import io
from collections import OrderedDict
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

from .model import Ledger, LedgerLine, Voucher, VoucherError

DATE_FORMATS = ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y")
PAISA = Decimal("0.01")


def parse_date(s: str) -> date:
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            pass
    raise VoucherError(f"Unrecognised date {s!r}")


def money(s: str | None) -> Decimal:
    s = (s or "").replace(",", "").strip()
    if not s:
        return Decimal(0)
    try:
        return Decimal(s).quantize(PAISA)
    except InvalidOperation:
        raise VoucherError(f"Invalid amount {s!r}") from None


def _rows(path: str | Path) -> list[dict[str, str]]:
    with Path(path).open(newline="", encoding="utf-8-sig") as f:
        return [{(k or "").strip().lower(): (v or "").strip() for k, v in r.items()} for r in csv.DictReader(f)]


def read_journal_csv(path: str | Path) -> list[Voucher]:
    grouped: "OrderedDict[str, Voucher]" = OrderedDict()
    for i, r in enumerate(_rows(path), start=2):
        no = r.get("voucher_no") or ""
        if not no:
            raise VoucherError(f"row {i}: voucher_no is required")
        dr, cr = money(r.get("debit")), money(r.get("credit"))
        if dr and cr:
            raise VoucherError(f"row {i}: a line can't have both debit and credit")
        v = grouped.get(no)
        if v is None:
            v = grouped[no] = Voucher(
                voucher_type=r.get("voucher_type") or "Journal",
                date=parse_date(r.get("date", "")),
                number=no,
                narration=r.get("narration", ""),
            )
        elif r.get("narration") and not v.narration:
            v.narration = r["narration"]
        v.lines.append(LedgerLine(r.get("ledger", ""), dr - cr))

    vouchers = list(grouped.values())
    for v in vouchers:
        # Party = first debtor/creditor-looking line for sales/purchase vouchers
        if v.voucher_type in ("Sales", "Credit Note"):
            v.party = next((l.ledger for l in v.lines if l.amount > 0), None)
        elif v.voucher_type in ("Purchase", "Debit Note"):
            v.party = next((l.ledger for l in v.lines if l.amount < 0), None)
        v.validate()
    return vouchers


def read_gst_sales_csv(path: str | Path, home_state: str, round_off_ledger: str = "Round Off") -> list[Voucher]:
    """Builds complete GST sales vouchers from a simple invoice register.

    Intra-state invoices get CGST + SGST output ledgers, inter-state get IGST.
    The invoice total is rounded to the rupee with a round-off line.
    """
    vouchers = []
    for i, r in enumerate(_rows(path), start=2):
        taxable = money(r.get("taxable_value"))
        rate = Decimal(r.get("gst_rate") or "0")
        pos = (r.get("place_of_supply") or home_state).strip()
        sales_ledger = r.get("sales_ledger") or f"Sales @ {_num(rate)}%"
        if taxable <= 0:
            raise VoucherError(f"row {i}: taxable_value must be positive")

        lines = [LedgerLine(sales_ledger, -taxable)]
        if pos.lower() == home_state.lower():
            half = rate / 2
            tax_each = (taxable * half / 100).quantize(PAISA, ROUND_HALF_UP)
            lines += [LedgerLine(f"Output CGST @ {_num(half)}%", -tax_each),
                      LedgerLine(f"Output SGST @ {_num(half)}%", -tax_each)]
        else:
            igst = (taxable * rate / 100).quantize(PAISA, ROUND_HALF_UP)
            lines.append(LedgerLine(f"Output IGST @ {_num(rate)}%", -igst))

        gross = -sum((l.amount for l in lines), Decimal(0))
        total = gross.quantize(Decimal(1), ROUND_HALF_UP)
        if total != gross:
            lines.append(LedgerLine(round_off_ledger, gross - total))
        party = r.get("party") or ""
        lines.insert(0, LedgerLine(party, total))

        v = Voucher("Sales", parse_date(r.get("date", "")), r.get("invoice_no", ""), lines,
                    narration=f"Being goods/services sold to {party} vide invoice {r.get('invoice_no', '')}",
                    party=party, reference=r.get("invoice_no"))
        v.validate()
        vouchers.append(v)
    return vouchers


def required_ledgers(vouchers: list[Voucher]) -> list[Ledger]:
    """Guesses the parent group for every ledger used, so masters can be
    created before importing vouchers (Tally rejects unknown ledgers)."""
    seen: dict[str, Ledger] = {}
    for v in vouchers:
        for l in v.lines:
            if l.ledger in seen:
                continue
            name = l.ledger.lower()
            if "gst" in name or "tds" in name or "cess" in name:
                group = "Duties & Taxes"
            elif name.startswith("sales"):
                group = "Sales Accounts"
            elif name.startswith("purchase"):
                group = "Purchase Accounts"
            elif "round off" in name:
                group = "Indirect Expenses"
            elif "bank" in name:
                group = "Bank Accounts"
            elif name == "cash":
                group = "Cash-in-Hand"
            elif l.ledger == v.party:
                group = "Sundry Debtors" if v.voucher_type in ("Sales", "Receipt", "Credit Note") else "Sundry Creditors"
            else:
                group = "Indirect Expenses" if l.amount > 0 else "Indirect Incomes"
            seen[l.ledger] = Ledger(l.ledger, group)
    return list(seen.values())


def vouchers_to_csv(vouchers: list[Voucher]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["date", "voucher_type", "voucher_no", "ledger", "debit", "credit", "narration"])
    for v in vouchers:
        for idx, l in enumerate(v.lines):
            w.writerow([
                v.date.isoformat(), v.voucher_type, v.number, l.ledger,
                f"{l.amount:.2f}" if l.amount > 0 else "",
                f"{-l.amount:.2f}" if l.amount < 0 else "",
                v.narration if idx == 0 else "",
            ])
    return buf.getvalue()


def _num(d: Decimal) -> str:
    """Decimal without trailing zeros or exponent notation: 30.00 -> '30', 2.50 -> '2.5'."""
    return format(d.normalize(), "f")
