from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

VOUCHER_TYPES = {"Sales", "Purchase", "Payment", "Receipt", "Journal", "Contra", "Credit Note", "Debit Note"}

# Primary groups in Tally's chart of accounts (used for ledger masters).
TALLY_GROUPS = {
    "Sundry Debtors", "Sundry Creditors", "Sales Accounts", "Purchase Accounts", "Duties & Taxes",
    "Bank Accounts", "Cash-in-Hand", "Direct Expenses", "Indirect Expenses", "Direct Incomes",
    "Indirect Incomes", "Capital Account", "Current Assets", "Current Liabilities", "Fixed Assets",
    "Loans (Liability)", "Loans & Advances (Asset)", "Bank OD A/c", "Provisions", "Suspense A/c",
}


class VoucherError(ValueError):
    pass


@dataclass
class LedgerLine:
    ledger: str
    amount: Decimal  # positive = debit, negative = credit

    @property
    def is_debit(self) -> bool:
        return self.amount > 0


@dataclass
class Voucher:
    voucher_type: str
    date: date
    number: str
    lines: list[LedgerLine] = field(default_factory=list)
    narration: str = ""
    party: str | None = None
    reference: str | None = None

    def validate(self) -> None:
        if self.voucher_type not in VOUCHER_TYPES:
            raise VoucherError(f"{self.number}: unknown voucher type {self.voucher_type!r}")
        if len(self.lines) < 2:
            raise VoucherError(f"{self.number}: a voucher needs at least two ledger lines")
        if any(line.amount == 0 for line in self.lines):
            raise VoucherError(f"{self.number}: ledger lines cannot be zero")
        diff = sum((l.amount for l in self.lines), Decimal(0))
        if diff != 0:
            raise VoucherError(f"{self.number}: debits and credits differ by {diff}")

    @property
    def total(self) -> Decimal:
        return sum((l.amount for l in self.lines if l.amount > 0), Decimal(0))


@dataclass
class Ledger:
    name: str
    group: str
    gstin: str | None = None
    state: str | None = None
    opening_balance: Decimal = Decimal(0)

    def validate(self) -> None:
        if self.group not in TALLY_GROUPS:
            raise VoucherError(f"Ledger {self.name!r}: unknown parent group {self.group!r}")
