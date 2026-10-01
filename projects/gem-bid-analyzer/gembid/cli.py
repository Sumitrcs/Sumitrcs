"""gembid — eligibility check, L1 evaluation and price advice for GeM bids.

  gembid check    bid.json profile.json
  gembid evaluate offers.csv --quantity 100 [--indivisible]
  gembid price    --history 412,398,405,420,389 --cost 300 [--gst 18] [--margin 5]
"""

from __future__ import annotations

import argparse
import sys
from decimal import Decimal, InvalidOperation

from .eligibility import check_eligibility, render_report
from .evaluation import Policy, advise_price, evaluate, load_offers
from .models import BidCriteria, CompanyProfile, load_json


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="gembid", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="eligibility report for a bid")
    c.add_argument("bid")
    c.add_argument("profile")

    e = sub.add_parser("evaluate", help="rank offers and apply purchase preference")
    e.add_argument("offers")
    e.add_argument("--quantity", type=int, required=True)
    e.add_argument("--indivisible", action="store_true")
    e.add_argument("--mse-margin", type=Decimal, default=Decimal(15))
    e.add_argument("--mse-share", type=Decimal, default=Decimal(25))

    p = sub.add_parser("price", help="suggest a quote from past winning prices")
    p.add_argument("--history", required=True, help="comma-separated past L1 unit prices incl. GST")
    p.add_argument("--cost", type=Decimal, required=True, help="your unit cost excl. GST")
    p.add_argument("--gst", type=Decimal, default=Decimal(18))
    p.add_argument("--margin", type=Decimal, default=Decimal(5), help="minimum margin %%")

    args = ap.parse_args(argv)
    try:
        if args.cmd == "check":
            report = check_eligibility(BidCriteria.from_dict(load_json(args.bid)),
                                       CompanyProfile.from_dict(load_json(args.profile)))
            print(render_report(report))
            return 0 if report.eligible else 2

        if args.cmd == "evaluate":
            policy = Policy(mse_margin_pct=args.mse_margin, mse_share_pct=args.mse_share, divisible=not args.indivisible)
            ev = evaluate(load_offers(args.offers), args.quantity, policy)
            print("Ranking")
            for lvl, o in ev.ranking:
                tags = ", ".join(t for t in ("MSE" if o.is_mse else "", o.mii_class if o.mii_class != "Non-local" else "") if t)
                print(f"  {lvl:<4}{o.vendor:<28}{o.unit_price:>12,.2f}  {tags}")
            print("\nAward")
            for a in ev.awards:
                print(f"  {a.vendor:<28}{a.quantity:>6} × {a.unit_price:,.2f} = {a.value:>14,.2f}   ({a.reason})")
            print(f"  {'Total':<28}{'':>27}{ev.total_value:>14,.2f}")
            for n in ev.notes:
                print(f"\nnote: {n}")
            return 0

        history = [Decimal(x.strip()) for x in args.history.split(",") if x.strip()]
        adv = advise_price(history, args.cost, args.gst, args.margin)
        print(f"Past winning prices: {adv.samples} samples, lowest {adv.min_price}, 25th pct {adv.p25}, median {adv.median}")
        print(f"Your break-even (cost + GST): {adv.break_even}")
        if adv.suggested is not None:
            print(f"Suggested quote: {adv.suggested} (margin {adv.margin_at_suggested}%)")
        print(adv.message)
        return 0
    except (ValueError, KeyError, InvalidOperation, OSError) as err:
        print(f"gembid: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
