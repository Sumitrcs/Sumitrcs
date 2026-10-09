"""Console output and JUnit XML (Jenkins, GitLab and GitHub Actions all read it)."""

from __future__ import annotations

import os
import sys
import xml.etree.ElementTree as ET

from .runner import Result


def _color() -> bool:
    return sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def paint(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _color() else text


def line(r: Result) -> str:
    if r.skipped:
        return f"  {paint('SKIP', '33')}  {r.name}"
    timing = paint(f"({r.status}, {r.elapsed_ms:.0f}ms)", "2") if r.status else ""
    if r.passed:
        return f"  {paint('PASS', '32')}  {r.name} {timing}"
    out = [f"  {paint('FAIL', '31')}  {r.name} {timing}"]
    if r.error:
        out.append(f"        {r.error}")
    out += [f"        - {f}" for f in r.failures]
    return "\n".join(out)


def summary(results: list[Result]) -> str:
    passed = sum(r.passed for r in results)
    skipped = sum(r.skipped for r in results)
    failed = len(results) - passed - skipped
    total_ms = sum(r.elapsed_ms for r in results)
    parts = [paint(f"{passed} passed", "32")]
    if failed:
        parts.append(paint(f"{failed} failed", "31"))
    if skipped:
        parts.append(paint(f"{skipped} skipped", "33"))
    return f"\n{', '.join(parts)} in {total_ms / 1000:.2f}s"


def junit(results: list[Result], suite: str = "apicheck") -> str:
    failed = sum(bool(r.failures) and not r.error for r in results)
    errors = sum(r.error is not None for r in results)
    root = ET.Element("testsuite", {
        "name": suite,
        "tests": str(len(results)),
        "failures": str(failed),
        "errors": str(errors),
        "skipped": str(sum(r.skipped for r in results)),
        "time": f"{sum(r.elapsed_ms for r in results) / 1000:.3f}",
    })
    for r in results:
        case = ET.SubElement(root, "testcase", {
            "name": r.name, "classname": suite, "time": f"{r.elapsed_ms / 1000:.3f}",
        })
        if r.skipped:
            ET.SubElement(case, "skipped")
        elif r.error:
            ET.SubElement(case, "error", {"message": r.error}).text = f"{r.method} {r.url}\n{r.error}"
        elif r.failures:
            msg = r.failures[0] if len(r.failures) == 1 else f"{len(r.failures)} assertions failed"
            ET.SubElement(case, "failure", {"message": msg}).text = f"{r.method} {r.url}\n" + "\n".join(r.failures)
    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n"
