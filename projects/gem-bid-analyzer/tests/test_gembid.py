from decimal import Decimal
from pathlib import Path

import pytest

from gembid import (
    BidCriteria, CompanyProfile, Offer, PastOrder, Policy, advise_price, check_eligibility, evaluate, rank,
    render_report,
)
from gembid.cli import main
from gembid.models import load_json

EX = Path(__file__).resolve().parent.parent / "examples"
D = Decimal


def bid(**kw):
    base = dict(bid_number="B1", item="Desktop Computer", quantity=100)
    base.update(kw)
    return BidCriteria.from_dict(base)


def company(**kw):
    base = dict(name="Co", turnover_by_fy={"2023-24": 5_000_000, "2024-25": 6_000_000, "2025-26": 7_000_000},
                years_in_business=5)
    base.update(kw)
    return CompanyProfile.from_dict(base)


def statuses(report):
    return {c.criterion: c.status for c in report.checks}


def test_example_files_are_eligible_with_mse_exemptions():
    r = check_eligibility(BidCriteria.from_dict(load_json(EX / "bid.json")), CompanyProfile.from_dict(load_json(EX / "profile.json")))
    s = statuses(r)
    assert r.eligible
    assert s["Average turnover"] == "EXEMPT" and s["EMD"] == "EXEMPT"
    assert "Udyam certificate" not in r.documents  # exempt items don't add docs
    assert "VERDICT: ELIGIBLE" in render_report(r)


def test_turnover_uses_latest_n_years():
    co = company(turnover_by_fy={"2021-22": 100, "2023-24": 9_000_000, "2024-25": 9_000_000, "2025-26": 9_000_000})
    assert statuses(check_eligibility(bid(min_avg_turnover=8_000_000), co))["Average turnover"] == "PASS"


def test_missing_turnover_years_fail_without_exemption():
    co = company(turnover_by_fy={"2025-26": 50_000_000})
    r = check_eligibility(bid(min_avg_turnover=1_000_000), co)
    assert not r.eligible
    assert "only 1 of 3 years" in r.checks[0].detail


def test_exemption_only_when_buyer_allows_it():
    co = company(years_in_business=1, is_mse=True)
    assert statuses(check_eligibility(bid(min_experience_years=3), co))["Experience"] == "EXEMPT"
    assert statuses(check_eligibility(bid(min_experience_years=3, mse_exemption=False), co))["Experience"] == "FAIL"
    st = company(years_in_business=1, is_startup=True)
    assert statuses(check_eligibility(bid(min_experience_years=3), st))["Experience"] == "EXEMPT"


def test_past_performance_matches_similar_items_only():
    co = company(past_orders=[{"buyer": "A", "item": "Office chair", "quantity": 500, "value": 1}])
    r = check_eligibility(bid(past_performance_pct=20), co)
    assert statuses(r)["Past performance"] == "FAIL"
    co.past_orders.append(PastOrder("B", "desktop computer i3", 20, D(1)))
    assert statuses(check_eligibility(bid(past_performance_pct=20), co))["Past performance"] == "PASS"


def test_oem_and_certifications_cannot_be_exempted():
    co = company(is_mse=True, certifications=["ISO 9001:2015"])
    r = check_eligibility(bid(oem_authorization_required=True, required_certifications=["ISO 9001", "BIS"]), co)
    s = statuses(r)
    assert s["OEM authorisation"] == "FAIL" and s["Certification: BIS"] == "FAIL" and s["Certification: ISO 9001"] == "PASS"
    assert not r.eligible


def test_mii_class():
    assert company(local_content_pct=50).mii_class == "Class-I"
    assert company(local_content_pct=20).mii_class == "Class-II"
    assert company(local_content_pct=19).mii_class == "Non-local"


def test_ranking_shares_levels_on_ties():
    r = rank([Offer("B", D(100)), Offer("A", D(100), is_mse=True), Offer("C", D(90))])
    assert [(lvl, o.vendor) for lvl, o in r] == [("L1", "C"), ("L2", "A"), ("L2", "B")]


def test_mse_purchase_preference():
    offers = [Offer("Big", D(100)), Offer("Small", D(112), is_mse=True), Offer("Far", D(130), is_mse=True)]
    ev = evaluate(offers, 100)
    awards = {a.vendor: (a.quantity, a.unit_price) for a in ev.awards}
    assert awards == {"Big": (75, D(100)), "Small": (25, D(100))}


def test_no_preference_when_mse_outside_margin_or_l1_is_mse():
    assert [a.vendor for a in evaluate([Offer("Big", D(100)), Offer("Small", D(116), is_mse=True)], 10).awards] == ["Big"]
    assert [a.vendor for a in evaluate([Offer("Small", D(99), is_mse=True), Offer("Other", D(100), is_mse=True)], 10).awards] == ["Small"]


def test_make_in_india_preference_then_mse():
    offers = [Offer("Import", D(100)), Offer("Local", D(118), mii_class="Class-I"), Offer("MSE", D(110), is_mse=True)]
    ev = evaluate(offers, 120)
    awards = {a.vendor: a.quantity for a in ev.awards}
    assert awards == {"Import": 30, "Local": 60, "MSE": 30}
    assert ev.total_value == D(12000)


def test_indivisible_bid_goes_entirely_to_class_i():
    offers = [Offer("Import", D(100)), Offer("Local", D(115), mii_class="Class-I")]
    ev = evaluate(offers, 1, Policy(divisible=False))
    assert [(a.vendor, a.quantity, a.unit_price) for a in ev.awards] == [("Local", 1, D(100))]


def test_evaluate_validates_input():
    with pytest.raises(ValueError):
        evaluate([], 10)
    with pytest.raises(ValueError):
        evaluate([Offer("A", D(1))], 0)


def test_price_advice_paths():
    hist = [D(x) for x in (61200, 59800, 60500, 62900, 58750, 63400, 60100)]
    good = advise_price(hist, D(46000))
    assert good.suggested == D("59650.25") and good.margin_at_suggested > 5
    tight = advise_price(hist, D(48500))
    assert tight.suggested is not None and "tight" in tight.message
    bad = advise_price(hist, D(52000))
    assert bad.suggested is None and "Not viable" in bad.message
    with pytest.raises(ValueError):
        advise_price([D(1), D(2)], D(1))


def test_cli(capsys):
    assert main(["check", str(EX / "bid.json"), str(EX / "profile.json")]) == 0
    assert main(["evaluate", str(EX / "offers.csv"), "--quantity", "120"]) == 0
    out = capsys.readouterr().out
    assert "Class-I local supplier matched L1" in out and "6,984,000.00" in out
    assert main(["price", "--history", "100,110,120,130", "--cost", "80"]) == 0
    assert main(["check", "missing.json", "x.json"]) == 1
