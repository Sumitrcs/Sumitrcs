"""Git's object database: blobs, trees and commits stored as zlib-compressed
files under .git/objects/<first 2 hex chars>/<remaining 38>.

Every object is stored as   b"<type> <size>\\0" + content
and its name is the SHA-1 of exactly those bytes. That's the whole trick
behind Git: identical content always gets the same name.
"""

from __future__ import annotations

import hashlib
import zlib
from dataclasses import dataclass, field
from pathlib import Path

OBJECT_TYPES = ("blob", "tree", "commit", "tag")


class ObjectError(Exception):
    pass


def hash_object(data: bytes, obj_type: str = "blob") -> tuple[str, bytes]:
    """Returns (sha1 hex, full raw object) without writing anything."""
    if obj_type not in OBJECT_TYPES:
        raise ObjectError(f"unknown object type {obj_type!r}")
    raw = f"{obj_type} {len(data)}".encode() + b"\0" + data
    return hashlib.sha1(raw).hexdigest(), raw


class ObjectStore:
    def __init__(self, git_dir: Path):
        self.root = git_dir / "objects"

    def path_for(self, sha: str) -> Path:
        return self.root / sha[:2] / sha[2:]

    def write(self, data: bytes, obj_type: str = "blob") -> str:
        sha, raw = hash_object(data, obj_type)
        path = self.path_for(sha)
        if not path.exists():  # objects are immutable, so writing twice is pointless
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(zlib.compress(raw))
            tmp.replace(path)
        return sha

    def read(self, sha: str) -> tuple[str, bytes]:
        """Returns (type, content). Accepts an abbreviated sha of 4+ characters."""
        sha = self.resolve(sha)
        raw = zlib.decompress(self.path_for(sha).read_bytes())
        header, _, content = raw.partition(b"\0")
        obj_type, size = header.decode().split(" ")
        if int(size) != len(content):
            raise ObjectError(f"object {sha} is corrupt: size mismatch")
        return obj_type, content

    def resolve(self, prefix: str) -> str:
        prefix = prefix.lower()
        if len(prefix) == 40 and self.path_for(prefix).exists():
            return prefix
        if len(prefix) < 4:
            raise ObjectError("object name too short (need at least 4 characters)")
        folder = self.root / prefix[:2]
        matches = [prefix[:2] + p.name for p in folder.glob(prefix[2:] + "*")] if folder.is_dir() else []
        if not matches:
            raise ObjectError(f"no object named {prefix}")
        if len(matches) > 1:
            raise ObjectError(f"object name {prefix} is ambiguous")
        return matches[0]


# ---------------------------------------------------------------------------
# Trees: a directory listing. Each entry is
#   b"<mode> <name>\0" + 20 raw bytes of the child's sha
# Entries are sorted by name, with directories compared as if they ended in "/".


@dataclass(frozen=True)
class TreeEntry:
    mode: str  # "100644" file, "100755" executable, "40000" directory
    name: str
    sha: str

    @property
    def is_tree(self) -> bool:
        return self.mode == "40000"

    def sort_key(self) -> bytes:
        return self.name.encode() + (b"/" if self.is_tree else b"")


def encode_tree(entries: list[TreeEntry]) -> bytes:
    out = bytearray()
    for e in sorted(entries, key=TreeEntry.sort_key):
        out += f"{e.mode} {e.name}".encode() + b"\0" + bytes.fromhex(e.sha)
    return bytes(out)


def decode_tree(data: bytes) -> list[TreeEntry]:
    entries, i = [], 0
    while i < len(data):
        space = data.index(b" ", i)
        nul = data.index(b"\0", space)
        mode = data[i:space].decode()
        name = data[space + 1:nul].decode()
        sha = data[nul + 1:nul + 21].hex()
        entries.append(TreeEntry(mode, name, sha))
        i = nul + 21
    return entries


# ---------------------------------------------------------------------------
# Commits: plain text headers, a blank line, then the message.


@dataclass
class Commit:
    tree: str
    parents: list[str]
    author: str  # "Name <email> 1700000000 +0530"
    committer: str
    message: str
    extra: dict[str, str] = field(default_factory=dict)

    def encode(self) -> bytes:
        lines = [f"tree {self.tree}"]
        lines += [f"parent {p}" for p in self.parents]
        lines += [f"author {self.author}", f"committer {self.committer}"]
        msg = self.message if self.message.endswith("\n") else self.message + "\n"
        return ("\n".join(lines) + "\n\n" + msg).encode()

    @classmethod
    def decode(cls, data: bytes) -> "Commit":
        head, _, message = data.decode().partition("\n\n")
        tree, parents, author, committer, extra = "", [], "", "", {}
        for line in head.split("\n"):
            key, _, value = line.partition(" ")
            if key == "tree":
                tree = value
            elif key == "parent":
                parents.append(value)
            elif key == "author":
                author = value
            elif key == "committer":
                committer = value
            else:
                extra[key] = value  # e.g. gpgsig — kept so we don't lose information
        return cls(tree, parents, author, committer, message, extra)
