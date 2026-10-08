"""Recursive-descent parser producing a Select AST."""

from __future__ import annotations

from .ast import (
    Between, Binary, Call, Case, Column, Expr, InList, IsNull, Join, Like, Literal,
    OrderItem, Select, SelectItem, Star, TableRef, Unary,
)
from .lexer import SQLSyntaxError, Token, tokenize


def parse(sql: str) -> Select:
    p = _Parser(tokenize(sql))
    stmt = p.select()
    p.match_op(";")
    if p.peek().kind != "EOF":
        t = p.peek()
        raise SQLSyntaxError(f"Unexpected {t.value!r}", t.pos)
    return stmt


class _Parser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.i = 0

    # -- helpers -----------------------------------------------------------
    def peek(self, k: int = 0) -> Token:
        return self.tokens[min(self.i + k, len(self.tokens) - 1)]

    def advance(self) -> Token:
        t = self.tokens[self.i]
        self.i += 1
        return t

    def at_kw(self, *words: str) -> bool:
        t = self.peek()
        return t.kind == "KEYWORD" and t.value in words

    def match_kw(self, *words: str) -> bool:
        if self.at_kw(*words):
            self.i += 1
            return True
        return False

    def expect_kw(self, word: str) -> None:
        if not self.match_kw(word):
            self.error(f"Expected {word}")

    def at_op(self, *ops: str) -> bool:
        t = self.peek()
        return t.kind == "OP" and t.value in ops

    def match_op(self, *ops: str) -> bool:
        if self.at_op(*ops):
            self.i += 1
            return True
        return False

    def expect_op(self, op: str) -> None:
        if not self.match_op(op):
            self.error(f"Expected {op!r}")

    def error(self, msg: str):
        t = self.peek()
        found = "end of query" if t.kind == "EOF" else repr(t.value)
        raise SQLSyntaxError(f"{msg}, found {found}", t.pos)

    def ident(self) -> str:
        t = self.peek()
        if t.kind != "IDENT":
            self.error("Expected an identifier")
        self.i += 1
        return t.value

    # -- statement ---------------------------------------------------------
    def select(self) -> Select:
        self.expect_kw("SELECT")
        distinct = self.match_kw("DISTINCT")
        items = [self.select_item()]
        while self.match_op(","):
            items.append(self.select_item())

        source = None
        joins: list[Join] = []
        if self.match_kw("FROM"):
            source = self.table_ref()
            while self.at_kw("JOIN", "INNER", "LEFT"):
                kind = "LEFT" if self.match_kw("LEFT") else "INNER"
                self.match_kw("INNER")
                self.expect_kw("JOIN")
                table = self.table_ref()
                self.expect_kw("ON")
                joins.append(Join(table, self.expr(), kind))

        stmt = Select(items=items, source=source, joins=joins, distinct=distinct)
        if self.match_kw("WHERE"):
            stmt.where = self.expr()
        if self.match_kw("GROUP"):
            self.expect_kw("BY")
            stmt.group_by = [self.expr()]
            while self.match_op(","):
                stmt.group_by.append(self.expr())
        if self.match_kw("HAVING"):
            stmt.having = self.expr()
        if self.match_kw("ORDER"):
            self.expect_kw("BY")
            stmt.order_by = [self.order_item()]
            while self.match_op(","):
                stmt.order_by.append(self.order_item())
        if self.match_kw("LIMIT"):
            stmt.limit = self.integer()
            if self.match_kw("OFFSET"):
                stmt.offset = self.integer()
        return stmt

    def integer(self) -> int:
        t = self.peek()
        if t.kind != "NUMBER" or not t.value.isdigit():
            self.error("Expected a whole number")
        self.i += 1
        return int(t.value)

    def select_item(self) -> SelectItem:
        if self.match_op("*"):
            return SelectItem(Star(), None)
        # table.*
        if self.peek().kind == "IDENT" and self.peek(1).value == "." and self.peek(2).value == "*":
            table = self.advance().value
            self.i += 2
            return SelectItem(Star(table), None)
        e = self.expr()
        alias = None
        if self.match_kw("AS"):
            alias = self.ident()
        elif self.peek().kind == "IDENT":
            alias = self.ident()
        return SelectItem(e, alias)

    def table_ref(self) -> TableRef:
        name = self.ident()
        alias = None
        if self.match_kw("AS"):
            alias = self.ident()
        elif self.peek().kind == "IDENT":
            alias = self.ident()
        return TableRef(name, alias)

    def order_item(self) -> OrderItem:
        e = self.expr()
        desc = False
        if self.match_kw("DESC"):
            desc = True
        else:
            self.match_kw("ASC")
        return OrderItem(e, desc)

    # -- expressions (lowest to highest precedence) ------------------------
    def expr(self) -> Expr:
        return self.or_expr()

    def or_expr(self) -> Expr:
        left = self.and_expr()
        while self.match_kw("OR"):
            left = Binary("OR", left, self.and_expr())
        return left

    def and_expr(self) -> Expr:
        left = self.not_expr()
        while self.match_kw("AND"):
            left = Binary("AND", left, self.not_expr())
        return left

    def not_expr(self) -> Expr:
        if self.match_kw("NOT"):
            return Unary("NOT", self.not_expr())
        return self.predicate()

    def predicate(self) -> Expr:
        left = self.additive()
        if self.at_op("=", "!=", "<", "<=", ">", ">="):
            op = self.advance().value
            return Binary(op, left, self.additive())
        if self.match_kw("IS"):
            negated = self.match_kw("NOT")
            self.expect_kw("NULL")
            return IsNull(left, negated)

        negated = self.match_kw("NOT")
        if self.match_kw("IN"):
            self.expect_op("(")
            items = [self.expr()]
            while self.match_op(","):
                items.append(self.expr())
            self.expect_op(")")
            return InList(left, tuple(items), negated)
        if self.match_kw("BETWEEN"):
            low = self.additive()
            self.expect_kw("AND")
            return Between(left, low, self.additive(), negated)
        if self.match_kw("LIKE"):
            return Like(left, self.additive(), negated)
        if negated:
            self.error("Expected IN, BETWEEN or LIKE after NOT")
        return left

    def additive(self) -> Expr:
        left = self.term()
        while self.at_op("+", "-", "||"):
            op = self.advance().value
            left = Binary(op, left, self.term())
        return left

    def term(self) -> Expr:
        left = self.unary()
        while self.at_op("*", "/", "%"):
            op = self.advance().value
            left = Binary(op, left, self.unary())
        return left

    def unary(self) -> Expr:
        if self.match_op("-"):
            return Unary("-", self.unary())
        self.match_op("+")
        return self.primary()

    def primary(self) -> Expr:
        t = self.peek()
        if t.kind == "NUMBER":
            self.i += 1
            return Literal(float(t.value) if "." in t.value else int(t.value))
        if t.kind == "STRING":
            self.i += 1
            return Literal(t.value)
        if self.match_kw("NULL"):
            return Literal(None)
        if self.match_kw("TRUE"):
            return Literal(True)
        if self.match_kw("FALSE"):
            return Literal(False)
        if self.match_kw("CASE"):
            return self.case()
        if self.match_op("("):
            e = self.expr()
            self.expect_op(")")
            return e
        if t.kind == "IDENT":
            self.i += 1
            if self.match_op("("):
                return self.call(t.value.upper())
            if self.match_op("."):
                return Column(self.ident(), t.value)
            return Column(t.value)
        self.error("Expected an expression")

    def call(self, name: str) -> Call:
        if self.match_op("*"):
            self.expect_op(")")
            if name != "COUNT":
                self.error(f"{name}(*) is not supported")
            return Call(name, (), star=True)
        distinct = self.match_kw("DISTINCT")
        args: list[Expr] = []
        if not self.at_op(")"):
            args.append(self.expr())
            while self.match_op(","):
                args.append(self.expr())
        self.expect_op(")")
        return Call(name, tuple(args), distinct=distinct)

    def case(self) -> Case:
        whens = []
        while self.match_kw("WHEN"):
            cond = self.expr()
            self.expect_kw("THEN")
            whens.append((cond, self.expr()))
        if not whens:
            self.error("CASE needs at least one WHEN")
        otherwise = self.expr() if self.match_kw("ELSE") else None
        self.expect_kw("END")
        return Case(tuple(whens), otherwise)
