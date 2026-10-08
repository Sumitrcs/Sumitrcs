"""csvql — run SQL queries directly against CSV files."""

from .engine import Database, QueryError, Result, Table
from .lexer import SQLSyntaxError
from .parser import parse

__all__ = ["Database", "QueryError", "Result", "SQLSyntaxError", "Table", "parse"]
__version__ = "1.0.0"
