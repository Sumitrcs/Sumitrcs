"""Price evaluation: L1 ranking and purchase-preference allocation.

Policy parameters are configurable because they are set by government
orders and individual bid documents. Defaults follow the commonly used
values:

* MSE purchase preference — an MSE quoting within 15% of a non-MSE L1 may
  match L1 and receive up to 25% of the quantity.
* Make in India (PPP-MII) — when L1 is not a Class-I local supplier, the
  lowest Class-I bidder within a 20% margin may match L1 and receive 50%
  of the quantity (divisible bids) or the whole order (indivisible).

Always confirm against the specific bid's ATC and the latest orders.
"""

from __future__ import annotations

import csv
import statistics
from dataclasses import dataclass, field
from decimal import ROUND_DOWN, Decimal
from pathlib import Path


@dataclass
class Offer:
    vendor: str
    unit_price: Decimal
    is_mse: bool = False
    mii_class: str = "Non-local"


@dataclass
class Policy:
    mse_margin_pct: Decimal = Decimal(15)
    mse_share_pct: Decimal = Decimal(25)
    mii_margin_pct: Decimal = Decimal(20)
    mii_share_pct: Decimal = Decimal(50)
    divisible: bool = True


@dataclass
class Award:
    vendor: str
    quantity: int
    unit_price: Decimal
    reason: str

    @property
    def value(self) -> Decimal:
        return self.unit_price * self.quantity


@dataclass
class Evaluation:
    ranking: list[tuple[str, Offer]]  # ("L1", offer), ...
    awards: list[Award] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def total_value(self) -> Decimal:
        return sum((a.value for a in self.awards), Decimal(0))


def rank(offers: list[Offer]) -> list[tuple[str, Offer]]:
    """Dense L-ranking: equal prices share a rank; ties are listed with MSEs first."""
    ordered = sorted(offers, key=lambda o: (o.unit_price, not o.is_mse, o.vendor))
    out, level, last = [], 0, None
    for o in ordered:
        if o.unit_price != last:
            level += 1
            last = o.unit_price
        out.append((f"L{level}", o))
    return out


def evaluate(offers: list[Offer], quantity: int, policy: Policy | None = None) -> Evaluation:
    if not offers:
        raise ValueError("No offers to evaluate")
    if quantity < 1:
        raise ValueError("Quantity must be positive")
    p = policy or Policy()
    ranking = rank(offers)
    ev = Evaluation(ranking)
    l1 = ranking[0][1]
    remaining = quantity

    # 1. Make in India preference (applies first; MII takes precedence over MSE in practice)
    if l1.mii_class != "Class-I":
        limit = l1.unit_price * (1 + p.mii_margin_pct / 100)
        cands = [o for _, o in ranking if o.mii_class == "Class-I" and o.unit_price <= limit]
        if cands:
            c = cands[0]
            share = quantity if not p.divisible else _portion(quantity, p.mii_share_pct)
            ev.awards.append(Award(c.vendor, share, l1.unit_price,
                                   f"Class-I local supplier matched L1 (within {_num(p.mii_margin_pct)}%)"))
            remaining -= share
            ev.notes.append(f"{c.vendor} quoted {c.unit_price} vs L1 {l1.unit_price}; matched to L1 under PPP-MII.")
            if remaining == 0:
                return ev

    # 2. MSE purchase preference on what is left
    if not l1.is_mse and p.divisible:
        limit = l1.unit_price * (1 + p.mse_margin_pct / 100)
        already = {a.vendor for a in ev.awards}
        cands = [o for _, o in ranking if o.is_mse and o.unit_price <= limit and o.vendor not in already]
        if cands:
            c = cands[0]
            share = min(remaining, _portion(quantity, p.mse_share_pct))
            if share > 0:
                ev.awards.append(Award(c.vendor, share, l1.unit_price,
                                       f"MSE matched L1 (within {_num(p.mse_margin_pct)}%)"))
                remaining -= share
                ev.notes.append(f"{c.vendor} (MSE) quoted {c.unit_price}; offered to match L1 {l1.unit_price}.")

    if remaining > 0:
        ev.awards.insert(0, Award(l1.vendor, remaining, l1.unit_price, "L1"))
    return ev


def _portion(quantity: int, pct: Decimal) -> int:
    return int((Decimal(quantity) * pct / 100).to_integral_value(ROUND_DOWN))


# ---------------------------------------------------------------------------
# Price intelligence from historical awards


@dataclass
class PriceAdvice:
    samples: int
    median: Decimal
    p25: Decimal
    min_price: Decimal
    break_even: Decimal
    suggested: Decimal | None
    margin_at_suggested: Decimal | None
    message: str


def advise_price(history: list[Decimal], unit_cost: Decimal, gst_pct: Decimal = Decimal(18),
                 min_margin_pct: Decimal = Decimal(5)) -> PriceAdvice:
    """Suggests a GST-inclusive quote that undercuts most past winners while
    keeping a minimum margin. `history` holds past L1 unit prices (incl. GST)."""
    if len(history) < 3:
        raise ValueError("Need at least 3 historical prices for a meaningful suggestion")
    h = sorted(history)
    q = statistics.quantiles([float(x) for x in h], n=4, method="inclusive")
    p25 = Decimal(str(q[0])).quantize(Decimal("0.01"))
    median = Decimal(str(statistics.median([float(x) for x in h]))).quantize(Decimal("0.01"))
    floor = (unit_cost * (1 + min_margin_pct / 100) * (1 + gst_pct / 100)).quantize(Decimal("0.01"))
    break_even = (unit_cost * (1 + gst_pct / 100)).quantize(Decimal("0.01"))

    target = (p25 * Decimal("0.995")).quantize(Decimal("0.01"))  # just under the 25th percentile
    if target >= floor:
        margin = ((target / (1 + gst_pct / 100)) / unit_cost - 1) * 100
        return PriceAdvice(len(h), median, p25, h[0], break_even, target, margin.quantize(Decimal("0.1")),
                           "Quote just below the 25th percentile of past winning prices.")
    if median >= floor:
        margin = ((floor / (1 + gst_pct / 100)) / unit_cost - 1) * 100
        return PriceAdvice(len(h), median, p25, h[0], break_even, floor, margin.quantize(Decimal("0.1")),
                           "Market is tight: quote at your minimum-margin floor; you beat the median but may not be L1.")
    return PriceAdvice(len(h), median, p25, h[0], break_even, None, None,
                       "Not viable: most past winners priced below your minimum-margin floor. Reduce cost or skip this bid.")


def load_offers(path: str | Path) -> list[Offer]:
    with Path(path).open(newline="", encoding="utf-8-sig") as f:
        return [
            Offer(
                vendor=r["vendor"].strip(),
                unit_price=Decimal(r["unit_price"].replace(",", "")),
                is_mse=r.get("mse", "").strip().lower() in ("yes", "y", "true", "1"),
                mii_class=(r.get("mii_class") or "Non-local").strip(),
            )
            for r in csv.DictReader(f)
        ]


def _num(d: Decimal) -> str:
    """Decimal without trailing zeros or exponent notation: 30.00 -> '30', 2.50 -> '2.5'."""
    return format(d.normalize(), "f")
