from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any


@dataclass
class BidCriteria:
    """Eligibility conditions as published in a bid document. Amounts in rupees."""

    bid_number: str
    item: str
    quantity: int
    estimated_value: Decimal = Decimal(0)
    min_avg_turnover: Decimal = Decimal(0)  # average of the last N financial years
    turnover_years: int = 3
    min_experience_years: int = 0
    past_performance_pct: Decimal = Decimal(0)  # % of bid quantity supplied in one past order
    oem_authorization_required: bool = False
    required_certifications: list[str] = field(default_factory=list)
    emd_amount: Decimal = Decimal(0)
    # Buyer may exempt MSEs / startups from experience and turnover criteria
    mse_exemption: bool = True
    startup_exemption: bool = True

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "BidCriteria":
        return cls(**_coerce(cls, d))


@dataclass
class PastOrder:
    buyer: str
    item: str
    quantity: int
    value: Decimal


@dataclass
class CompanyProfile:
    name: str
    turnover_by_fy: dict[str, Decimal]  # {"2023-24": Decimal(...)}
    years_in_business: int
    is_mse: bool = False
    is_startup: bool = False
    local_content_pct: Decimal = Decimal(0)
    oem_authorizations: list[str] = field(default_factory=list)
    certifications: list[str] = field(default_factory=list)
    past_orders: list[PastOrder] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CompanyProfile":
        d = dict(d)
        d["turnover_by_fy"] = {k: Decimal(str(v)) for k, v in d.get("turnover_by_fy", {}).items()}
        d["past_orders"] = [PastOrder(o["buyer"], o["item"], int(o["quantity"]), Decimal(str(o["value"])))
                            for o in d.get("past_orders", [])]
        return cls(**_coerce(cls, d))

    @property
    def mii_class(self) -> str:
        """Make in India classification under the PPP-MII order."""
        if self.local_content_pct >= 50:
            return "Class-I"
        if self.local_content_pct >= 20:
            return "Class-II"
        return "Non-local"


def _coerce(cls, d: dict[str, Any]) -> dict[str, Any]:
    """Converts JSON numbers to Decimal for Decimal-typed fields."""
    out = {}
    for k, v in d.items():
        f = cls.__dataclass_fields__.get(k)
        if f is None:
            raise ValueError(f"Unknown field {k!r} for {cls.__name__}")
        if f.type in ("Decimal",) and v is not None:
            v = Decimal(str(v))
        out[k] = v
    return out


def load_json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))
