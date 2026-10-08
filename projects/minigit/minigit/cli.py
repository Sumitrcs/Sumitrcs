"""Command-line interface mirroring the real git commands it implements."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from .index import IndexFormatError, read_index
from .objects import Commit, ObjectError, decode_tree, hash_object
from .repo import Repository, RepoError


def cmd_init(a):
    repo = Repository.init(Path(a.path), a.branch)
    print(f"Initialized empty minigit repository in {repo.git_dir}")


def cmd_hash_object(a):
    data = Path(a.file).read_bytes()
    if a.write:
        print(Repository.find().objects.write(data, a.type))
    else:
        print(hash_object(data, a.type)[0])


def cmd_cat_file(a):
    repo = Repository.find()
    name, want_tree = a.object, a.object.endswith("^{tree}")
    if want_tree:
        name = name[: -len("^{tree}")]
    sha = repo.resolve(name)
    if want_tree:
        sha = Commit.decode(repo.objects.read(sha)[1]).tree
    obj_type, data = repo.objects.read(sha)
    if a.t:
        print(obj_type)
    elif a.s:
        print(len(data))
    elif obj_type == "tree":
        for e in decode_tree(data):
            kind = "tree" if e.is_tree else "blob"
            print(f"{e.mode.zfill(6)} {kind} {e.sha}\t{e.name}")
    else:
        sys.stdout.buffer.write(data)


def cmd_add(a):
    Repository.find().add([Path(p) for p in a.paths])


def cmd_ls_files(a):
    for path, e in read_index(Repository.find().index_path).items():
        print(f"{e.mode:o} {e.sha} 0\t{path}" if a.stage else path)


def cmd_write_tree(a):
    print(Repository.find().write_tree())


def cmd_commit(a):
    repo = Repository.find()
    sha = repo.commit(a.message, author=a.author)
    branch = repo.current_branch() or "detached HEAD"
    print(f"[{branch} {sha[:7]}] {a.message.splitlines()[0]}")


def cmd_log(a):
    repo = Repository.find()
    for sha, c in repo.log(a.rev, a.n):
        if a.oneline:
            print(f"{sha[:7]} {c.message.splitlines()[0] if c.message else ''}")
            continue
        name, ts, tz = c.author.rsplit(" ", 2)
        when = time.strftime("%a %b %d %H:%M:%S %Y", time.gmtime(int(ts) + _tz_seconds(tz)))
        print(f"commit {sha}\nAuthor: {name}\nDate:   {when} {tz}\n")
        for line in c.message.rstrip("\n").split("\n"):
            print(f"    {line}")
        print()


def _tz_seconds(tz: str) -> int:
    sign = -1 if tz.startswith("-") else 1
    return sign * (int(tz[1:3]) * 3600 + int(tz[3:5]) * 60)


def cmd_status(a):
    st = Repository.find().status()
    print(f"On branch {st.branch}" if st.branch else "HEAD detached")
    if st.staged:
        print("\nChanges to be committed:")
        for p, kind in sorted(st.staged.items()):
            print(f"\t{kind + ':':<12}{p}")
    if st.unstaged:
        print("\nChanges not staged for commit:")
        for p, kind in sorted(st.unstaged.items()):
            print(f"\t{kind + ':':<12}{p}")
    if st.untracked:
        print("\nUntracked files:")
        for p in st.untracked:
            print(f"\t{p}")
    if st.clean:
        print("nothing to commit, working tree clean")


def cmd_branch(a):
    repo = Repository.find()
    if a.name:
        repo.create_branch(a.name)
        return
    current = repo.current_branch()
    for b in repo.branches():
        print(("* " if b == current else "  ") + b)


def cmd_checkout(a):
    repo = Repository.find()
    repo.checkout(a.target)
    print(f"Switched to branch '{a.target}'" if repo.current_branch() == a.target else f"HEAD is now at {a.target}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="minigit", description="A small Git written to show how Git really works.")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="create an empty repository")
    p.add_argument("path", nargs="?", default=".")
    p.add_argument("-b", "--branch", default="main")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("hash-object", help="compute (and optionally store) an object id")
    p.add_argument("file")
    p.add_argument("-w", dest="write", action="store_true")
    p.add_argument("-t", dest="type", default="blob")
    p.set_defaults(func=cmd_hash_object)

    p = sub.add_parser("cat-file", help="show an object")
    g = p.add_mutually_exclusive_group()
    g.add_argument("-t", action="store_true", help="show type")
    g.add_argument("-s", action="store_true", help="show size")
    g.add_argument("-p", action="store_true", help="pretty-print (default)")
    p.add_argument("object")
    p.set_defaults(func=cmd_cat_file)

    p = sub.add_parser("add", help="stage files")
    p.add_argument("paths", nargs="+")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("ls-files", help="list staged files")
    p.add_argument("-s", "--stage", action="store_true")
    p.set_defaults(func=cmd_ls_files)

    sub.add_parser("write-tree", help="write the index as a tree object").set_defaults(func=cmd_write_tree)

    p = sub.add_parser("commit", help="record staged changes")
    p.add_argument("-m", "--message", required=True)
    p.add_argument("--author", help='"Name <email>" (default: $MINIGIT_AUTHOR)')
    p.set_defaults(func=cmd_commit)

    p = sub.add_parser("log", help="show commit history")
    p.add_argument("rev", nargs="?", default="HEAD")
    p.add_argument("-n", type=int)
    p.add_argument("--oneline", action="store_true")
    p.set_defaults(func=cmd_log)

    sub.add_parser("status", help="show the working tree status").set_defaults(func=cmd_status)

    p = sub.add_parser("branch", help="list or create branches")
    p.add_argument("name", nargs="?")
    p.set_defaults(func=cmd_branch)

    p = sub.add_parser("checkout", help="switch branches")
    p.add_argument("target")
    p.set_defaults(func=cmd_checkout)

    args = ap.parse_args(argv)
    try:
        args.func(args)
    except (RepoError, ObjectError, IndexFormatError, FileNotFoundError) as e:
        print(f"minigit: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
