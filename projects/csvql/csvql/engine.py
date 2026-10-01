"""Query execution: scan -> join -> filter -> group -> project -> sort -> limit."""

from __future__ import annotations

import csv
import functools
from decimal import ROUND_HALF_UP, Decimal
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from .ast import (
    Between, Binary, Call, Case, Column, Expr, InList, IsNull, Like, Literal, Select, Star,
    Unary, contains_aggregate,
)
from .parser import parse

Row = dict[str, Any]  # "ref.column" -> value


class QueryError(Exception):
    pass


@dataclass
class Table:
    name: str
    columns: list[str]
    rows: list[list[Any]]

    @classmethod
    def from_csv(cls, path: str | Path, name: str | None = None, delimiter: str = ",") -> "Table":
        path = Path(path)
        with path.open(newline="", encoding="utf-8-sig") as f:
            reader = csv.reader(f, delimiter=delimiter)
            try:
                header = [h.strip() for h in next(reader)]
            except StopIteration:
                raise QueryError(f"{path} is empty") from None
            raw = [r for r in reader if any(cell.strip() for cell in r)]
        if len(set(header)) != len(header):
            raise QueryError(f"{path} has duplicate column names")
        columns = list(zip(*raw)) if raw else [() for _ in header]
        converters = [_infer_type(col) for col in columns]
        rows = [[conv(cell) for conv, cell in zip(converters, r)] for r in raw]
        return cls(name or path.stem, header, rows)

    @classmethod
    def from_records(cls, name: str, records: list[dict[str, Any]]) -> "Table":
        columns = list(records[0].keys()) if records else []
        return cls(name, columns, [[r.get(c) for c in columns] for r in records])


def _to_none(s: str) -> None:
    return None


def _infer_type(values: Iterable[str]) -> Callable[[str], Any]:
    """Pick the narrowest type that fits every non-empty cell of a column."""
    non_empty = [v.strip() for v in values if v.strip() != ""]

    def nullable(fn):
        return lambda s: None if s.strip() == "" else fn(s.strip())

    if not non_empty:
        return _to_none
    for caster in (int, float):
        try:
            for v in non_empty:
                caster(v.replace(",", "") if caster is float else v)
            if caster is float:
                return nullable(lambda s: float(s.replace(",", "")))
            return nullable(int)
        except ValueError:
            continue
    return lambda s: None if s.strip() == "" else s


# ---------------------------------------------------------------------------


class Database:
    def __init__(self) -> None:
        self.tables: dict[str, Table] = {}

    def register(self, table: Table) -> None:
        self.tables[table.name.lower()] = table

    def load_csv(self, path: str | Path, name: str | None = None) -> Table:
        t = Table.from_csv(path, name)
        self.register(t)
        return t

    def table(self, name: str) -> Table:
        try:
            return self.tables[name.lower()]
        except KeyError:
            known = ", ".join(sorted(self.tables)) or "none"
            raise QueryError(f"Unknown table {name!r} (loaded: {known})") from None

    def query(self, sql: str) -> "Result":
        return _Executor(self, parse(sql)).run()


@dataclass
class Result:
    columns: list[str]
    rows: list[tuple[Any, ...]]

    def as_dicts(self) -> list[dict[str, Any]]:
        return [dict(zip(self.columns, r)) for r in self.rows]


# ---------------------------------------------------------------------------


class _Scope:
    """Resolves (possibly unqualified) column names to row keys."""

    def __init__(self) -> None:
        self.keys: list[str] = []
        self.by_name: dict[str, list[str]] = {}
        self.refs: dict[str, list[str]] = {}

    def add_table(self, ref: str, columns: list[str]) -> None:
        ref_l = ref.lower()
        if ref_l in self.refs:
            raise QueryError(f"Table reference {ref!r} used twice; add an alias")
        self.refs[ref_l] = []
        for c in columns:
            key = f"{ref_l}.{c}"
            self.keys.append(key)
            self.refs[ref_l].append(key)
            self.by_name.setdefault(c.lower(), []).append(key)

    def resolve(self, col: Column) -> str:
        if col.table:
            key_prefix = col.table.lower()
            for k in self.refs.get(key_prefix, []):
                if k.split(".", 1)[1].lower() == col.name.lower():
                    return k
            raise QueryError(f"Unknown column {col}")
        matches = self.by_name.get(col.name.lower(), [])
        if not matches:
            raise QueryError(f"Unknown column {col.name!r}")
        if len(matches) > 1:
            raise QueryError(f"Column {col.name!r} is ambiguous; qualify it with a table name")
        return matches[0]


