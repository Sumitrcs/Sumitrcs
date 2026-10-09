"""Runs the tests in a spec file, one after another.

Tests run in order because later tests usually need something from earlier
ones (login -> token -> create -> fetch). Use "save" to keep a value around.
"""

from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import matchers
from .template import MissingVariable, render

DEFAULT_TIMEOUT = 10.0


class SpecError(Exception):
    pass


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: bytes
    elapsed_ms: float

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return json.loads(self.body)


@dataclass
class Result:
    name: str
    method: str
    url: str
    failures: list[str] = field(default_factory=list)
    error: str | None = None
    skipped: bool = False
    status: int | None = None
    elapsed_ms: float = 0.0

    @property
    def passed(self) -> bool:
        return not self.failures and self.error is None and not self.skipped


def load_spec(path: str | Path) -> dict:
    try:
        spec = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SpecError(f"{path}: file not found") from None
    except json.JSONDecodeError as e:
        raise SpecError(f"{path}: invalid JSON at line {e.lineno}: {e.msg}") from None
    if not isinstance(spec, dict) or not isinstance(spec.get("tests"), list):
        raise SpecError(f"{path}: expected an object with a \"tests\" list")
    for i, t in enumerate(spec["tests"]):
        if not isinstance(t, dict) or "path" not in t and "url" not in t:
            raise SpecError(f"{path}: test #{i + 1} needs a \"path\" or \"url\"")
    return spec


def send(method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> Response:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            status, hdrs = r.status, r.headers
    except urllib.error.HTTPError as e:
        # 4xx/5xx are still responses, and often exactly what we're testing for
        data = e.read()
        status, hdrs = e.code, e.headers
    elapsed = (time.perf_counter() - start) * 1000
    return Response(status, {k.lower(): v for k, v in hdrs.items()}, data, elapsed)


def build_url(base: str, path: str, query: dict | None) -> str:
    if path.startswith(("http://", "https://")):
        url = path
    else:
        url = base.rstrip("/") + "/" + path.lstrip("/")
    if query:
        sep = "&" if "?" in url else "?"
        url += sep + urllib.parse.urlencode(query, doseq=True)
    return url


def evaluate(expect: dict, resp: Response) -> list[str]:
    fails: list[str] = []

    if "status" in expect:
        want = expect["status"]
        ok = resp.status in want if isinstance(want, list) else resp.status == want
        if not ok:
            fails.append(f"status: expected {want}, got {resp.status}")

    for name, exp in expect.get("headers", {}).items():
        got = resp.headers.get(name.lower(), matchers.MISSING)
        fails += [f"header {name}: {r}" for r in matchers.check(exp, got)]

    if "body_contains" in expect:
        needles = expect["body_contains"]
        for n in [needles] if isinstance(needles, str) else needles:
            if n not in resp.text:
                fails.append(f"body: does not contain {n!r}")

    if "json" in expect:
        try:
            doc = resp.json()
        except ValueError:
            fails.append(f"json: response is not JSON (starts with {resp.text[:40]!r})")
        else:
            for path, exp in expect["json"].items():
                got = matchers.get_path(doc, path)
                fails += [f"json {path}: {r}" for r in matchers.check(exp, got)]

    if "max_ms" in expect and resp.elapsed_ms > expect["max_ms"]:
        fails.append(f"time: took {resp.elapsed_ms:.0f}ms, limit is {expect['max_ms']}ms")

    return fails


def extract(save: dict[str, str], resp: Response) -> dict[str, Any]:
    """save: {"token": "json:data.token", "loc": "header:location", "code": "status"}"""
    out = {}
    for var, source in save.items():
        kind, _, where = source.partition(":")
        if kind == "json":
            value = matchers.get_path(resp.json(), where)
        elif kind == "header":
            value = resp.headers.get(where.lower(), matchers.MISSING)
        elif kind == "status":
            value = resp.status
        elif kind == "body":
            value = resp.text
        else:
            raise SpecError(f"save {var}: unknown source {source!r} (use json:, header:, status or body)")
        if value is matchers.MISSING:
            raise SpecError(f"save {var}: {source} not found in response")
        out[var] = value
    return out


def run_test(test: dict, variables: dict, base_url: str, defaults: dict) -> tuple[Result, dict]:
    name = test.get("name") or f"{test.get('method', 'GET')} {test.get('path', test.get('url'))}"
    try:
        t = render(test, variables)
    except MissingVariable as e:
        return Result(name, test.get("method", "GET"), "", error=str(e.args[0])), {}

    method = t.get("method", "GET").upper()
    url = build_url(base_url, t.get("url") or t["path"], t.get("query"))
    result = Result(name, method, url)

    if t.get("skip"):
        result.skipped = True
        return result, {}

    headers = {**defaults.get("headers", {}), **t.get("headers", {})}
    body = None
    if "json" in t:
        body = json.dumps(t["json"]).encode()
        headers.setdefault("Content-Type", "application/json")
    elif "form" in t:
        body = urllib.parse.urlencode(t["form"]).encode()
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    elif "body" in t:
        body = str(t["body"]).encode()
    headers.setdefault("User-Agent", "apicheck")

    timeout = t.get("timeout", defaults.get("timeout", DEFAULT_TIMEOUT))
    try:
        resp = send(method, url, headers, body, timeout)
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
        reason = getattr(e, "reason", e)
        result.error = f"request failed: {reason}"
        return result, {}

    result.status = resp.status
    result.elapsed_ms = resp.elapsed_ms
    result.failures = evaluate(t.get("expect", {}), resp)

    saved = {}
    if not result.failures and t.get("save"):
        try:
            saved = extract(t["save"], resp)
        except (SpecError, ValueError) as e:
            result.error = str(e)
    return result, saved


def run(spec: dict, base_url: str | None = None, extra_vars: dict | None = None,
        only: str | None = None, fail_fast: bool = False, on_result=None) -> list[Result]:
    variables = {**spec.get("vars", {}), **(extra_vars or {})}
    base = base_url or spec.get("base_url", "")
    try:
        base = render(base, variables)
    except MissingVariable as e:
        raise SpecError(f"base_url: {e.args[0]}") from None
    defaults = {k: spec[k] for k in ("headers", "timeout") if k in spec}

    results = []
    for test in spec["tests"]:
        name = test.get("name", "")
        if only and only.lower() not in name.lower():
            continue
        result, saved = run_test(test, variables, base, defaults)
        variables.update(saved)
        results.append(result)
        if on_result:
            on_result(result)
        if fail_fast and not result.passed and not result.skipped:
            break
    return results
