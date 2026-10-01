"""Bank Reconciliation Statement (BRS).

Starting from the balance as per the cash book, adjust for items that only
one side has recorded, and arrive at the balance as per the pass book.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal

from .matcher import Match, MatchConfig, Reconciler
from .models import Entry

# Hints for bank-only lines so the accountant knows what voucher to pass.
SUGGESTIONS = [
    (re.compile(r"\b(chrg|charges?|fee|gst on|sms alert|amc|min bal)\b", re.I), "Bank charges — pass a journal to Bank Charges A/c"),
    (re.compile(r"\b(int\.?\s*(pd|cr|credit)|interest)\b", re.I), "Interest credited — pass a receipt to Interest Income A/c"),
    (re.compile(r"\b(rtn|return|reversal|bounce|dishono)", re.I), "Return / reversal — check the original entry"),
    (re.compile(r"\btds\b", re.I), "TDS deducted — record against TDS Receivable"),
    (re.compile(r"\b(emi|loan)\b", re.I), "Loan EMI — split into principal and interest"),
]


def suggest(entry: Entry) -> str:
    for pattern, hint in SUGGESTIONS:
        if pattern.search(entry.description):
            return hint
    return "Not in books — investigate and record"


@dataclass
class BRS:
    balance_as_per_books: Decimal
    balance_as_per_bank: Decimal
    matches: list[Match]
    # Book-only items
    cheques_issued_not_presented: list[Entry] = field(default_factory=list)
    deposits_not_credited: list[Entry] = field(default_factory=list)
    # Bank-only items
    credits_not_in_books: list[Entry] = field(default_factory=list)
    debits_not_in_books: list[Entry] = field(default_factory=list)

    @property
    def computed_bank_balance(self) -> Decimal:
        return (
            self.balance_as_per_books
            + sum((-e.amount for e in self.cheques_issued_not_presented), Decimal(0))
            - sum((e.amount for e in self.deposits_not_credited), Decimal(0))
            + sum((e.amount for e in self.credits_not_in_books), Decimal(0))
            - sum((-e.amount for e in self.debits_not_in_books), Decimal(0))
        )

    @property
    def difference(self) -> Decimal:
        return self.balance_as_per_bank - self.computed_bank_balance

    @property
    def reconciled(self) -> bool:
        return self.difference == 0


def reconcile(
    bank: list[Entry],
    books: list[Entry],
    opening_books: Decimal = Decimal(0),
    opening_bank: Decimal = Decimal(0),
    config: MatchConfig | None = None,
) -> BRS:
    matches = Reconciler(bank, books, config).run()
    brs = BRS(
        balance_as_per_books=opening_books + sum((e.amount for e in books), Decimal(0)),
        balance_as_per_bank=opening_bank + sum((e.amount for e in bank), Decimal(0)),
        matches=matches,
    )
    for e in books:
        if not e.matched:
            (brs.cheques_issued_not_presented if e.amount < 0 else brs.deposits_not_credited).append(e)
    for e in bank:
        if not e.matched:
            (brs.debits_not_in_books if e.amount < 0 else brs.credits_not_in_books).append(e)
    return brs


def _inr(v: Decimal) -> str:
    sign = "-" if v < 0 else ""
    v = abs(v).quantize(Decimal("0.01"))
    whole, frac = f"{v:.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups) + "," + tail
    return f"{sign}{whole}.{frac}"


def render(brs: BRS) -> str:
    w = 72
    out = ["BANK RECONCILIATION STATEMENT".center(w), "=" * w]
    out.append(f"{'Balance as per books':<56}{_inr(brs.balance_as_per_books):>16}")

    def section(title: str, sign: str, items: list[Entry], value) -> None:
        if not items:
            return
        total = sum((value(e) for e in items), Decimal(0))
        out.append(f"{sign + ' ' + title:<56}{_inr(total):>16}")
        for e in items:
            out.append(f"    {e.date:%d-%m-%Y}  {e.description[:38]:<38}  {_inr(value(e)):>16}")

    section("Cheques issued but not yet presented", "Add:", brs.cheques_issued_not_presented, lambda e: -e.amount)
    section("Deposits not yet credited by bank", "Less:", brs.deposits_not_credited, lambda e: e.amount)
    section("Credits in bank not in books", "Add:", brs.credits_not_in_books, lambda e: e.amount)
    section("Debits in bank not in books", "Less:", brs.debits_not_in_books, lambda e: -e.amount)
    out.append("-" * w)
    out.append(f"{'Balance as per bank (computed)':<56}{_inr(brs.computed_bank_balance):>16}")
    out.append(f"{'Balance as per bank statement':<56}{_inr(brs.balance_as_per_bank):>16}")
    status = "RECONCILED ✓" if brs.reconciled else f"DIFFERENCE {_inr(brs.difference)} ✗"
    out.append(f"{'Status':<56}{status:>16}")

    kinds: dict[str, int] = {}
    for m in brs.matches:
        kinds[m.kind] = kinds.get(m.kind, 0) + 1
    out.append("")
    out.append("Matched: " + ", ".join(f"{k} {v}" for k, v in kinds.items()) if kinds else "Matched: none")

    bank_only = brs.credits_not_in_books + brs.debits_not_in_books
    if bank_only:
        out.append("")
        out.append("Action items")
        for e in bank_only:
            out.append(f"  • {e.date:%d-%m-%Y} {_inr(e.amount):>12}  {e.description[:28]:<28} → {suggest(e)}")
    return "\n".join(out)
