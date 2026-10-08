"""Command line interface.

    csvql "SELECT region, SUM(amount) FROM sales GROUP BY region" examples/*.csv
    csvql -f json "SELECT * FROM customers LIMIT 3" customers=data/clients.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from typing import Any

from . import Database, QueryError, SQLSyntaxError


def _fmt(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, float):
        return f"{v:.2f}".rstrip("0").rstrip(".") if not v.is_integer() else str(int(v))
    return str(v)


def render_table(columns: list[str], rows: list[tuple]) -> str:
    cells = [[_fmt(v) for v in r] for r in rows]
    widths = [max([len(c)] + [len(r[i]) for r in cells]) for i, c in enumerate(columns)]
    numeric = [all(isinstance(r[i], (int, float)) or r[i] is None for r in rows) for i in range(len(columns))]

    def line(values):
        return "│ " + " │ ".join(
            v.rjust(w) if num else v.ljust(w) for v, w, num in zip(values, widths, numeric)
        ) + " │"

    top = "┌─" + "─┬─".join("─" * w for w in widths) + "─┐"
    mid = "├─" + "─┼─".join("─" * w for w in widths) + "─┤"
    bot = "└─" + "─┴─".join("─" * w for w in widths) + "─┘"
    body = [line(r) for r in cells]
    return "\n".join([top, line(columns), mid, *body, bot, f"({len(rows)} row{'s' if len(rows) != 1 else ''})"])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="csvql", description="Run SQL against CSV files.")
    ap.add_argument("sql", help="SQL query; table names are file names without .csv")
    ap.add_argument("files", nargs="+", help="CSV files, optionally as name=path")
    ap.add_argument("-f", "--format", choices=["table", "csv", "json"], default="table")
    args = ap.parse_args(argv)

    db = Database()
    try:
        for spec in args.files:
            name, _, path = spec.partition("=") if "=" in spec else (None, "", spec)
            db.load_csv(path, name)
        result = db.query(args.sql)
    except (QueryError, SQLSyntaxError, OSError) as e:
        print(f"csvql: {e}", file=sys.stderr)
        return 1

    if args.format == "json":
        print(json.dumps(result.as_dicts(), indent=2, default=str))
    elif args.format == "csv":
        w = csv.writer(sys.stdout)
        w.writerow(result.columns)
        w.writerows(result.rows)
    else:
        print(render_table(result.columns, result.rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
