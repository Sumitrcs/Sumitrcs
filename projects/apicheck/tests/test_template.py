import pytest

from apicheck.template import MissingVariable, render


def test_whole_placeholder_keeps_type():
    assert render("${id}", {"id": 42}) == 42
    assert render({"a": ["${x}"]}, {"x": True}) == {"a": [True]}


def test_inline_placeholder_becomes_string():
    assert render("/users/${id}/posts", {"id": 7}) == "/users/7/posts"
    assert render("Bearer ${token}", {"token": "abc"}) == "Bearer abc"


def test_env(monkeypatch):
    monkeypatch.setenv("API_KEY", "k-123")
    assert render("${env:API_KEY}", {}) == "k-123"
    monkeypatch.delenv("API_KEY")
    with pytest.raises(MissingVariable):
        render("${env:API_KEY}", {})


def test_unknown_variable():
    with pytest.raises(MissingVariable, match="nope"):
        render("x ${nope}", {})


def test_non_strings_untouched():
    assert render(3.5, {}) == 3.5
    assert render(None, {}) is None
