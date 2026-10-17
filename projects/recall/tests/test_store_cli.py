from datetime import date, timedelta

import pytest

from recall.cli import main, study
from recall.store import Store, StoreError

D = date(2026, 3, 1)


@pytest.fixture
def store():
    s = Store(":memory:")
    yield s
    s.close()


def test_add_and_duplicates(store):
    assert store.add("Hindi", "पानी", "water", D)
    assert not store.add("Hindi", "पानी", "water (again)", D)  # same front in the same deck
    assert store.add("Marathi", "पानी", "water", D)  # another deck is fine
    with pytest.raises(StoreError):
        store.add("Hindi", " ", "x", D)


def test_import_formats(store):
    assert store.import_csv("Capitals", "front,back\nFrance,Paris\nJapan,Tokyo\n", D) == (2, 0)
    assert store.import_csv("Capitals", "France,Paris\nIndia,New Delhi\n", D) == (1, 1)
    assert store.import_csv("Words", "question;answer\nhola;hello\nadios;bye\n", D) == (2, 0)
    assert store.import_csv("Tabs", "a\tb\nc\td\n", D) == (2, 0)
    assert store.import_csv("Quoted", '"Hello, world",程序\n', D) == (1, 0)
    with pytest.raises(StoreError, match="row 2"):
        store.import_csv("Bad", "ok,fine\nonly-one-column\n", D)


def test_export_round_trip(store):
    store.import_csv("Q", 'front,back\n"a, b","c ""d"""\n', D)
    assert store.export_csv("Q") == 'front,back\n"a, b","c ""d"""\n'


def test_due_order_and_limits(store):
    for i in range(30):
        store.add("D", f"q{i}", f"a{i}", D)
    cards = store.due("D", D, new_limit=5)
    assert [c.front for c in cards] == ["q0", "q1", "q2", "q3", "q4"]
    # Grade two cards; tomorrow they are due before any new cards.
    store.grade(cards[0], 4, D)
    store.grade(cards[1], 4, D)
    tomorrow = store.due("D", D + timedelta(days=1), new_limit=2)
    assert [c.front for c in tomorrow] == ["q0", "q1", "q2", "q3"]
    assert [c.schedule.reps for c in tomorrow] == [1, 1, 0, 0]


def test_lapses_count_only_forgotten_learned_cards(store):
    store.add("D", "x", "y", D)
    card = store.due("D", D)[0]
    card = store.grade(card, 1, D)  # failing a brand-new card isn't a lapse
    assert card.lapses == 0
    card = store.grade(card, 5, D + timedelta(days=1))
    card = store.grade(card, 0, D + timedelta(days=2))
    assert card.lapses == 1


def scripted(answers):
    it = iter(answers)
    out = []
    return (lambda prompt: next(it)), out.append, out


def test_study_session_repeats_cards_below_4(store):
    store.add("D", "2+2", "4", D)
    store.add("D", "capital of India", "New Delhi", D)
    cards = store.due("D", D)
    # Card 1: perfect. Card 2: graded 2 (wrong), comes back, then 4.
    ask, show, out = scripted(["", "5", "", "2", "", "4"])
    counts = study(store, cards, D, ask, show)
    assert counts == {"reviewed": 2, "again": 1, "correct": 1}
    text = "\n".join(out)
    assert "[1/2 · new] 2+2" in text and "[2/2 · again] capital of India" in text
    # Only the first grade counted: the forgotten card is due tomorrow.
    after = {c.front: c for c in store.due("D", D + timedelta(days=1))}
    assert after["capital of India"].schedule.interval == 1
    assert after["2+2"].schedule.reps == 1


def test_study_quit_and_bad_input(store):
    store.add("D", "a", "b", D)
    ask, show, out = scripted(["", "seven", "9", "q"])
    counts = study(store, store.due("D", D), D, ask, show)
    assert counts["reviewed"] == 0
    assert out.count("  Please type a number from 0 to 5.") == 2


def test_stats(store):
    store.import_csv("D", "a,1\nb,2\nc,3\n", D)
    for c in store.due("D", D)[:2]:
        store.grade(c, 5, D)
    s = store.stats("D", D)
    assert (s["total"], s["new"], s["learning"], s["mature"]) == (3, 1, 2, 0)
    assert s["retention_30d"] == 1.0 and s["streak"] == 1
    assert s["next_7_days"] == [2, 0, 0, 0, 0, 0, 0]
    assert store.stats(None, D + timedelta(days=1))["streak"] == 1  # yesterday still counts
    assert store.stats(None, D + timedelta(days=2))["streak"] == 0


def test_cli_end_to_end(tmp_path, capsys):
    db = str(tmp_path / "cards.db")
    csv_file = tmp_path / "gk.csv"
    csv_file.write_text("question,answer\nLargest planet,Jupiter\nSpeed of light,3×10⁸ m/s\n", encoding="utf-8")

    assert main(["--db", db, "import", "GK", str(csv_file)], today=D) == 0
    out = []
    main(["--db", db, "decks"], today=D, show=out.append)
    assert out == ["GK                           2 cards      0 due      2 new"]

    out = []
    answers = iter(["", "5", "", "3", "", "4"])
    main(["--db", db, "study", "GK"], today=D, ask=lambda p: next(answers), show=out.append)
    assert out[-1] == "\nDone: 2 cards, 100% remembered."

    out = []
    main(["--db", db, "study"], today=D, show=out.append)
    assert out == ["Nothing due. Come back tomorrow!"]

    out = []
    main(["--db", db, "stats"], today=D, show=out.append)
    assert out[0] == "Cards        2  (0 new, 2 learning, 0 mature)"

    assert main(["--db", db, "import", "GK", str(tmp_path / "missing.csv")], today=D) == 1
    assert "No such file" in capsys.readouterr().err
