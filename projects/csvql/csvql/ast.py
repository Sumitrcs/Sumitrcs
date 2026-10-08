"""AST node definitions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

AGGREGATES = {"COUNT", "SUM", "AVG", "MIN", "MAX"}


class Expr:
    pass


@dataclass(frozen=True)
class Literal(Expr):
    value: Any


@dataclass(frozen=True)
class Column(Expr):
    name: str
    table: str | None = None

    def __str__(self) -> str:
        return f"{self.table}.{self.name}" if self.table else self.name


@dataclass(frozen=True)
class Star(Expr):
    table: str | None = None


@dataclass(frozen=True)
class Unary(Expr):
    op: str
    operand: Expr


@dataclass(frozen=True)
class Binary(Expr):
    op: str
    left: Expr
    right: Expr


@dataclass(frozen=True)
class InList(Expr):
    expr: Expr
    items: tuple[Expr, ...]
    negated: bool = False


@dataclass(frozen=True)
class Between(Expr):
    expr: Expr
    low: Expr
    high: Expr
    negated: bool = False


@dataclass(frozen=True)
class IsNull(Expr):
    expr: Expr
    negated: bool = False


@dataclass(frozen=True)
class Like(Expr):
    expr: Expr
    pattern: Expr
    negated: bool = False


@dataclass(frozen=True)
class Case(Expr):
    whens: tuple[tuple[Expr, Expr], ...]
    otherwise: Expr | None


@dataclass(frozen=True)
class Call(Expr):
    name: str
    args: tuple[Expr, ...]
    distinct: bool = False
    star: bool = False

    @property
    def is_aggregate(self) -> bool:
        return self.name in AGGREGATES


@dataclass
class SelectItem:
    expr: Expr
    alias: str | None


@dataclass
class TableRef:
    name: str
    alias: str | None

    @property
    def ref(self) -> str:
        return self.alias or self.name


@dataclass
class Join:
    table: TableRef
    on: Expr
    kind: str  # INNER or LEFT


@dataclass
class OrderItem:
    expr: Expr
    descending: bool


@dataclass
class Select:
    items: list[SelectItem]
    source: TableRef | None
    joins: list[Join] = field(default_factory=list)
    where: Expr | None = None
    group_by: list[Expr] = field(default_factory=list)
    having: Expr | None = None
    order_by: list[OrderItem] = field(default_factory=list)
    limit: int | None = None
    offset: int = 0
    distinct: bool = False


def contains_aggregate(e: Expr) -> bool:
    if isinstance(e, Call):
        return e.is_aggregate or any(contains_aggregate(a) for a in e.args)
    if isinstance(e, Unary):
        return contains_aggregate(e.operand)
    if isinstance(e, Binary):
        return contains_aggregate(e.left) or contains_aggregate(e.right)
    if isinstance(e, (InList, Between, IsNull, Like)):
        return any(contains_aggregate(c) for c in vars(e).values() if isinstance(c, Expr))
    if isinstance(e, Case):
        return any(contains_aggregate(a) or contains_aggregate(b) for a, b in e.whens) or (
            e.otherwise is not None and contains_aggregate(e.otherwise)
        )
    return False
