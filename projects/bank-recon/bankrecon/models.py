from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

DATE_FORMATS = ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%d %b %Y", "%d/%m/%y")

# UTR / cheque / reference numbers commonly found in Indian bank narrations
REF_PATTERNS = [
    re.compile(r"\b(?:UTR|REF|RRN)[:\s/-]*([A-Z0-9]{8,22})\b", re.I),
    re.compile(r"\b(?:NEFT|RTGS|IMPS|UPI)[/-]([A-Z0-9]{8,22})\b", re.I),
    re.compile(r"\b(?:CHQ|CHEQUE|CHQ\.?\s*NO\.?)[:\s#-]*(\d{6})\b", re.I),
]


class InputError(Exception):
    pass


def parse_date(s: str) -> date:
    s = s.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise InputError(f"Unrecognised date {s!r}")


def parse_amount(s: str | None) -> Decimal:
    if s is None:
        return Decimal(0)
    s = s.replace(",", "").replace("₹", "").strip()
    if s in ("", "-"):
        return Decimal(0)
    neg = s.endswith("Dr") or s.startswith("(")
    s = s.removesuffix("Dr").removesuffix("Cr").strip("() ")
    try:
        v = Decimal(s)
    except InvalidOperation:
        raise InputError(f"Unrecognised amount {s!r}") from None
    return -v if neg else v


def extract_reference(text: str) -> str | None:
    for pat in REF_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1).upper()
    return None


@dataclass
class Entry:
    """One line from either side. `amount` is signed from the bank's point of
    view: + money into the account, − money out."""

    id: str
    date: date
    description: str
    amount: Decimal
    reference: str | None = None
    source: str = ""
    matched: bool = field(default=False, compare=False)

    def __post_init__(self) -> None:
        if self.reference is None:
            self.reference = extract_reference(self.description)


def _pick(row: dict[str, str], *names: str) -> str | None:
    lower = {k.strip().lower(): v for k, v in row.items() if k}
    for n in names:
        if n in lower and lower[n] is not None:
            return lower[n]
    return None


def load_entries(path: str | Path, source: str) -> list[Entry]:
    """Loads a CSV with either an `amount` column (signed) or separate
    `debit` / `credit` (or `withdrawal` / `deposit`) columns.

    For a bank statement, credit = deposit (+). For books (bank ledger
    account), debit = receipt (+). Pass source="bank" or "books".
    """
    entries: list[Entry] = []
    with Path(path).open(newline="", encoding="utf-8-sig") as f:
        for i, row in enumerate(csv.DictReader(f), start=1):
            d = _pick(row, "date", "txn date", "transaction date", "value date")
            desc = _pick(row, "description", "narration", "particulars", "remarks") or ""
            if d is None:
                raise InputError(f"{path}: row {i} has no date column")
            amount_raw = _pick(row, "amount")
            if amount_raw not in (None, ""):
                amount = parse_amount(amount_raw)
            else:
                dr = parse_amount(_pick(row, "debit", "withdrawal", "withdrawal amt", "dr"))
                cr = parse_amount(_pick(row, "credit", "deposit", "deposit amt", "cr"))
                amount = (cr - dr) if source == "bank" else (dr - cr)
            ref = _pick(row, "reference", "ref", "ref no", "chq no", "cheque no", "utr")
            entries.append(
                Entry(
                    id=_pick(row, "id", "voucher", "voucher no") or f"{source}-{i}",
                    date=parse_date(d),
                    description=desc.strip(),
                    amount=amount,
                    reference=(ref.strip().upper() or None) if ref else None,
                    source=source,
                )
            )
    return entries
