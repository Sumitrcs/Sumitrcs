"""${var} substitution for spec files.

Kept it dumb on purpose: ${name} looks up a variable, ${env:NAME} reads an
environment variable. If a string is *only* a placeholder ("${user_id}") we
return the raw value so numbers stay numbers in JSON bodies.
"""

from __future__ import annotations

import os
import re
from typing import Any

PLACEHOLDER = re.compile(r"\$\{([^}]+)\}")


class MissingVariable(KeyError):
    pass


def _lookup(name: str, variables: dict[str, Any]) -> Any:
    name = name.strip()
    if name.startswith("env:"):
        key = name[4:]
        if key not in os.environ:
            raise MissingVariable(f"environment variable {key!r} is not set")
        return os.environ[key]
    if name not in variables:
        raise MissingVariable(f"unknown variable {name!r}")
    return variables[name]


def render(value: Any, variables: dict[str, Any]) -> Any:
    if isinstance(value, str):
        whole = PLACEHOLDER.fullmatch(value)
        if whole:
            return _lookup(whole.group(1), variables)
        return PLACEHOLDER.sub(lambda m: str(_lookup(m.group(1), variables)), value)
    if isinstance(value, list):
        return [render(v, variables) for v in value]
    if isinstance(value, dict):
        return {render(k, variables): render(v, variables) for k, v in value.items()}
    return value
