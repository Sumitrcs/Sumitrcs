from datetime import date, timedelta

import pytest

from recall.sm2 import MIN_EASE, Schedule, next_ease, review, simulate

D = date(2026, 1, 1)


def intervals(grades):
    return [c.interval for c in simulate(grades, D)]


def test_ease_formula():
    # From the SM-2 description: 5 → +0.10, 4 → 0, 3 → −0.14, 2 → −0.32, 1 → −0.54, 0 → −0.80
    for grade, change in [(5, 0.10), (4, 0.0), (3, -0.14), (2, -0.32), (1, -0.54), (0, -0.80)]:
        assert next_ease(2.5, grade) == pytest.approx(2.5 + change)
    assert next_ease(1.4, 0) == MIN_EASE


def test_interval_sequence():
    # 1 day, 6 days, then multiply by the ease factor (rounded up).
    assert intervals([4, 4, 4, 4, 4]) == [1, 6, 15, 38, 95]  # 6×2.5, 15×2.5=37.5→38, 38×2.5
    assert intervals([5, 5, 5, 5, 5]) == [1, 6, 17, 48, 140]  # ease grows 2.6, 2.7, 2.8 ...
    assert intervals([3, 3, 3, 3]) == [1, 6, 14, 30]  # ease shrinks with each hard recall


def test_forgetting_starts_over_but_keeps_ease():
    history = simulate([5, 5, 5, 1], D)
    lapsed = history[-1]
    assert (lapsed.reps, lapsed.interval) == (0, 1)
    assert lapsed.ease == history[-2].ease
    assert intervals([5, 5, 5, 1, 4, 4]) == [1, 6, 17, 1, 1, 6]


def test_due_dates_follow_intervals():
    card = review(Schedule(), 4, D)
    assert card.due == D + timedelta(days=1)
    card = review(card, 4, card.due)
    assert card.due == D + timedelta(days=7)


def test_bad_grade():
    for bad in (-1, 6, 3.5, "4"):
        with pytest.raises(ValueError):
            review(Schedule(), bad, D)


def test_ease_never_falls_below_minimum():
    card = Schedule()
    for _ in range(20):
        card = review(card, 3, D)
    assert card.ease == MIN_EASE
