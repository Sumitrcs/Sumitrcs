import json
import xml.etree.ElementTree as ET

import pytest

from apicheck import report
from apicheck.cli import main
from apicheck.runner import SpecError, build_url, load_spec, run

FLOW = {
    "vars": {"password": "hunter2"},
    "tests": [
        {
            "name": "login",
            "method": "POST",
            "path": "/login",
            "json": {"user": "asha", "password": "${password}"},
            "expect": {"status": 200, "json": {"token": {"type": "string"}}},
            "save": {"token": "json:token"},
        },
        {
            "name": "create user",
            "method": "POST",
            "path": "/users",
            "headers": {"Authorization": "Bearer ${token}"},
            "json": {"name": "Ravi", "age": 31},
            "expect": {"status": 201, "headers": {"Location": {"regex": r"^/users/\d+$"}}},
            "save": {"new_id": "json:id", "where": "header:location"},
        },
        {
            "name": "fetch created user",
            "path": "${where}",
            "headers": {"Authorization": "Bearer ${token}"},
            "expect": {"status": 200, "json": {"id": "${new_id}", "name": "Ravi", "age": {"gte": 18}}},
        },
    ],
}


def test_full_flow_with_saved_vars(api):
    results = run(FLOW, base_url=api)
    assert [r.passed for r in results] == [True, True, True], [r.failures or r.error for r in results]


def test_failures_are_collected(api):
    spec = {"tests": [{
        "name": "wrong expectations",
        "path": "/health",
        "expect": {"status": 201, "json": {"ok": False, "version": {"regex": r"^2\."}, "missing": {"exists": True}}},
    }]}
    [r] = run(spec, base_url=api)
    assert not r.passed
    assert len(r.failures) == 4
    assert r.failures[0] == "status: expected 201, got 200"


def test_error_status_is_a_normal_response(api):
    spec = {"tests": [
        {"path": "/users/1", "expect": {"status": 401, "json": {"error": "unauthorized"}}},
        {"method": "POST", "path": "/login", "json": {"password": "x"}, "expect": {"status": [401, 403]}},
    ]}
    assert all(r.passed for r in run(spec, base_url=api))


def test_body_contains_and_non_json(api):
    ok = {"tests": [{"path": "/plain", "expect": {"body_contains": ["hello", "there"]}}]}
    assert run(ok, base_url=api)[0].passed
    bad = {"tests": [{"path": "/plain", "expect": {"json": {"a": 1}}}]}
    [r] = run(bad, base_url=api)
    assert "not JSON" in r.failures[0]


def test_max_ms(api):
    spec = {"tests": [{"path": "/slow", "expect": {"max_ms": 50}}]}
    [r] = run(spec, base_url=api)
    assert r.failures and r.failures[0].startswith("time:")


def test_timeout_is_reported_not_raised(api):
    spec = {"timeout": 0.05, "tests": [{"path": "/slow"}]}
    [r] = run(spec, base_url=api)
    assert r.error and "request failed" in r.error


def test_connection_refused():
    [r] = run({"tests": [{"path": "/"}]}, base_url="http://127.0.0.1:1")
    assert r.error.startswith("request failed")


def test_missing_variable_fails_that_test_only(api):
    spec = {"tests": [{"path": "/users/${nobody}"}, {"path": "/health"}]}
    a, b = run(spec, base_url=api)
    assert a.error == "unknown variable 'nobody'"
    assert b.passed


def test_skip_filter_and_fail_fast(api):
    spec = {"tests": [
        {"name": "first", "path": "/health", "expect": {"status": 500}},
        {"name": "second", "path": "/health", "skip": True},
        {"name": "third", "path": "/health"},
    ]}
    assert len(run(spec, base_url=api, fail_fast=True)) == 1
    [only] = run(spec, base_url=api, only="THIRD")
    assert only.name == "third" and only.passed
    assert run(spec, base_url=api)[1].skipped


def test_query_params(api):
    spec = {"tests": [{"path": "/echo-query", "query": {"q": "gst rate", "page": 2},
                       "expect": {"json": {"query": "q=gst+rate&page=2"}}}]}
    assert run(spec, base_url=api)[0].passed


def test_build_url():
    assert build_url("http://x/api/", "/v1/a", None) == "http://x/api/v1/a"
    assert build_url("http://x", "https://other/y", None) == "https://other/y"
    assert build_url("http://x", "/a?b=1", {"c": 2}) == "http://x/a?b=1&c=2"


def test_load_spec_errors(tmp_path):
    with pytest.raises(SpecError, match="not found"):
        load_spec(tmp_path / "nope.json")
    bad = tmp_path / "bad.json"
    bad.write_text('{"tests": [}')
    with pytest.raises(SpecError, match="line 1"):
        load_spec(bad)
    bad.write_text('{"tests": [{"name": "no path"}]}')
    with pytest.raises(SpecError, match="#1"):
        load_spec(bad)


def test_junit_report(api):
    spec = {"tests": [
        {"name": "ok", "path": "/health"},
        {"name": "bad", "path": "/health", "expect": {"status": 404}},
        {"name": "skipped", "path": "/health", "skip": True},
    ]}
    root = ET.fromstring(report.junit(run(spec, base_url=api)))
    assert root.get("tests") == "3"
    assert root.get("failures") == "1"
    assert root.get("skipped") == "1"
    assert root.find("testcase[@name='bad']/failure").get("message") == "status: expected 404, got 200"


def test_cli_end_to_end(api, tmp_path, capsys):
    spec = tmp_path / "api.json"
    spec.write_text(json.dumps(FLOW))
    xml = tmp_path / "out.xml"
    code = main(["run", str(spec), "--base-url", api, "--junit", str(xml)])
    out = capsys.readouterr().out
    assert code == 0, out
    assert "3 passed" in out
    assert xml.exists()

    assert main(["run", str(spec), "--base-url", api, "--var", "password=wrong", "-q"]) == 1
    assert "FAIL  login" in capsys.readouterr().out


def test_cli_init(tmp_path, capsys):
    target = tmp_path / "api.json"
    assert main(["init", str(target)]) == 0
    load_spec(target)  # starter file must be valid
    assert main(["init", str(target)]) == 1
