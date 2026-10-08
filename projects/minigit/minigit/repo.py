"""High-level repository operations built on the object store and index."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

from .index import IndexEntry, read_index, write_index
from .objects import Commit, ObjectStore, TreeEntry, decode_tree, encode_tree, hash_object


class RepoError(Exception):
    pass


@dataclass
class Status:
    branch: str | None
    staged: dict[str, str]  # path -> "new file" | "modified" | "deleted"
    unstaged: dict[str, str]  # path -> "modified" | "deleted"
    untracked: list[str]

    @property
    def clean(self) -> bool:
        return not (self.staged or self.unstaged or self.untracked)


class Repository:
    def __init__(self, worktree: Path):
        self.worktree = worktree.resolve()
        self.git_dir = self.worktree / ".git"
        self.objects = ObjectStore(self.git_dir)
        self.index_path = self.git_dir / "index"

    # -- setup -------------------------------------------------------------
    @classmethod
    def init(cls, path: Path, branch: str = "main") -> "Repository":
        repo = cls(path)
        if repo.git_dir.exists():
            raise RepoError(f"{repo.git_dir} already exists")
        for sub in ("objects", "refs/heads", "refs/tags"):
            (repo.git_dir / sub).mkdir(parents=True)
        (repo.git_dir / "HEAD").write_text(f"ref: refs/heads/{branch}\n")
        (repo.git_dir / "config").write_text(
            "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n"
        )
        return repo

    @classmethod
    def find(cls, start: Path = Path(".")) -> "Repository":
        """Walks up from `start` to the nearest directory that contains .git."""
        cur = start.resolve()
        for d in (cur, *cur.parents):
            if (d / ".git").is_dir():
                return cls(d)
        raise RepoError("not a git repository (or any of the parent directories)")

    # -- refs ----------------------------------------------------------------
    def current_branch(self) -> str | None:
        head = (self.git_dir / "HEAD").read_text().strip()
        return head[len("ref: refs/heads/"):] if head.startswith("ref: refs/heads/") else None

    def head_commit(self) -> str | None:
        head = (self.git_dir / "HEAD").read_text().strip()
        if not head.startswith("ref: "):
            return head  # detached HEAD stores a sha directly
        return self.read_ref(head[5:])

    def read_ref(self, ref: str) -> str | None:
        path = self.git_dir / ref
        if path.exists():
            return path.read_text().strip()
        packed = self.git_dir / "packed-refs"  # real git may pack refs into one file
        if packed.exists():
            for line in packed.read_text().splitlines():
                if line and not line.startswith(("#", "^")):
                    sha, name = line.split(" ", 1)
                    if name == ref:
                        return sha
        return None

    def update_ref(self, ref: str, sha: str) -> None:
        path = self.git_dir / ref
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(sha + "\n")

    def branches(self) -> list[str]:
        heads = self.git_dir / "refs" / "heads"
        return sorted(str(p.relative_to(heads)).replace(os.sep, "/") for p in heads.rglob("*") if p.is_file())

    def resolve(self, name: str) -> str:
        """Turns a branch name, 'HEAD' or a (short) sha into a commit sha."""
        if name == "HEAD":
            sha = self.head_commit()
            if not sha:
                raise RepoError("HEAD does not point to a commit yet")
            return sha
        sha = self.read_ref(f"refs/heads/{name}") or self.read_ref(f"refs/tags/{name}")
        return sha or self.objects.resolve(name)

    # -- working tree helpers ------------------------------------------------
    def rel(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.worktree).as_posix()
        except ValueError:
            raise RepoError(f"{path} is outside the repository") from None

    def iter_files(self):
        for root, dirs, files in os.walk(self.worktree):
            dirs[:] = sorted(d for d in dirs if d != ".git")
            for f in sorted(files):
                yield Path(root) / f

    # -- staging ---------------------------------------------------------------
    def add(self, paths: list[Path]) -> list[str]:
        index = read_index(self.index_path)
        added = []
        for p in paths:
            p = p if p.is_absolute() else Path.cwd() / p
            if p.is_dir():
                base = p.resolve()
                targets = [f for f in self.iter_files() if base in f.resolve().parents]
            elif p.exists():
                targets = [p]
            else:
                # `add` of a deleted file stages the deletion, like git
                rel = self.rel(p)
                if rel in index:
                    del index[rel]
                    added.append(rel)
                    continue
                raise RepoError(f"pathspec '{p}' did not match any files")
            for f in targets:
                rel = self.rel(f)
                sha = self.objects.write(f.read_bytes())
                index[rel] = IndexEntry.from_file(rel, f, sha)
                added.append(rel)
        write_index(self.index_path, index)
        return added

    def write_tree(self) -> str:
        """Builds nested tree objects from the flat list of paths in the index."""
        index = read_index(self.index_path)
        if not index:
            raise RepoError("nothing to commit: the index is empty")

        def build(prefix: str) -> str:
            entries: list[TreeEntry] = []
            subdirs: set[str] = set()
            for path, e in index.items():
                if not path.startswith(prefix):
                    continue
                rest = path[len(prefix):]
                if "/" in rest:
                    subdirs.add(rest.split("/", 1)[0])
                else:
                    entries.append(TreeEntry(f"{e.mode:o}", rest, e.sha))
            for d in subdirs:
                entries.append(TreeEntry("40000", d, build(prefix + d + "/")))
            return self.objects.write(encode_tree(entries), "tree")

        return build("")

    def commit(self, message: str, author: str | None = None, when: int | None = None, tz: str | None = None) -> str:
        if not message.strip():
            raise RepoError("aborting commit due to empty commit message")
        tree = self.write_tree()
        parent = self.head_commit()
        if parent and Commit.decode(self.objects.read(parent)[1]).tree == tree:
            raise RepoError("nothing to commit, working tree clean")
        author = author or os.environ.get("MINIGIT_AUTHOR") or "Your Name <you@example.com>"
        stamp = f"{when if when is not None else int(time.time())} {tz or local_tz_offset()}"
        c = Commit(tree, [parent] if parent else [], f"{author} {stamp}", f"{author} {stamp}", message)
        sha = self.objects.write(c.encode(), "commit")
        branch = self.current_branch()
        if branch:
            self.update_ref(f"refs/heads/{branch}", sha)
        else:
            (self.git_dir / "HEAD").write_text(sha + "\n")
        return sha

    # -- inspection ------------------------------------------------------------
    def log(self, start: str = "HEAD", limit: int | None = None):
        """Yields (sha, Commit) following first parents, newest first."""
        sha: str | None = self.resolve(start)
        count = 0
        while sha and (limit is None or count < limit):
            obj_type, data = self.objects.read(sha)
            if obj_type != "commit":
                raise RepoError(f"{sha} is a {obj_type}, not a commit")
            c = Commit.decode(data)
            yield sha, c
            sha = c.parents[0] if c.parents else None
            count += 1

    def tree_files(self, tree_sha: str, prefix: str = "") -> dict[str, tuple[str, str]]:
        """Flattens a tree into {path: (mode, blob sha)}."""
        out: dict[str, tuple[str, str]] = {}
        for e in decode_tree(self.objects.read(tree_sha)[1]):
            path = prefix + e.name
            if e.is_tree:
                out.update(self.tree_files(e.sha, path + "/"))
            else:
                out[path] = (e.mode, e.sha)
        return out

    def status(self) -> Status:
        index = read_index(self.index_path)
        head = self.head_commit()
        head_files = self.tree_files(Commit.decode(self.objects.read(head)[1]).tree) if head else {}

        staged: dict[str, str] = {}
        for path, e in index.items():
            if path not in head_files:
                staged[path] = "new file"
            elif head_files[path][1] != e.sha:
                staged[path] = "modified"
        for path in head_files:
            if path not in index:
                staged[path] = "deleted"

        unstaged: dict[str, str] = {}
        for path, e in index.items():
            full = self.worktree / path
            if not full.exists():
                unstaged[path] = "deleted"
            elif not e.matches_stat(full) and hash_object(full.read_bytes())[0] != e.sha:
                unstaged[path] = "modified"

        untracked = [r for r in (self.rel(f) for f in self.iter_files()) if r not in index]
        return Status(self.current_branch(), staged, unstaged, untracked)

    # -- branches ---------------------------------------------------------------
    def create_branch(self, name: str, start: str = "HEAD") -> str:
        if self.read_ref(f"refs/heads/{name}"):
            raise RepoError(f"a branch named '{name}' already exists")
        sha = self.resolve(start)
        self.update_ref(f"refs/heads/{name}", sha)
        return sha

    def checkout(self, name: str) -> None:
        """Switches branch, rewriting tracked files. Refuses if there are uncommitted changes."""
        st = self.status()
        if st.staged or st.unstaged:
            raise RepoError("you have uncommitted changes; commit them before switching branches")
        target = self.resolve(name)
        new_files = self.tree_files(Commit.decode(self.objects.read(target)[1]).tree)
        old_index = read_index(self.index_path)

        for path in old_index:
            if path not in new_files:
                (self.worktree / path).unlink(missing_ok=True)
        index: dict[str, IndexEntry] = {}
        for path, (mode, sha) in new_files.items():
            full = self.worktree / path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_bytes(self.objects.read(sha)[1])
            if mode == "100755":
                full.chmod(0o755)
            index[path] = IndexEntry.from_file(path, full, sha)
        write_index(self.index_path, index)
        self._prune_empty_dirs()

        if self.read_ref(f"refs/heads/{name}"):
            (self.git_dir / "HEAD").write_text(f"ref: refs/heads/{name}\n")
        else:
            (self.git_dir / "HEAD").write_text(target + "\n")  # detached

    def _prune_empty_dirs(self) -> None:
        for root, dirs, files in os.walk(self.worktree, topdown=False):
            p = Path(root)
            if p != self.worktree and ".git" not in p.parts and not any(p.iterdir()):
                p.rmdir()


def local_tz_offset() -> str:
    offset = -time.altzone if time.localtime().tm_isdst > 0 else -time.timezone
    sign = "+" if offset >= 0 else "-"
    offset = abs(offset)
    return f"{sign}{offset // 3600:02d}{offset % 3600 // 60:02d}"
