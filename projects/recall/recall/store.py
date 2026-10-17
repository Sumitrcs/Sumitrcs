"""Cards and review history in a single SQLite file.

SQLite is a full SQL database that lives in one ordinary file. Python ships
with it (the sqlite3 module), so there is nothing to install or run.
"""

from __future__ import annotations

import csv
import io
import sqlite3
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from .sm2 import Schedule, review

SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
    id        INTEGER PRIMARY KEY,
    deck      TEXT NOT NULL,
    front     TEXT NOT NULL,
    back      TEXT NOT NULL,
    reps      INTEGER NOT NULL DEFAULT 0,
    interval  INTEGER NOT NULL DEFAULT 0,
    ease      REAL    NOT NULL DEFAULT 2.5,
    due       TEXT,                         -- ISO date; NULL = new card
    lapses    INTEGER NOT NULL DEFAULT 0,   -- times forgotten after learning it
    created   TEXT NOT NULL,
    UNIQUE (deck, front)
);
CREATE TABLE IF NOT EXISTS reviews (
    card_id   INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    day       TEXT NOT NULL,
    grade     INTEGER NOT NULL,
    interval  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_due ON cards (deck, due);
"""


@dataclass(frozen=True)
class Card:
    id: int
    deck: str
    front: str
    back: str
    schedule: Schedule
    lapses: int = 0


class StoreError(ValueError):
    pass


class Store:
    def __init__(self, path: str | Path = ":memory:"):
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    # -- adding cards ------------------------------------------------------

    def add(self, deck: str, front: str, back: str, today: date | None = None) -> bool:
        """Adds a card. Returns False (and changes nothing) if the deck already
        has a card with the same front, so importing a file twice is safe."""
        deck, front, back = deck.strip(), front.strip(), back.strip()
        if not deck or not front or not back:
            raise StoreError("deck, front and back must not be empty")
        with self.db:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO cards (deck, front, back, created) VALUES (?, ?, ?, ?)",
                (deck, front, back, (today or date.today()).isoformat()),
            )
        return cur.rowcount == 1

    def import_csv(self, deck: str, text: str, today: date | None = None) -> tuple[int, int]:
        """Imports "front,back" rows (comma, semicolon or tab separated; a header
        row named front/back or question/answer is skipped).
        Returns (added, skipped)."""
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        added = skipped = 0
        for n, row in enumerate(csv.reader(io.StringIO(text), dialect)):
            if not row or not any(cell.strip() for cell in row):
                continue
            if n == 0 and [c.strip().lower() for c in row[:2]] in (["front", "back"], ["question", "answer"]):
                continue
            if len(row) < 2 or not row[0].strip() or not row[1].strip():
                raise StoreError(f"row {n + 1}: expected two columns (front, back), got {row!r}")
            if self.add(deck, row[0], row[1], today):
                added += 1
            else:
                skipped += 1
        return added, skipped

    def export_csv(self, deck: str) -> str:
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(["front", "back"])
        for row in self.db.execute("SELECT front, back FROM cards WHERE deck = ? ORDER BY id", (deck,)):
            writer.writerow([row["front"], row["back"]])
        return out.getvalue()

    # -- studying ----------------------------------------------------------

    def due(self, deck: str | None, today: date, new_limit: int = 20, review_limit: int = 200) -> list[Card]:
        """Cards to study today: reviews that are due (most overdue first),
        then up to `new_limit` cards never seen before."""
        where, args = ("deck = ? AND", [deck]) if deck else ("", [])
        reviews = self.db.execute(
            f"SELECT * FROM cards WHERE {where} due IS NOT NULL AND due <= ? ORDER BY due, id LIMIT ?",
            [*args, today.isoformat(), review_limit],
        ).fetchall()
        new = self.db.execute(
            f"SELECT * FROM cards WHERE {where} due IS NULL ORDER BY id LIMIT ?", [*args, new_limit]
        ).fetchall()
        return [_card(r) for r in [*reviews, *new]]

    def grade(self, card: Card, grade: int, today: date) -> Card:
        """Records a review and stores the card's new schedule."""
        new = review(card.schedule, grade, today)
        lapses = card.lapses + (1 if grade < 3 and card.schedule.reps > 0 else 0)
        with self.db:
            self.db.execute(
                "UPDATE cards SET reps = ?, interval = ?, ease = ?, due = ?, lapses = ? WHERE id = ?",
                (new.reps, new.interval, new.ease, new.due.isoformat(), lapses, card.id),
            )
            self.db.execute(
                "INSERT INTO reviews (card_id, day, grade, interval) VALUES (?, ?, ?, ?)",
                (card.id, today.isoformat(), grade, new.interval),
            )
        return Card(card.id, card.deck, card.front, card.back, new, lapses)

    # -- looking around ----------------------------------------------------

    def decks(self, today: date) -> list[dict]:
        rows = self.db.execute(
            """SELECT deck, COUNT(*) AS total,
                      SUM(due IS NULL) AS new,
                      SUM(due IS NOT NULL AND due <= ?) AS due
               FROM cards GROUP BY deck ORDER BY deck""",
            (today.isoformat(),),
        )
        return [dict(r) for r in rows]

    def stats(self, deck: str | None, today: date) -> dict:
        where, args = ("WHERE deck = ?", [deck]) if deck else ("", [])
        c = self.db.execute(
            f"""SELECT COUNT(*) AS total,
                       COALESCE(SUM(due IS NULL), 0) AS new,
                       COALESCE(SUM(due IS NOT NULL AND interval < 21), 0) AS learning,
                       COALESCE(SUM(interval >= 21), 0) AS mature,
                       COALESCE(SUM(due IS NOT NULL AND due <= ?), 0) AS due_today,
                       COALESCE(SUM(lapses), 0) AS lapses,
                       AVG(CASE WHEN due IS NOT NULL THEN ease END) AS avg_ease
                FROM cards {where}""",
            [today.isoformat(), *args],
        ).fetchone()
        since = (today - timedelta(days=29)).isoformat()
        join = "JOIN cards ON cards.id = reviews.card_id" + (" AND cards.deck = ?" if deck else "")
        r = self.db.execute(
            f"""SELECT COUNT(*) AS reviews, COALESCE(SUM(grade >= 3), 0) AS correct,
                       COUNT(DISTINCT day) AS days
                FROM reviews {join} WHERE day >= ?""",
            [*args, since],
        ).fetchone()
        forecast = []
        for d in range(1, 8):
            day = (today + timedelta(days=d)).isoformat()
            n = self.db.execute(f"SELECT COUNT(*) FROM cards {where} {'AND' if deck else 'WHERE'} due = ?",
                                [*args, day]).fetchone()[0]
            forecast.append(n)
        return {
            **dict(c),
            "reviews_30d": r["reviews"],
            "retention_30d": (r["correct"] / r["reviews"]) if r["reviews"] else None,
            "study_days_30d": r["days"],
            "streak": self._streak(today),
            "next_7_days": forecast,
        }

    def _streak(self, today: date) -> int:
        """Consecutive days, ending today or yesterday, with at least one review."""
        days = {row[0] for row in self.db.execute("SELECT DISTINCT day FROM reviews")}
        day = today if today.isoformat() in days else today - timedelta(days=1)
        streak = 0
        while day.isoformat() in days:
            streak += 1
            day -= timedelta(days=1)
        return streak


def _card(row: sqlite3.Row) -> Card:
    due = date.fromisoformat(row["due"]) if row["due"] else None
    return Card(row["id"], row["deck"], row["front"], row["back"],
                Schedule(row["reps"], row["interval"], row["ease"], due), row["lapses"])


def default_db_path() -> Path:
    import os

    return Path(os.environ.get("RECALL_DB") or Path.home() / ".recall.db")

