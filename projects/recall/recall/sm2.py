"""The SM-2 spaced-repetition algorithm (Piotr Woźniak, SuperMemo, 1987).

The idea: you forget things on a curve, and each successful recall makes the
memory last longer. So instead of reviewing everything every day, review a
card just before you would forget it. If you remembered it, wait longer next
time; if you didn't, start again.

Each card keeps three numbers:

    reps      how many times in a row you have recalled it correctly
    interval  days until the next review
    ease      how easy the card is for you (2.5 to start, never below 1.3)

After a review you grade yourself from 0 to 5:

    5  perfect, instant          2  wrong, but the answer seemed easy to recall
    4  correct after a pause     1  wrong, the answer rang a bell
    3  correct, but hard         0  complete blackout
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta

START_EASE = 2.5
MIN_EASE = 1.3

GRADES = {
    5: "perfect",
    4: "correct, after a pause",
    3: "correct, with difficulty",
    2: "wrong, but it seemed easy",
    1: "wrong, but familiar",
    0: "no idea",
}


# One word each, for the prompt during a study session.
SHORT_GRADES = {5: "perfect", 4: "good", 3: "hard", 2: "almost", 1: "familiar", 0: "blank"}


@dataclass(frozen=True)
class Schedule:
    reps: int = 0
    interval: int = 0
    ease: float = START_EASE
    due: date | None = None  # None: a new card, never studied


def next_ease(ease: float, grade: int) -> float:
    """The ease factor formula from the original SM-2 description.

    A 5 adds 0.1, a 4 leaves it unchanged, a 3 takes away 0.14; the result
    never drops below 1.3 (cards harder than that need rewriting, not drilling).
    """
    q = grade
    return max(MIN_EASE, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))


def review(card: Schedule, grade: int, today: date) -> Schedule:
    """Applies one graded review and returns the card's new schedule."""
    if grade not in GRADES:
        raise ValueError(f"grade must be 0 to 5, not {grade!r}")

    if grade < 3:
        # Forgotten: start the sequence again from 1 day. Like the original
        # SM-2, the ease factor is left as it was.
        return Schedule(reps=0, interval=1, ease=card.ease, due=today + timedelta(days=1))

    reps = card.reps + 1
    if reps == 1:
        interval = 1
    elif reps == 2:
        interval = 6
    else:
        # Each success multiplies the gap by the ease factor (rounded up).
        interval = math.ceil(card.interval * card.ease)
    return Schedule(reps=reps, interval=interval, ease=round(next_ease(card.ease, grade), 4),
                    due=today + timedelta(days=interval))


def simulate(grades: list[int], start: date) -> list[Schedule]:
    """Reviews a card on each due date with the given grades: handy for
    seeing (and testing) how the intervals grow."""
    card = Schedule()
    day = start
    history = []
    for g in grades:
        card = review(card, g, day)
        history.append(card)
        day = card.due
    return history


def is_mature(card: Schedule) -> bool:
    """Anki's convention: a card is "mature" once its interval reaches 21 days."""
    return card.interval >= 21


__all__ = ["GRADES", "MIN_EASE", "SHORT_GRADES", "START_EASE", "Schedule", "is_mature", "next_ease", "review", "simulate"]
