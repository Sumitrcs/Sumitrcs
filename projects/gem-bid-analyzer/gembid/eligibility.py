"""Checks a company profile against a bid's eligibility criteria and
produces a go / no-go report with the documents to upload."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .models import BidCriteria, CompanyProfile

PASS, FAIL, EXEMPT, INFO = "PASS", "FAIL", "EXEMPT", "INFO"


@dataclass
class Check:
    criterion: str
    status: str
    detail: str
    documents: tuple[str, ...] = ()


@dataclass
class EligibilityReport:
    bid: BidCriteria
    company: CompanyProfile
    checks: list[Check]

    @property
    def eligible(self) -> bool:
        return all(c.status != FAIL for c in self.checks)

    @property
    def documents(self) -> list[str]:
        seen: list[str] = []
        for c in self.checks:
            if c.status in (PASS, INFO):
                for d in c.documents:
                    if d not in seen:
                        seen.append(d)
        return seen


def _exempt(bid: BidCriteria, co: CompanyProfile) -> str | None:
    if co.is_mse and bid.mse_exemption:
        return "MSE"
    if co.is_startup and bid.startup_exemption:
        return "Startup"
    return None


def _inr(v: Decimal) -> str:
    v = v.quantize(Decimal(1))
    if v >= 10_000_000:
        return f"₹{v / 10_000_000:.2f} Cr"
    if v >= 100_000:
        return f"₹{v / 100_000:.2f} L"
    return f"₹{v:,}"


def check_eligibility(bid: BidCriteria, co: CompanyProfile) -> EligibilityReport:
    checks: list[Check] = []
    exemption = _exempt(bid, co)

    # Turnover: average of the most recent N financial years
    if bid.min_avg_turnover > 0:
        years = sorted(co.turnover_by_fy)[-bid.turnover_years:]
        avg = sum((co.turnover_by_fy[y] for y in years), Decimal(0)) / max(len(years), 1)
        detail = f"avg of {', '.join(years) or 'no years'} = {_inr(avg)} vs required {_inr(bid.min_avg_turnover)}"
        if len(years) < bid.turnover_years:
            detail += f" (only {len(years)} of {bid.turnover_years} years available)"
        ok = avg >= bid.min_avg_turnover and len(years) == bid.turnover_years
        status = PASS if ok else (EXEMPT if exemption else FAIL)
        if status == EXEMPT:
            detail += f" — exempt as {exemption}"
        checks.append(Check("Average turnover", status, detail, ("CA-certified turnover statement", "Audited balance sheets")))

    if bid.min_experience_years > 0:
        ok = co.years_in_business >= bid.min_experience_years
        status = PASS if ok else (EXEMPT if exemption else FAIL)
        detail = f"{co.years_in_business} years vs required {bid.min_experience_years}"
        if status == EXEMPT:
            detail += f" — exempt as {exemption}"
        checks.append(Check("Experience", status, detail, ("Incorporation / registration certificate",)))

    if bid.past_performance_pct > 0:
        needed = Decimal(bid.quantity) * bid.past_performance_pct / 100
        similar = [o for o in co.past_orders if _similar(o.item, bid.item)]
        best = max(similar, key=lambda o: o.quantity, default=None)
        ok = best is not None and best.quantity >= needed
        status = PASS if ok else (EXEMPT if exemption else FAIL)
        detail = (f"largest similar order {best.quantity} units ({best.buyer})" if best else "no similar past orders")
        detail += f" vs required {_num(needed)} units ({_num(bid.past_performance_pct)}% of {bid.quantity})"
        if status == EXEMPT:
            detail += f" — exempt as {exemption}"
        checks.append(Check("Past performance", status, detail, ("Copies of past purchase orders", "Completion / installation certificates")))

    if bid.oem_authorization_required:
        ok = any(_similar(a, bid.item) for a in co.oem_authorizations)
        checks.append(Check("OEM authorisation", PASS if ok else FAIL,
                            "authorisation on file" if ok else f"no OEM authorisation covering '{bid.item}'",
                            ("OEM authorisation certificate",)))

    for cert in bid.required_certifications:
        ok = any(cert.lower() in c.lower() for c in co.certifications)
        checks.append(Check(f"Certification: {cert}", PASS if ok else FAIL,
                            "available" if ok else "missing", (f"{cert} certificate",)))

    if bid.emd_amount > 0:
        if exemption:
            checks.append(Check("EMD", EXEMPT, f"{_inr(bid.emd_amount)} — exempt as {exemption}",
                                ("Udyam certificate" if exemption == "MSE" else "DPIIT recognition certificate",)))
        else:
            checks.append(Check("EMD", INFO, f"submit EMD of {_inr(bid.emd_amount)}", ("EMD (bank guarantee / e-payment proof)",)))

    checks.append(Check("Make in India", INFO, f"{co.mii_class} supplier ({_num(co.local_content_pct)}% local content)",
                        ("Local content self-declaration",) if co.mii_class != "Non-local" else ()))
    return EligibilityReport(bid, co, checks)


def _similar(a: str, b: str) -> bool:
    """Loose item match: every significant word of the shorter phrase appears in the longer."""
    wa = {w for w in a.lower().replace("-", " ").split() if len(w) > 2}
    wb = {w for w in b.lower().replace("-", " ").split() if len(w) > 2}
    if not wa or not wb:
        return False
    small, big = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return len(small & big) / len(small) >= 0.6


def render_report(r: EligibilityReport) -> str:
    icons = {PASS: "✔", FAIL: "✘", EXEMPT: "◎", INFO: "•"}
    lines = [f"Bid {r.bid.bid_number}: {r.bid.item} × {r.bid.quantity}",
             f"Bidder: {r.company.name}", ""]
    for c in r.checks:
        lines.append(f"  {icons[c.status]} {c.criterion:<22} {c.status:<7} {c.detail}")
    lines.append("")
    lines.append("VERDICT: " + ("ELIGIBLE — go ahead" if r.eligible else "NOT ELIGIBLE — fix the failed items first"))
    if r.eligible:
        lines.append("")
        lines.append("Documents to upload:")
        lines.extend(f"  [ ] {d}" for d in r.documents)
    return "\n".join(lines)


def _num(d: Decimal) -> str:
    """Decimal without trailing zeros or exponent notation: 30.00 -> '30', 2.50 -> '2.5'."""
    return format(d.normalize(), "f")
