"""tallybridge — move accounting data between spreadsheets and Tally Prime.

  tallybridge journal  entries.csv  -o vouchers.xml  [--company "My Co"]
  tallybridge gst-sales invoices.csv --state Delhi -o sales.xml [--masters masters.xml]
  tallybridge to-csv   daybook.xml -o daybook.csv
  tallybridge push     vouchers.xml [--url http://localhost:9000]
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

from .csv_io import read_gst_sales_csv, read_journal_csv, required_ledgers, vouchers_to_csv
from .model import VoucherError
from .xml_io import ledgers_to_xml, parse_vouchers, vouchers_to_xml


def _write(path: str | None, text: str) -> None:
    if path:
        Path(path).write_text(text, encoding="utf-8")
        print(f"wrote {path}", file=sys.stderr)
    else:
        sys.stdout.write(text + ("" if text.endswith("\n") else "\n"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tallybridge", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    j = sub.add_parser("journal", help="journal-style CSV -> Tally voucher XML")
    j.add_argument("csv")
    j.add_argument("-o", "--output")
    j.add_argument("--company")
    j.add_argument("--masters", help="also write ledger masters XML to this file")

    g = sub.add_parser("gst-sales", help="invoice register CSV -> GST sales voucher XML")
    g.add_argument("csv")
    g.add_argument("--state", required=True, help="your registered state, e.g. Delhi")
    g.add_argument("-o", "--output")
    g.add_argument("--company")
    g.add_argument("--masters", help="also write ledger masters XML to this file")

    t = sub.add_parser("to-csv", help="Tally XML export -> CSV")
    t.add_argument("xml")
    t.add_argument("-o", "--output")

    p = sub.add_parser("push", help="POST an XML file to a running Tally (Gateway on port 9000)")
    p.add_argument("xml")
    p.add_argument("--url", default="http://localhost:9000")

    args = ap.parse_args(argv)
    try:
        if args.cmd in ("journal", "gst-sales"):
            vouchers = read_journal_csv(args.csv) if args.cmd == "journal" else read_gst_sales_csv(args.csv, args.state)
            _write(args.output, vouchers_to_xml(vouchers, args.company))
            if args.masters:
                _write(args.masters, ledgers_to_xml(required_ledgers(vouchers), args.company))
            total = sum(v.total for v in vouchers)
            print(f"{len(vouchers)} vouchers, total {total:,.2f}", file=sys.stderr)
        elif args.cmd == "to-csv":
            vouchers = parse_vouchers(Path(args.xml).read_text(encoding="utf-8"))
            _write(args.output, vouchers_to_csv(vouchers))
        elif args.cmd == "push":
            body = Path(args.xml).read_bytes()
            req = urllib.request.Request(args.url, data=body, headers={"Content-Type": "text/xml"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(resp.read().decode("utf-8", "replace"))
    except (VoucherError, OSError) as e:
        print(f"tallybridge: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
