"""Tokenizer for the supported SQL subset."""

from __future__ import annotations

import re
from dataclasses import dataclass

KEYWORDS = {
    "SELECT", "DISTINCT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC",
    "LIMIT", "OFFSET", "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN",
    "JOIN", "INNER", "LEFT", "ON", "TRUE", "FALSE", "CASE", "WHEN", "THEN", "ELSE", "END",
}


class SQLSyntaxError(Exception):
    def __init__(self, message: str, pos: int):
        super().__init__(f"{message} (at position {pos})")
        self.pos = pos


@dataclass(frozen=True)
class Token:
    kind: str  # KEYWORD, IDENT, NUMBER, STRING, OP, EOF
    value: str
    pos: int


_TOKEN_RE = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<comment>--[^\n]*)
  | (?P<number>\d+\.\d*|\.\d+|\d+)
  | (?P<string>'(?:[^']|'')*')
  | (?P<qident>"(?:[^"]|"")+")
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<op><=|>=|<>|!=|\|\||[-+*/%=<>(),.])
    """,
    re.VERBOSE,
)


def tokenize(sql: str) -> list[Token]:
    tokens: list[Token] = []
    pos = 0
    while pos < len(sql):
        m = _TOKEN_RE.match(sql, pos)
        if not m:
            raise SQLSyntaxError(f"Unexpected character {sql[pos]!r}", pos)
        kind = m.lastgroup
        text = m.group()
        if kind == "number":
            tokens.append(Token("NUMBER", text, pos))
        elif kind == "string":
            tokens.append(Token("STRING", text[1:-1].replace("''", "'"), pos))
        elif kind == "qident":
            tokens.append(Token("IDENT", text[1:-1].replace('""', '"'), pos))
        elif kind == "ident":
            upper = text.upper()
            tokens.append(Token("KEYWORD", upper, pos) if upper in KEYWORDS else Token("IDENT", text, pos))
        elif kind == "op":
            tokens.append(Token("OP", "!=" if text == "<>" else text, pos))
        pos = m.end()
    tokens.append(Token("EOF", "", pos))
    return tokens
