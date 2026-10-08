"""taskq admin CLI.

  taskq stats  jobs.db
  taskq dead   jobs.db [--limit 20]
  taskq retry-dead jobs.db [--queue emails]
  taskq purge  jobs.db [--days 7]
"""

from __future__ import annotations

import argparse
import datetime as dt

from .store import STATUSES, JobStore


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="taskq", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["stats", "dead", "retry-dead", "purge"])
    ap.add_argument("db")
    ap.add_argument("--queue")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--days", type=float, default=7)
    args = ap.parse_args(argv)
    store = JobStore(args.db)

    if args.command == "stats":
        stats = store.stats()
        print(f"{'queue':<16}" + "".join(f"{s:>10}" for s in STATUSES))
        for q, counts in sorted(stats.items()):
            print(f"{q:<16}" + "".join(f"{counts[s]:>10}" for s in STATUSES))
        if not stats:
            print("(no jobs)")
    elif args.command == "dead":
        for j in store.dead(args.limit):
            when = dt.datetime.fromtimestamp(j.run_at).strftime("%Y-%m-%d %H:%M")
            print(f"#{j.id:<6} {j.task:<24} attempts={j.attempts:<3} {when}  {j.last_error}")
    elif args.command == "retry-dead":
        print(f"requeued {store.retry_dead(args.queue)} job(s)")
    else:
        print(f"purged {store.purge_done(args.days * 86400)} completed job(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
