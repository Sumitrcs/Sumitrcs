"""Money helpers: exact decimal arithmetic and Indian-style formatting.

Floats can't store most decimal fractions exactly (0.1 + 0.2 != 0.3), and over
240 monthly instalments those tiny errors add up. So every amount here is a
``Decimal``, rounded to paise the way a bank statement is.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

PAISA = Decimal("0.01")
RUPEE = Decimal("1")

Amount = Decimal | int | float | str


class MoneyError(ValueError):
    pass


def to_decimal(value: Amount) -> Decimal:
    """Accepts 2500000, "25,00,000", "25L", "1.2cr", 8.5 ... and returns a Decimal.

    Floats are converted through ``str`` so 8.1 becomes Decimal("8.1"),
    not 8.0999999999999996447286321199499070644378662109375.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, int):
        return Decimal(value)
    text = str(value).strip().lower().replace(",", "").replace("₹", "").replace(" ", "")
    multiplier = Decimal(1)
    for suffix, factor in (("crore", 10**7), ("cr", 10**7), ("lakh", 10**5), ("lac", 10**5), ("l", 10**5), ("k", 10**3)):
        if text.endswith(suffix):
            text = text[: -len(suffix)]
            multiplier = Decimal(factor)
            break
    try:
        result = Decimal(text) * multiplier
    except InvalidOperation:
        raise MoneyError(f"not an amount: {value!r}") from None
    if not result.is_finite():
        raise MoneyError(f"not an amount: {value!r}")
    return result


def paise(value: Decimal) -> Decimal:
    """Round to 2 decimal places, halves away from zero (₹0.005 → ₹0.01)."""
    return value.quantize(PAISA, rounding=ROUND_HALF_UP)


def rupees(value: Decimal) -> Decimal:
    return value.quantize(RUPEE, rounding=ROUND_HALF_UP)


def format_inr(value: Decimal, decimals: int = 2, symbol: bool = True) -> str:
    """Indian digit grouping: 1,23,45,678.90 (last three digits, then pairs)."""
    value = value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)
    sign = "-" if value < 0 else ""
    whole, _, fraction = f"{abs(value):f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        pairs = []
        while len(head) > 2:
            pairs.insert(0, head[-2:])
            head = head[:-2]
        whole = ",".join([head, *pairs, tail])
    text = whole + (f".{fraction}" if decimals else "")
    return f"{sign}{'₹' if symbol else ''}{text}"


def short_inr(value: Decimal) -> str:
    """Compact form people actually say: ₹25 L, ₹1.2 Cr, ₹8,678."""
    v = abs(value)
    sign = "-" if value < 0 else ""
    if v >= 10**7:
        return f"{sign}₹{_trim(v / 10**7)} Cr"
    if v >= 10**5:
        return f"{sign}₹{_trim(v / 10**5)} L"
    return sign + format_inr(v, decimals=0)


def _trim(v: Decimal) -> str:
    return f"{v.quantize(PAISA, rounding=ROUND_HALF_UP):f}".rstrip("0").rstrip(".")