class _Executor:
    def __init__(self, db: Database, stmt: Select):
        self.db = db
        self.stmt = stmt
        self.scope = _Scope()
        self.aliases: dict[str, Expr] = {}

    def run(self) -> Result:
        s = self.stmt
        rows = self.scan()
        if s.where is not None:
            if contains_aggregate(s.where):
                raise QueryError("Aggregates are not allowed in WHERE; use HAVING")
            rows = [r for r in rows if self.eval(s.where, r) is True]

        items = self.expand_star()
        self.aliases = {alias.lower(): e for e, alias, _ in items if alias}
        grouped = bool(s.group_by) or any(contains_aggregate(e) for e, _, _ in items) or (
            s.having is not None
        )

        # Each output "unit" is (representative row, rows in group)
        if grouped:
            groups: dict[tuple, list[Row]] = {}
            for r in rows:
                key = tuple(_hashable(self.eval(g, r)) for g in s.group_by)
                groups.setdefault(key, []).append(r)
            if not groups and not s.group_by:
                groups[()] = []  # SELECT COUNT(*) FROM empty -> one row
            units = [(g[0] if g else {}, g) for g in groups.values()]
        else:
            units = [(r, None) for r in rows]

        if s.having is not None:
            units = [u for u in units if self.eval(s.having, u[0], u[1]) is True]

        out = [(tuple(self.eval(e, r, g) for e, _, _ in items), r, g) for r, g in units]

        if s.order_by:
            out = self.sort(out, items)

        rows_out = [o[0] for o in out]
        if s.distinct:
            seen: set = set()
            unique = []
            for r in rows_out:
                h = tuple(_hashable(v) for v in r)
                if h not in seen:
                    seen.add(h)
                    unique.append(r)
            rows_out = unique
        end = None if s.limit is None else s.offset + s.limit
        rows_out = rows_out[s.offset:end]
        return Result([label for _, _, label in items], rows_out)

    # -- FROM / JOIN -------------------------------------------------------
    def scan(self) -> list[Row]:
        s = self.stmt
        if s.source is None:
            return [{}]
        base = self.db.table(s.source.name)
        ref = s.source.ref
        self.scope.add_table(ref, base.columns)
        rows = [self._row(ref, base.columns, r) for r in base.rows]
        for j in s.joins:
            right = self.db.table(j.table.name)
            self.scope.add_table(j.table.ref, right.columns)
            right_rows = [self._row(j.table.ref, right.columns, r) for r in right.rows]
            rows = self.join(rows, right_rows, j.table.ref, right.columns, j.on, j.kind)
        return rows

    @staticmethod
    def _row(ref: str, columns: list[str], values: list[Any]) -> Row:
        ref = ref.lower()
        return {f"{ref}.{c}": v for c, v in zip(columns, values)}

    def join(self, left: list[Row], right: list[Row], ref: str, cols: list[str], on: Expr, kind: str) -> list[Row]:
        null_right = {f"{ref.lower()}.{c}": None for c in cols}
        keys = self._equi_join_keys(on, ref)
        out: list[Row] = []
        if keys:
            # Hash join: build on the right side, probe with the left.
            lkey, rkey = keys
            index: dict[Any, list[Row]] = {}
            for r in right:
                v = r[rkey]
                if v is not None:
                    index.setdefault(_hashable(v), []).append(r)
            for l in left:
                v = l[lkey]
                matches = index.get(_hashable(v), []) if v is not None else []
                for r in matches:
                    out.append({**l, **r})
                if not matches and kind == "LEFT":
                    out.append({**l, **null_right})
            return out
        for l in left:  # nested loop for arbitrary ON conditions
            matched = False
            for r in right:
                merged = {**l, **r}
                if self.eval(on, merged) is True:
                    out.append(merged)
                    matched = True
            if not matched and kind == "LEFT":
                out.append({**l, **null_right})
        return out

    def _equi_join_keys(self, on: Expr, right_ref: str) -> tuple[str, str] | None:
        if not (isinstance(on, Binary) and on.op == "=" and isinstance(on.left, Column) and isinstance(on.right, Column)):
            return None
        a, b = self.scope.resolve(on.left), self.scope.resolve(on.right)
        prefix = right_ref.lower() + "."
        if b.startswith(prefix) and not a.startswith(prefix):
            return a, b
        if a.startswith(prefix) and not b.startswith(prefix):
            return b, a
        return None

    # -- projection ----------------------------------------------------------
    def expand_star(self) -> list[tuple[Expr, str | None, str]]:
        items: list[tuple[Expr, str | None, str]] = []
        for it in self.stmt.items:
            if isinstance(it.expr, Star):
                keys = self.scope.keys if it.expr.table is None else self.scope.refs.get(it.expr.table.lower())
                if keys is None:
                    raise QueryError(f"Unknown table {it.expr.table!r} in {it.expr.table}.*")
                for k in keys:
                    ref, name = k.split(".", 1)
                    items.append((Column(name, ref), None, name))
            else:
                items.append((it.expr, it.alias, it.alias or _label(it.expr)))
        return items

    def sort(self, out, items):
        positions = {}
        for idx, (e, alias, label) in enumerate(items):
            positions[label.lower()] = idx

        def key_fn(o, order):
            values, row, group = o
            e = order.expr
            if isinstance(e, Literal) and isinstance(e.value, int):  # ORDER BY 2
                if not 1 <= e.value <= len(values):
                    raise QueryError(f"ORDER BY position {e.value} is out of range")
                return values[e.value - 1]
            if isinstance(e, Column) and e.table is None and e.name.lower() in positions:
                return values[positions[e.name.lower()]]
            return self.eval(e, row, group)

        # Stable multi-key sort: apply keys from last to first.
        for order in reversed(self.stmt.order_by):
            out.sort(key=functools.cmp_to_key(lambda a, b, o=order: _compare(key_fn(a, o), key_fn(b, o))),
                     reverse=order.descending)
        return out

    # -- expression evaluation -------------------------------------------
    def eval(self, e: Expr, row: Row, group: list[Row] | None = None) -> Any:
        if isinstance(e, Literal):
            return e.value
        if isinstance(e, Column):
            if e.table is None and e.name.lower() in self.aliases and e.name.lower() not in self.scope.by_name:
                return self.eval(self.aliases[e.name.lower()], row, group)
            return row.get(self.scope.resolve(e))
        if isinstance(e, Call):
            if e.is_aggregate:
                if group is None:
                    raise QueryError(f"{e.name}() used outside of an aggregate context")
                return self.aggregate(e, group)
            return _call_scalar(e.name, [self.eval(a, row, group) for a in e.args])
        if isinstance(e, Unary):
            v = self.eval(e.operand, row, group)
            if e.op == "NOT":
                return None if v is None else not _truthy(v)
            return None if v is None else -_num(v)
        if isinstance(e, Binary):
            return self.binary(e, row, group)
        if isinstance(e, IsNull):
            return (self.eval(e.expr, row, group) is None) != e.negated
        if isinstance(e, InList):
            v = self.eval(e.expr, row, group)
            if v is None:
                return None
            hit = any(_compare(v, self.eval(i, row, group)) == 0 for i in e.items)
            return hit != e.negated
        if isinstance(e, Between):
            v, lo, hi = (self.eval(x, row, group) for x in (e.expr, e.low, e.high))
            if None in (v, lo, hi):
                return None
            return (_compare(lo, v) <= 0 <= _compare(hi, v)) != e.negated
        if isinstance(e, Like):
            v, pat = self.eval(e.expr, row, group), self.eval(e.pattern, row, group)
            if v is None or pat is None:
                return None
            return bool(_like_regex(str(pat)).fullmatch(str(v))) != e.negated
        if isinstance(e, Case):
            for cond, result in e.whens:
                if self.eval(cond, row, group) is True:
                    return self.eval(result, row, group)
            return None if e.otherwise is None else self.eval(e.otherwise, row, group)
        raise QueryError(f"Cannot evaluate {e!r}")

    def binary(self, e: Binary, row: Row, group) -> Any:
        if e.op in ("AND", "OR"):
            l = self.eval(e.left, row, group)
            # Three-valued logic with short-circuiting
            if e.op == "AND" and l is False:
                return False
            if e.op == "OR" and l is True:
                return True
            r = self.eval(e.right, row, group)
            if e.op == "AND":
                return False if r is False else (None if None in (l, r) else True)
            return True if r is True else (None if None in (l, r) else False)

        l, r = self.eval(e.left, row, group), self.eval(e.right, row, group)
        if l is None or r is None:
            return None
        if e.op == "||":
            return f"{l}{r}"
        if e.op in ("=", "!=", "<", "<=", ">", ">="):
            c = _compare(l, r)
            return {"=": c == 0, "!=": c != 0, "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0}[e.op]
        a, b = _num(l), _num(r)
        if e.op == "+":
            return a + b
        if e.op == "-":
            return a - b
        if e.op == "*":
            return a * b
        if b == 0:
            return None  # division by zero yields NULL, as in SQLite
        if e.op == "/":
            return a // b if isinstance(a, int) and isinstance(b, int) else a / b
        return a % b

    def aggregate(self, e: Call, group: list[Row]) -> Any:
        if e.star:
            return len(group)
        if len(e.args) != 1:
            raise QueryError(f"{e.name}() takes exactly one argument")
        values = [self.eval(e.args[0], r) for r in group]
        values = [v for v in values if v is not None]
        if e.distinct:
            seen, uniq = set(), []
            for v in values:
                if _hashable(v) not in seen:
                    seen.add(_hashable(v))
                    uniq.append(v)
            values = uniq
        if e.name == "COUNT":
            return len(values)
        if not values:
            return None
        if e.name == "SUM":
            return sum(_num(v) for v in values)
        if e.name == "AVG":
            return sum(_num(v) for v in values) / len(values)
        key = functools.cmp_to_key(_compare)
        return min(values, key=key) if e.name == "MIN" else max(values, key=key)


# ---------------------------------------------------------------------------


def _label(e: Expr) -> str:
    if isinstance(e, Column):
        return e.name
    if isinstance(e, Call):
        inner = "*" if e.star else ", ".join(_label(a) for a in e.args)
        return f"{e.name.lower()}({'distinct ' if e.distinct else ''}{inner})"
    if isinstance(e, Literal):
        return repr(e.value)
    if isinstance(e, Binary):
        return f"{_label(e.left)} {e.op.lower()} {_label(e.right)}"
    return "expr"


def _hashable(v: Any) -> Any:
    # 1 and 1.0 should group together
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _truthy(v: Any) -> bool:
    return bool(v)


def _num(v: Any) -> int | float:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return v
    try:
        return float(v)
    except (TypeError, ValueError):
        raise QueryError(f"Expected a number, got {v!r}") from None


def _compare(a: Any, b: Any) -> int:
    """Total order: NULL < numbers < strings; numbers compare numerically."""
    rank = lambda x: 0 if x is None else 1 if isinstance(x, (int, float, bool)) else 2  # noqa: E731
    ra, rb = rank(a), rank(b)
    if ra != rb:
        # Allow comparing a numeric string with a number ('10' = 10)
        if {ra, rb} == {1, 2}:
            try:
                fa, fb = float(a), float(b)
                return (fa > fb) - (fa < fb)
            except ValueError:
                pass
        return (ra > rb) - (ra < rb)
    if a is None:
        return 0
    return (a > b) - (a < b)


@functools.lru_cache(maxsize=256)
def _like_regex(pattern: str) -> re.Pattern:
    out = []
    for ch in pattern:
        out.append(".*" if ch == "%" else "." if ch == "_" else re.escape(ch))
    return re.compile("".join(out), re.DOTALL)


def _call_scalar(name: str, args: list[Any]) -> Any:
    def need(n: int | tuple[int, int]):
        lo, hi = (n, n) if isinstance(n, int) else n
        if not lo <= len(args) <= hi:
            raise QueryError(f"{name}() takes {lo if lo == hi else f'{lo}-{hi}'} argument(s)")

    if name in ("COALESCE", "IFNULL"):
        return next((a for a in args if a is not None), None)
    if name == "CONCAT":
        return "".join("" if a is None else str(a) for a in args)
    if args and args[0] is None:
        return None
    if name == "UPPER":
        need(1)
        return str(args[0]).upper()
    if name == "LOWER":
        need(1)
        return str(args[0]).lower()
    if name == "LENGTH":
        need(1)
        return len(str(args[0]))
    if name == "TRIM":
        need(1)
        return str(args[0]).strip()
    if name == "ABS":
        need(1)
        return abs(_num(args[0]))
    if name == "ROUND":
        need((1, 2))
        digits = int(args[1]) if len(args) > 1 else 0
        # Round half away from zero on the decimal representation: Python's
        # round() uses banker's rounding and binary floats turn 1.005 into 1.00499…
        value = Decimal(str(_num(args[0]))).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
        return int(value) if digits <= 0 else float(value)
    if name == "SUBSTR":
        need((2, 3))
        s, start = str(args[0]), int(args[1]) - 1
        return s[start:] if len(args) == 2 else s[start:start + int(args[2])]
    if name in ("YEAR", "MONTH", "DAY"):
        need(1)
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(args[0]))
        if not m:
            raise QueryError(f"{name}() expects a YYYY-MM-DD date, got {args[0]!r}")
        return int(m.group({"YEAR": 1, "MONTH": 2, "DAY": 3}[name]))
    raise QueryError(f"Unknown function {name}()")
