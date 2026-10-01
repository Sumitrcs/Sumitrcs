"""Read and write Tally Prime XML (the format used by Import Data and the
HTTP gateway on port 9000).

Tally's sign convention trips most people up: a **debit** line carries
ISDEEMEDPOSITIVE=Yes and a **negative** AMOUNT; a credit line carries
ISDEEMEDPOSITIVE=No and a positive AMOUNT.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime
from decimal import Decimal

from .model import Ledger, LedgerLine, Voucher, VoucherError


def _sub(parent: ET.Element, tag: str, text: str | None = None, **attrib: str) -> ET.Element:
    el = ET.SubElement(parent, tag, attrib)
    if text is not None:
        el.text = text
    return el


def _envelope(company: str | None, report: str) -> tuple[ET.Element, ET.Element]:
    env = ET.Element("ENVELOPE")
    header = _sub(env, "HEADER")
    _sub(header, "TALLYREQUEST", "Import Data")
    body = _sub(env, "BODY")
    imp = _sub(body, "IMPORTDATA")
    desc = _sub(imp, "REQUESTDESC")
    _sub(desc, "REPORTNAME", report)
    if company:
        sv = _sub(desc, "STATICVARIABLES")
        _sub(sv, "SVCURRENTCOMPANY", company)
    data = _sub(imp, "REQUESTDATA")
    return env, data


def _fmt_amount(v: Decimal) -> str:
    return f"{v:.2f}"


def vouchers_to_xml(vouchers: list[Voucher], company: str | None = None) -> str:
    env, data = _envelope(company, "Vouchers")
    for v in vouchers:
        v.validate()
        msg = _sub(data, "TALLYMESSAGE", **{"xmlns:UDF": "TallyUDF"})
        el = _sub(msg, "VOUCHER", VCHTYPE=v.voucher_type, ACTION="Create", OBJVIEW="Accounting Voucher View")
        _sub(el, "DATE", v.date.strftime("%Y%m%d"))
        _sub(el, "VOUCHERTYPENAME", v.voucher_type)
        _sub(el, "VOUCHERNUMBER", v.number)
        if v.reference:
            _sub(el, "REFERENCE", v.reference)
        if v.party:
            _sub(el, "PARTYLEDGERNAME", v.party)
        if v.narration:
            _sub(el, "NARRATION", v.narration)
        _sub(el, "PERSISTEDVIEW", "Accounting Voucher View")
        for line in v.lines:
            le = _sub(el, "ALLLEDGERENTRIES.LIST")
            _sub(le, "LEDGERNAME", line.ledger)
            _sub(le, "ISDEEMEDPOSITIVE", "Yes" if line.is_debit else "No")
            _sub(le, "ISPARTYLEDGER", "Yes" if line.ledger == v.party else "No")
            # Tally: debit -> negative, credit -> positive
            _sub(le, "AMOUNT", _fmt_amount(-line.amount))
    return _serialize(env)


def ledgers_to_xml(ledgers: list[Ledger], company: str | None = None) -> str:
    env, data = _envelope(company, "All Masters")
    for led in ledgers:
        led.validate()
        msg = _sub(data, "TALLYMESSAGE", **{"xmlns:UDF": "TallyUDF"})
        el = _sub(msg, "LEDGER", NAME=led.name, ACTION="Create")
        names = _sub(el, "NAME.LIST")
        _sub(names, "NAME", led.name)
        _sub(el, "PARENT", led.group)
        if led.gstin:
            _sub(el, "PARTYGSTIN", led.gstin)
            _sub(el, "GSTREGISTRATIONTYPE", "Regular")
        if led.state:
            _sub(el, "LEDSTATENAME", led.state)
        if led.opening_balance:
            # Opening debit balances are negative in Tally XML as well
            _sub(el, "OPENINGBALANCE", _fmt_amount(-led.opening_balance))
    return _serialize(env)


def _serialize(root: ET.Element) -> str:
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="unicode")


def parse_vouchers(xml_text: str) -> list[Voucher]:
    """Parses vouchers from a Tally XML export (Day Book, or our own output)."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise VoucherError(f"Invalid XML: {e}") from None

    out: list[Voucher] = []
    for el in root.iter("VOUCHER"):
        vtype = el.findtext("VOUCHERTYPENAME") or el.get("VCHTYPE") or ""
        raw_date = (el.findtext("DATE") or "").strip()
        try:
            d = datetime.strptime(raw_date, "%Y%m%d").date()
        except ValueError:
            raise VoucherError(f"Voucher has invalid DATE {raw_date!r}") from None
        v = Voucher(
            voucher_type=vtype.strip(),
            date=d,
            number=(el.findtext("VOUCHERNUMBER") or "").strip(),
            narration=(el.findtext("NARRATION") or "").strip(),
            party=(el.findtext("PARTYLEDGERNAME") or "").strip() or None,
            reference=(el.findtext("REFERENCE") or "").strip() or None,
        )
        # Tally uses either ALLLEDGERENTRIES.LIST or LEDGERENTRIES.LIST depending on the view
        for le in [*el.findall("ALLLEDGERENTRIES.LIST"), *el.findall("LEDGERENTRIES.LIST")]:
            amount = Decimal((le.findtext("AMOUNT") or "0").replace(",", "").strip())
            v.lines.append(LedgerLine(ledger=(le.findtext("LEDGERNAME") or "").strip(), amount=-amount))
        out.append(v)
    return out
