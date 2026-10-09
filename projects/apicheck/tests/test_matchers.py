import pytest

from apicheck.matchers import MISSING, check, get_path

DOC = {"data": {"items": [{"name": "pen", "price": 10}, {"name": "book", "price": 250}], "total": 2}}


def test_get_path():
    assert get_path(DOC, "data.total") == 2
    assert get_path(DOC, "data.items.1.name") == "book"
    assert get_path(DOC, "data.items.-1.price") == 250
    assert get_path(DOC, "$") is DOC


def test_get_path_missing():
    assert get_path(DOC, "data.nope") is MISSING
    assert get_path(DOC, "data.items.9") is MISSING
    assert get_path(DOC, "data.total.x") is MISSING


def test_literal_is_equality():
    assert check(2, 2) == []
    assert check("a", "b") == ["expected 'a', got 'b'"]
    # a dict that isn't made of operators is compared as a whole
    assert check({"name": "pen"}, {"name": "pen"}) == []


@pytest.mark.parametrize("exp,value", [
    ({"gt": 5}, 10),
    ({"gte": 10, "lt": 11}, 10),
    ({"type": "string", "regex": r"^\w+@"}, "asha@example.com"),
    ({"contains": "ash"}, "asha"),
    ({"contains": 3}, [1, 2, 3]),
    ({"len": 2}, [1, 2]),
    ({"in": ["a", "b"]}, "b"),
    ({"ne": None}, 0),
    ({"exists": True}, None),
    ({"exists": False}, MISSING),
    ({"type": "null"}, None),
])
def test_passing_matchers(exp, value):
    assert check(exp, value) == []


@pytest.mark.parametrize("exp,value", [
    ({"gt": 5}, 5),
    ({"gt": 5}, "10"),
    ({"type": "integer"}, True),   # bools are not numbers here
    ({"type": "number"}, "1"),
    ({"regex": "x"}, 5),
    ({"len": 1}, 5),
    ({"exists": True}, MISSING),
    ({"exists": False}, 1),
    ({"eq": 1}, MISSING),
])
def test_failing_matchers(exp, value):
    assert check(exp, value) != []


def test_all_failures_reported():
    assert len(check({"type": "string", "gt": 100}, 5)) == 2


def test_unknown_type_is_an_error():
    with pytest.raises(ValueError):
        check({"type": "float"}, 1.0)
