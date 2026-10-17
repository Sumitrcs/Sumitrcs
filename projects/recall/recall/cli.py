"""Command line: `recall <command>`. Run `recall -h` for help."""

from __future__ import annotations

import argparse
import sys
from collections import deque
from collections.abc import Callable
from datetime import date
from pathlib import Path

from .sm2 import GRADES, SHORT_GRADES
from .store import Card, Store, StoreError, default_db_path


def study(store: Store, cards: list[Card], today: date,
          ask: Callable[[str], str], show: Callable[[str], None]) -> dict:
    """Runs one study session.

    For each card: show the front, wait for Enter, show the back, read a grade.
    Only the first grade of the day changes the schedule. A card graded below 4
    goes to the back of the queue and comes up again until you know it, as the
    original SM-2 description suggests.
    """
    queue = deque(cards)
    graded: set[int] = set()
    counts = {"reviewed": 0, "again": 0, "correct": 0}
    total = len(cards)
    while queue:
        card = queue.popleft()
        again = card.id in graded
        tag = "again" if again else "new" if card.schedule.due is None else "review"
        position = len(graded) + (0 if again else 1)
        show(f"\n[{position}/{total} · {tag}] {card.front}")
        if ask("  (Enter to show the answer, q to stop) ").strip().lower() == "q":
            break
        show(f"  → {card.back}")
        grade = read_grade(ask, show)
        if grade is None:
            break
        if card.id not in graded:
            card = store.grade(card, grade, today)
            graded.add(card.id)
            counts["reviewed"] += 1
            counts["correct"] += grade >= 3
        if grade < 4:
            counts["again"] += 1
            queue.append(card)
        else:
            nxt = "tomorrow" if card.schedule.interval == 1 else f"in {card.schedule.interval} days"
            show(f"  next review {nxt}")
    return counts


def read_grade(ask: Callable[[str], str], show: Callable[[str], None]) -> int | None:
    menu = " ".join(f"{g}={label}" for g, label in sorted(SHORT_GRADES.items(), reverse=True))
    while True:
        answer = ask(f"  How well did you know it? {menu}, q=stop: ").strip().lower()
        if answer == "q":
            return None
        if answer.isdigit() and int(answer) in GRADES:
            return int(answer)
        show("  Please type a number from 0 to 5.")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="recall", description="Spaced-repetition flashcards (SM-2).")
    p.add_argument("--db", type=Path, help=f"database file (default {default_db_path()}, or $RECALL_DB)")
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("add", help="add one card")
    sp.add_argument("deck")
    sp.add_argument("front")
    sp.add_argument("back")

    sp = sub.add_parser("import", help="add cards from a CSV file (front,back)")
    sp.add_argument("deck")
    sp.add_argument("file", type=Path)

    sp = sub.add_parser("export", help="write a deck as CSV to standard output")
    sp.add_argument("deck")

    sp = sub.add_parser("study", help="review the cards that are due")
    sp.add_argument("deck", nargs="?", help="only this deck (default: all)")
    sp.add_argument("--new", type=int, default=20, help="new cards per session (default 20)")

    sub.add_parser("decks", help="list decks with due and new counts")

    sp = sub.add_parser("stats", help="progress: retention, streak, upcoming reviews")
    sp.add_argument("deck", nargs="?")
    return p


def main(argv: list[str] | None = None, today: date | None = None,
         ask: Callable[[str], str] = input, show: Callable[[str], None] = print) -> int:
    args = build_parser().parse_args(argv)
    today = today or date.today()
    store = Store(args.db or default_db_path())
    try:
        return run(args, store, today, ask, show)
    except StoreError as e:
        print(f"recall: {e}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        show("\nStopped. Your progress so far is saved.")
        return 0
    finally:
        store.close()


def run(args: argparse.Namespace, store: Store, today: date, ask, show) -> int:
    if args.command == "add":
        added = store.add(args.deck, args.front, args.back, today)
        show("Added." if added else "That card is already in the deck.")
    elif args.command == "import":
        try:
            text = args.file.read_text(encoding="utf-8-sig")  # -sig: ignore Excel's BOM
        except OSError as e:
            raise StoreError(str(e)) from None
        added, skipped = store.import_csv(args.deck, text, today)
        show(f"Imported {added} card{'s' * (added != 1)} into {args.deck}"
             + (f" ({skipped} already there)" if skipped else "") + ".")
    elif args.command == "export":
        sys.stdout.write(store.export_csv(args.deck))
    elif args.command == "decks":
        rows = store.decks(today)
        if not rows:
            show("No cards yet. Try: recall add Spanish hola hello")
        for r in rows:
            show(f"{r['deck']:<24} {r['total']:>5} cards   {r['due']:>4} due   {r['new']:>4} new")
    elif args.command == "study":
        cards = store.due(args.deck, today, new_limit=args.new)
        if not cards:
            show("Nothing due. Come back tomorrow!")
            return 0
        counts = study(store, cards, today, ask, show)
        if counts["reviewed"]:
            pct = 100 * counts["correct"] / counts["reviewed"]
            show(f"\nDone: {counts['reviewed']} cards, {pct:.0f}% remembered.")
    elif args.command == "stats":
        show_stats(store.stats(args.deck, today), show)
    return 0


def show_stats(s: dict, show: Callable[[str], None]) -> None:
    show(f"Cards        {s['total']}  ({s['new']} new, {s['learning']} learning, {s['mature']} mature)")
    show(f"Due today    {s['due_today']}")
    if s["retention_30d"] is not None:
        days = s["study_days_30d"]
        show(f"Last 30 days {s['reviews_30d']} reviews on {days} day{'s' * (days != 1)}, "
             f"{100 * s['retention_30d']:.0f}% remembered")
    show(f"Streak       {s['streak']} day{'s' * (s['streak'] != 1)}")
    if s["avg_ease"]:
        show(f"Avg ease     {s['avg_ease']:.2f}")
    bars = " ".join(f"{n}" for n in s["next_7_days"])
    show(f"Next 7 days  {bars}")
