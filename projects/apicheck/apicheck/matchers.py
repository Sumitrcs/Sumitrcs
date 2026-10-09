"""Looking things up inside JSON and checking them against expectations.

Paths are dot separated: "data.items.0.name". Numbers index into lists,
negative numbers count from the end (handy for "last item").

An expectation is either a plain value (must be equal) or a dict of
operators like {"gt": 0, "type": "number"}. All operators in the dict must
pass.
"""

from __future__ import annotations

import re
from typing import Any

MISSING = object()

TYPES = {
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
    "array": list,
    "object": dict,
    "null": type(None),
}


def get_path(data: Any, path: str) -> Any:
    if path in ("", "$"):
        return data
    cur = data
    for part in path.split("."):
        if isinstance(cur, dict):
            if part not in cur:
                return MISSING
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return MISSING
        else:
            return MISSING
    return cur


def _type_ok(value: Any, name: str) -> bool:
    if name not in TYPES:
        raise ValueError(f"unknown type {name!r}, use one of {', '.join(TYPES)}")
    # bool is a subclass of int in Python, which bites you here
    if name in ("number", "integer") and isinstance(value, bool):
        return False
    return isinstance(value, TYPES[name])


def _num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def check_one(op: str, arg: Any, value: Any) -> str | None:
    """Returns None when it passes, otherwise a short reason."""
    if op == "exists":
        if (value is not MISSING) != bool(arg):
            return "is missing" if arg else "should not exist"
        return None
    if value is MISSING:
        return "is missing"

    if op == "eq":
        return None if value == arg else f"expected {arg!r}, got {value!r}"
    if op == "ne":
        return None if value != arg else f"should not be {arg!r}"
    if op == "type":
        return None if _type_ok(value, arg) else f"expected type {arg}, got {type(value).__name__}"
    if op in ("gt", "gte", "lt", "lte"):
        if not _num(value):
            return f"expected a number, got {value!r}"
        ok = {"gt": value > arg, "gte": value >= arg, "lt": value < arg, "lte": value <= arg}[op]
        return None if ok else f"expected {op} {arg}, got {value!r}"
    if op == "contains":
        try:
            return None if arg in value else f"{value!r} does not contain {arg!r}"
        except TypeError:
            return f"can't search inside {type(value).__name__}"
    if op == "regex":
        if not isinstance(value, str):
            return f"regex needs a string, got {type(value).__name__}"
        return None if re.search(arg, value) else f"{value!r} does not match /{arg}/"
    if op == "len":
        try:
            n = len(value)
        except TypeError:
            return f"{type(value).__name__} has no length"
        return None if n == arg else f"expected length {arg}, got {n}"
    if op == "in":
        return None if value in arg else f"{value!r} not in {arg!r}"
    raise ValueError(f"unknown matcher {op!r}")


OPERATORS = {"exists", "eq", "ne", "type", "gt", "gte", "lt", "lte", "contains", "regex", "len", "in"}


def check(expected: Any, value: Any) -> list[str]:
    # a dict whose keys are all operators is a matcher, anything else is a literal
    if isinstance(expected, dict) and expected and set(expected) <= OPERATORS:
        return [r for op, arg in expected.items() if (r := check_one(op, arg, value))]
    r = check_one("eq", expected, value)
    return [r] if r else []
