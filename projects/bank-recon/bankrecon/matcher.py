"""Multi-pass matching of bank statement lines against book entries.

Passes run from most to least certain; anything matched in an earlier pass
is removed from consideration, so later (fuzzier) passes only see leftovers.

1. reference   – same UTR/cheque number and same amount
2. exact       – same amount and same date
3. window      – same amount within ±N days, closest date wins
4. fuzzy       – same amount within a wider window and similar narration
5. split       – one bank line equals the sum of 2–3 book entries (or vice versa),
                 e.g. a single deposit slip containing several cheques
"""

from __future__ import annotations

import itertools
import re
from dataclasses import dataclass
from decimal import Decimal
from difflib import SequenceMatcher

from .models import Entry

STOPWORDS = {"to", "from", "by", "the", "a", "of", "and", "neft", "imps", "rtgs", "upi", "chq", "trf", "transfer", "payment"}


@dataclass
class Match:
    bank: list[Entry]
    books: list[Entry]
    kind: str
    confidence: float

    @property
    def amount(self) -> Decimal:
        return sum((e.amount for e in self.bank), Decimal(0))


@dataclass
class MatchConfig:
    window_days: int = 3
    fuzzy_window_days: int = 10
    fuzzy_threshold: float = 0.45
    split_window_days: int = 5
    max_split: int = 3


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOPWORDS and not t.isdigit()}


def similarity(a: str, b: str) -> float:
    """Best of token overlap and character similarity.

    The overlap coefficient (|A∩B| / min(|A|,|B|)) suits bank narrations,
    which are short and truncated compared with book descriptions.
    """
    ta, tb = _tokens(a), _tokens(b)
    overlap = len(ta & tb) / min(len(ta), len(tb)) if ta and tb else 0.0
    chars = SequenceMatcher(None, a.lower(), b.lower()).ratio()
    return max(overlap, chars * 0.9)


class Reconciler:
    def __init__(self, bank: list[Entry], books: list[Entry], config: MatchConfig | None = None):
        self.bank = bank
        self.books = books
        self.cfg = config or MatchConfig()
        self.matches: list[Match] = []

    def _open(self, entries: list[Entry]) -> list[Entry]:
        return [e for e in entries if not e.matched]

    def _record(self, bank: list[Entry], books: list[Entry], kind: str, confidence: float) -> None:
        for e in (*bank, *books):
            e.matched = True
        self.matches.append(Match(bank, books, kind, round(confidence, 2)))

    def run(self) -> list[Match]:
        self._pass_reference()
        self._pass_pairs("exact", max_days=0, min_sim=0.0, base=0.95)
        self._pass_pairs("window", max_days=self.cfg.window_days, min_sim=0.0, base=0.85)
        self._pass_pairs("fuzzy", max_days=self.cfg.fuzzy_window_days, min_sim=self.cfg.fuzzy_threshold, base=0.6)
        self._pass_split(self.bank, self.books, bank_is_one=True)
        self._pass_split(self.books, self.bank, bank_is_one=False)
        return self.matches

    def _pass_reference(self) -> None:
        index: dict[tuple[str, Decimal], list[Entry]] = {}
        for b in self._open(self.books):
            if b.reference:
                index.setdefault((b.reference, b.amount), []).append(b)
        for e in self._open(self.bank):
            cands = [c for c in index.get((e.reference, e.amount), []) if not c.matched] if e.reference else []
            if cands:
                best = min(cands, key=lambda c: abs((c.date - e.date).days))
                self._record([e], [best], "reference", 1.0)

    def _pass_pairs(self, kind: str, max_days: int, min_sim: float, base: float) -> None:
        # Score every candidate pair, then accept greedily from the best score
        # down. Greedy on a global ranking avoids an early bank line stealing
        # the book entry that is a much better fit for a later line.
        by_amount: dict[Decimal, list[Entry]] = {}
        for b in self._open(self.books):
            by_amount.setdefault(b.amount, []).append(b)

        scored = []
        for e in self._open(self.bank):
            for b in by_amount.get(e.amount, []):
                days = abs((b.date - e.date).days)
                if days > max_days:
                    continue
                sim = similarity(e.description, b.description)
                if sim < min_sim:
                    continue
                date_score = 1 - days / (max_days + 1)
                score = base + (1 - base) * (0.6 * date_score + 0.4 * sim)
                scored.append((score, e, b))

        for score, e, b in sorted(scored, key=lambda t: -t[0]):
            if not e.matched and not b.matched:
                self._record([e], [b], kind, score)

    def _pass_split(self, ones: list[Entry], many: list[Entry], bank_is_one: bool) -> None:
        for one in self._open(ones):
            pool = [
                m for m in self._open(many)
                if abs((m.date - one.date).days) <= self.cfg.split_window_days
                and m.amount != 0 and (m.amount > 0) == (one.amount > 0)
                and abs(m.amount) < abs(one.amount)
            ]
            pool.sort(key=lambda m: abs((m.date - one.date).days))
            pool = pool[:12]  # bound the combinatorics: C(12,3) = 220
            found = None
            for size in range(2, self.cfg.max_split + 1):
                for combo in itertools.combinations(pool, size):
                    if sum((c.amount for c in combo), Decimal(0)) == one.amount:
                        found = list(combo)
                        break
                if found:
                    break
            if found:
                conf = 0.7 - 0.05 * (len(found) - 2)
                if bank_is_one:
                    self._record([one], found, "split", conf)
                else:
                    self._record(found, [one], "split", conf)
