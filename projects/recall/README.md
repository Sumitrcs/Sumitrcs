# recall

[![CI](https://github.com/Sumitrcs/recall/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/recall/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Flashcards in your terminal that **remember for you when to revise**.
Use it for vocabulary, exam facts, formulas or interview questions. Study for ten minutes a day, and `recall` shows each card just before you would forget it.

It uses **SM-2**, the classic spaced-repetition algorithm that tools like Anki grew out of. Cards live in a single SQLite file. Everything uses only Python's standard library, and the core algorithm is about 40 lines you can read in five minutes.

## Quick start

```bash
pip install .                         # gives you the `recall` command

recall import GK gk.csv               # front,back rows (Excel/Sheets CSV works)
recall add GK "Who wrote Godan?" "Munshi Premchand"
recall study GK                        # today's reviews + up to 20 new cards
recall stats
```

A study session looks like this:

```text
$ recall study GK

[1/4 · new] Capital of Rajasthan
  (Enter to show the answer, q to stop)
  → Jaipur
  How well did you know it? 5=perfect 4=good 3=hard 2=almost 1=familiar 0=blank, q=stop: 5
  next review tomorrow

[2/4 · new] Largest planet
  (Enter to show the answer, q to stop)
  → Jupiter
  How well did you know it? 5=perfect 4=good 3=hard 2=almost 1=familiar 0=blank, q=stop: 3

...

[4/4 · again] Largest planet
  (Enter to show the answer, q to stop)
  → Jupiter
  How well did you know it? 5=perfect 4=good 3=hard 2=almost 1=familiar 0=blank, q=stop: 4
  next review tomorrow

Done: 4 cards, 75% remembered.

$ recall stats
Cards        4  (0 new, 4 learning, 0 mature)
Due today    0
Last 30 days 4 reviews on 1 day, 75% remembered
Streak       1 day
Avg ease     2.49
Next 7 days  4 0 0 0 0 0 0
```

Other commands: `recall decks` lists your decks with due and new counts, and `recall export DECK > deck.csv` makes a backup or shares a deck.
Cards are stored in `~/.recall.db`; use `--db file` or `$RECALL_DB` to change that.

## How it works

### The idea: review just before you forget

Memory fades on a curve: fast at first, then slower. And every time you successfully recall something, the curve gets flatter.
So the best time to revise a card is *just before* you'd forget it. Revise too early and you waste time; too late and you have to learn it again.
That's why the gaps between reviews keep getting longer:

```text
grade 4 every time →  1 day, 6 days, 15 days, 38 days, 95 days, 238 days ...
```

Six short reviews keep a fact for most of a year.

### The SM-2 algorithm (`recall/sm2.py`)

Each card stores three numbers: `reps` (correct recalls in a row), `interval` (days until the next review) and `ease` (how easy the card is for you, starting at 2.5).
After you see the answer, you grade yourself from 0 to 5:

```python
def review(card, grade, today):
    if grade < 3:                          # forgotten: start again tomorrow
        return Schedule(reps=0, interval=1, ease=card.ease, due=today + 1 day)

    reps = card.reps + 1
    if reps == 1:   interval = 1           # first success: tomorrow
    elif reps == 2: interval = 6           # second: in six days
    else:           interval = ceil(card.interval * card.ease)   # then keep multiplying

    ease = max(1.3, card.ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)))
    ...
```

The ease formula rewards easy cards and slows down hard ones:

| Grade | 5 | 4 | 3 | 2 | 1 | 0 |
|---|---|---|---|---|---|---|
| Change in ease | +0.10 | 0 | −0.14 | −0.32 | −0.54 | −0.80 |

Ease never drops below 1.3. A card that hard needs rewriting, for example split into two simpler cards, not more drilling.
Like the original description of SM-2, cards you grade below 4 come back **again in the same session** until you know them, but only your first grade of the day changes the schedule.

### Storage (`recall/store.py`)

SQLite is a complete SQL database in one file, and Python includes it. There are two tables:

- `cards` holds the deck, front, back and the three SM-2 numbers, plus the next due date (`NULL` means a new card).
- `reviews` logs every answer: card, day, grade. The stats (retention over 30 days, streak, the upcoming forecast) are plain SQL queries over this log.

`UNIQUE (deck, front)` means importing the same CSV twice doesn't create duplicates.

### Testable by design

Today's date and the input/output functions are *passed in*, never read directly. That lets the tests replay a full study session with scripted answers on a fixed date:

```python
answers = iter(["", "5", "", "2", "", "4"])
study(store, cards, date(2026, 3, 1), ask=lambda prompt: next(answers), show=out.append)
```

## What you'll learn

- Spaced repetition: why it works, and the exact SM-2 rules
- Turning a written algorithm into a small, pure, well-tested function
- SQLite from Python: schemas, `UNIQUE` constraints, transactions (`with db:`) and aggregate queries
- Robust CSV import: delimiter sniffing, header detection, quoted fields, Excel's byte-order mark
- Designing for tests by injecting the clock and I/O
- Packaging a CLI with `argparse` sub-commands and a `pyproject.toml` entry point

## Try it yourself

1. **Reverse cards.** Add `--reverse` to `import`, which also creates back→front cards (good for vocabulary).
2. **Typed answers.** Instead of grading yourself, type the answer and let `recall` grade it, allowing small typos (look up *Levenshtein distance*).
3. **A daily limit.** Cap the total reviews per day and push the overflow to the following days. How should you choose which cards wait?
4. **Better algorithms.** Read about SM-17 and FSRS, which predict forgetting from your own review history, and compare them with SM-2 on the `reviews` log.
5. **Plot the forecast.** Draw the next 30 days of due cards as a bar chart in the terminal with block characters (`▁▂▃▅▇`).

## Run the tests

```bash
pip install -e ".[dev]"
pytest -q          # 15 tests
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
