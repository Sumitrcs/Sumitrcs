"""bankrecon --bank statement.csv --books ledger.csv [--opening-books X --opening-bank Y]"""

from __future__ import annotations

import argparse
import csv
import sys
from decimal import Decimal

from .brs import reconcile, render, suggest
from .matcher import MatchConfig
from .models import InputError, load_entries


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="bankrecon", description="Auto-match a bank statement against the cash book and print a BRS.")
    ap.add_argument("--bank", required=True, help="bank statement CSV")
    ap.add_argument("--books", required=True, help="bank ledger / cash book CSV")
    ap.add_argument("--opening-books", type=Decimal, default=Decimal(0))
    ap.add_argument("--opening-bank", type=Decimal, default=Decimal(0))
    ap.add_argument("--window", type=int, default=3, help="days tolerance for amount+date matching")
    ap.add_argument("--export", help="write match details to this CSV")
    args = ap.parse_args(argv)

    try:
        bank = load_entries(args.bank, "bank")
        books = load_entries(args.books, "books")
    except (InputError, OSError) as e:
        print(f"bankrecon: {e}", file=sys.stderr)
        return 1

    brs = reconcile(bank, books, args.opening_books, args.opening_bank, MatchConfig(window_days=args.window))
    print(render(brs))

    if args.export:
        with open(args.export, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["status", "match_type", "confidence", "bank_ids", "book_ids", "date", "amount", "description", "suggestion"])
            for m in brs.matches:
                w.writerow(["matched", m.kind, m.confidence, " ".join(e.id for e in m.bank),
                            " ".join(e.id for e in m.books), m.bank[0].date, m.amount, m.bank[0].description, ""])
            for e in brs.credits_not_in_books + brs.debits_not_in_books:
                w.writerow(["bank_only", "", "", e.id, "", e.date, e.amount, e.description, suggest(e)])
            for e in brs.cheques_issued_not_presented + brs.deposits_not_credited:
                w.writerow(["books_only", "", "", "", e.id, e.date, e.amount, e.description, ""])
        print(f"\nDetails written to {args.export}")
    return 0 if brs.reconciled else 2


if __name__ == "__main__":
    raise SystemExit(main())
