"""Command-line interface: snapvault <command> ..."""

from __future__ import annotations

import argparse
import sys
from datetime import datetime

from .vault import Snapshot, Vault, VaultError


def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if abs(n) < 1024 or unit == "GiB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    raise AssertionError("unreachable")


def parse_size(text: str) -> int:
    units = {"K": 1024, "M": 1024 * 1024}
    text = text.strip().upper().removesuffix("B").removesuffix("I")
    mult = units.get(text[-1:], 1)
    try:
        return int(text.rstrip("KM")) * mult
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a size: {text!r} (e.g. 8K)") from None


def when(snap: Snapshot) -> str:
    return datetime.fromisoformat(snap.time).astimezone().strftime("%Y-%m-%d %H:%M:%S")


def cmd_init(args) -> int:
    Vault.init(args.vault, avg_size=args.avg_size)
    print(f"created vault {args.vault}")
    return 0


def cmd_backup(args) -> int:
    vault = Vault(args.vault)
    snap, st = vault.backup(args.source, exclude=args.exclude, parent=None if args.full else "auto")
    print(f"snapshot {snap.id} saved" + (f" (compared with {snap.parent})" if snap.parent else ""))
    print(
        f"  files: {st.files:,} ({st.new_files:,} new, {st.changed_files:,} changed, "
        f"{st.unchanged_files:,} unchanged), {st.dirs:,} folders, {st.symlinks:,} symlinks"
    )
    print(f"  read:  {human(st.bytes_read)} of {human(snap.size)}")
    chunks = "chunk" if st.chunks_new == 1 else "chunks"
    print(f"  added: {st.chunks_new:,} new {chunks}, {human(st.bytes_new)} ({human(st.bytes_stored)} compressed)")
    print(f"  time:  {st.seconds:.2f} s")
    for err in st.errors:
        print(f"  skipped {err}", file=sys.stderr)
    return 1 if st.errors else 0


def cmd_snapshots(args) -> int:
    snaps = Vault(args.vault).snapshots()
    if not snaps:
        print("no snapshots yet")
        return 0
    print(f"{'id':<12}  {'time':<19}  {'files':>7}  {'size':>10}  source")
    for s in snaps:
        print(f"{s.id}  {when(s)}  {len(s.files()):>7,}  {human(s.size):>10}  {s.source}")
    return 0


def cmd_ls(args) -> int:
    snap = Vault(args.vault).load(args.snapshot)
    prefix = args.path.strip("/") if args.path else ""
    for e in snap.entries:
        if prefix and e.path != prefix and not e.path.startswith(prefix + "/"):
            continue
        if e.type == "dir":
            print(f"{'':>10}  {e.path}/")
        elif e.type == "symlink":
            print(f"{'':>10}  {e.path} -> {e.target}")
        else:
            print(f"{human(e.size):>10}  {e.path}")
    return 0


def cmd_restore(args) -> int:
    vault = Vault(args.vault)
    snap = vault.load(args.snapshot)
    n = vault.restore(snap, args.dest, only=args.path)
    print(f"restored {n:,} {'entry' if n == 1 else 'entries'} from snapshot {snap.id} to {args.dest}")
    return 0


def cmd_diff(args) -> int:
    vault = Vault(args.vault)
    old, new = vault.load(args.old), vault.load(args.new)
    changes = vault.diff(old, new)
    for c in changes:
        print(f"{c.kind} {c.path}")
    counts = {k: sum(c.kind == k for c in changes) for k in "+-M"}
    print(f"{counts['+']} added, {counts['-']} removed, {counts['M']} modified")
    return 0


def cmd_check(args) -> int:
    vault = Vault(args.vault)
    problems = vault.check(read_data=args.read_data)
    for p in problems:
        print(f"PROBLEM: {p}")
    what = "snapshots and all chunk data" if args.read_data else "snapshots and chunk list"
    if problems:
        print(f"{len(problems)} problem(s) found")
        return 1
    print(f"no problems found ({what} checked)")
    return 0


def cmd_forget(args) -> int:
    vault = Vault(args.vault)
    if args.keep_last is not None:
        gone = vault.forget_keep_last(args.keep_last)
    elif args.snapshots:
        gone = vault.forget(args.snapshots)
    else:
        print("snapvault forget: name snapshots to forget, or use --keep-last N", file=sys.stderr)
        return 2
    for s in gone:
        print(f"forgot snapshot {s.id} ({when(s)})")
    if args.prune:
        return cmd_prune(args)
    if gone:
        print("run 'snapvault prune' to delete chunks that are no longer used")
    return 0


def cmd_prune(args) -> int:
    removed, freed = Vault(args.vault).prune()
    print(f"deleted {removed:,} unused chunks, freed {human(freed)}")
    return 0


def cmd_stats(args) -> int:
    s = Vault(args.vault).stats()
    print(f"snapshots:      {s['snapshots']:,}")
    print(f"chunks:         {s['chunks']:,}")
    print(f"stored on disk: {human(s['stored_bytes'])}")
    print(f"all snapshots:  {human(s['logical_bytes'])} if restored")
    if s["stored_bytes"]:
        print(f"space saving:   {s['ratio']:.1f}x (deduplication + compression)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="snapvault",
        description="Deduplicating backups: each snapshot is complete, but only new data takes space.",
    )
    sub = p.add_subparsers(dest="command", required=True, metavar="command")

    def command(name, func, help):
        c = sub.add_parser(name, help=help, description=help)
        c.set_defaults(func=func)
        c.add_argument("vault", help="the vault folder")
        return c

    c = command("init", cmd_init, "create a new, empty vault")
    c.add_argument("--avg-size", type=parse_size, default=8192, help="target average chunk size (default 8K)")
    c = command("backup", cmd_backup, "back up a folder into a new snapshot")
    c.add_argument("source", help="the folder to back up")
    c.add_argument("--exclude", action="append", default=[], metavar="PATTERN", help="skip matching names or paths, e.g. '*.tmp' or node_modules (repeatable)")
    c.add_argument("--full", action="store_true", help="read every file, even unchanged ones")
    command("snapshots", cmd_snapshots, "list the snapshots")
    c = command("ls", cmd_ls, "list the files in a snapshot")
    c.add_argument("snapshot", help="snapshot id (a unique prefix is enough) or 'latest'")
    c.add_argument("path", nargs="?", help="only this file or folder")
    c = command("restore", cmd_restore, "restore a snapshot into an empty folder")
    c.add_argument("snapshot", help="snapshot id or 'latest'")
    c.add_argument("dest", help="where to restore (must not exist, or be empty)")
    c.add_argument("--path", help="restore only this file or folder")
    c = command("diff", cmd_diff, "show what changed between two snapshots")
    c.add_argument("old")
    c.add_argument("new")
    c = command("check", cmd_check, "verify the vault")
    c.add_argument("--read-data", action="store_true", help="also read and verify every chunk")
    c = command("forget", cmd_forget, "delete snapshots")
    c.add_argument("snapshots", nargs="*", help="snapshot ids")
    c.add_argument("--keep-last", type=int, metavar="N", help="keep only the newest N snapshots of each folder")
    c.add_argument("--prune", action="store_true", help="also delete chunks that are no longer used")
    command("prune", cmd_prune, "delete chunks that no snapshot uses")
    command("stats", cmd_stats, "show storage use and space savings")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except VaultError as e:
        print(f"snapvault: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
