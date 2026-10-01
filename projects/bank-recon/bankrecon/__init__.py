"""Automatic bank reconciliation and BRS generation."""

from .brs import BRS, reconcile, render, suggest
from .matcher import Match, MatchConfig, Reconciler, similarity
from .models import Entry, InputError, extract_reference, load_entries, parse_amount, parse_date

__all__ = [
    "BRS", "Entry", "InputError", "Match", "MatchConfig", "Reconciler", "extract_reference",
    "load_entries", "parse_amount", "parse_date", "reconcile", "render", "similarity", "suggest",
]
__version__ = "1.0.0"
