from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__, report
from .runner import SpecError, load_spec, run

STARTER = {
    "base_url": "https://httpbin.org",
    "vars": {"name": "sumit"},
    "headers": {"Accept": "application/json"},
    "tests": [
        {
            "name": "server is up",
            "path": "/get",
            "expect": {"status": 200, "max_ms": 3000},
        },
        {
            "name": "echoes the json we send",
            "method": "POST",
            "path": "/post",
            "json": {"user": "${name}", "age": 27},
            "expect": {
                "status": 200,
                "headers": {"content-type": {"contains": "json"}},
                "json": {"json.user": "${name}", "json.age": {"type": "integer", "gte": 18}},
            },
            "save": {"origin": "json:origin"},
        },
    ],
}


def parse_var(s: str) -> tuple[str, str]:
    if "=" not in s:
        raise argparse.ArgumentTypeError(f"expected KEY=VALUE, got {s!r}")
    k, v = s.split("=", 1)
    return k, v


def cmd_run(args) -> int:
    failed_total = 0
    all_results = []
    for spec_path in args.specs:
        try:
            spec = load_spec(spec_path)
        except SpecError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        if len(args.specs) > 1 or not args.quiet:
            print(report.paint(spec_path, "1"))
        try:
            results = run(
                spec,
                base_url=args.base_url,
                extra_vars=dict(args.var),
                only=args.k,
                fail_fast=args.fail_fast,
                on_result=None if args.quiet else lambda r: print(report.line(r), flush=True),
            )
        except SpecError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        if args.quiet:
            for r in results:
                if not r.passed and not r.skipped:
                    print(report.line(r))
        all_results += results
        failed_total += sum(not r.passed and not r.skipped for r in results)
        if failed_total and args.fail_fast:
            break

    print(report.summary(all_results))
    if args.junit:
        Path(args.junit).write_text(report.junit(all_results), encoding="utf-8")
    if not all_results:
        print("no tests matched", file=sys.stderr)
        return 2
    return 1 if failed_total else 0


def cmd_init(args) -> int:
    p = Path(args.file)
    if p.exists() and not args.force:
        print(f"{p} already exists (use --force to overwrite)", file=sys.stderr)
        return 1
    p.write_text(json.dumps(STARTER, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {p} - run it with: apicheck run {p}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="apicheck", description="API tests as plain JSON files.")
    ap.add_argument("--version", action="version", version=f"apicheck {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="run one or more spec files")
    r.add_argument("specs", nargs="+", metavar="SPEC")
    r.add_argument("--base-url", help="override base_url from the spec (e.g. staging vs prod)")
    r.add_argument("--var", action="append", type=parse_var, default=[], metavar="KEY=VALUE")
    r.add_argument("-k", metavar="TEXT", help="only run tests whose name contains TEXT")
    r.add_argument("-x", "--fail-fast", action="store_true", help="stop at the first failure")
    r.add_argument("-q", "--quiet", action="store_true", help="only print failures and the summary")
    r.add_argument("--junit", metavar="FILE", help="write a JUnit XML report")
    r.set_defaults(func=cmd_run)

    i = sub.add_parser("init", help="write a starter spec file")
    i.add_argument("file", nargs="?", default="api.json")
    i.add_argument("--force", action="store_true")
    i.set_defaults(func=cmd_init)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
