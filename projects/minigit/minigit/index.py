"""The index (a.k.a. staging area) in Git's real binary format, version 2.

    "DIRC" | version (4 bytes) | entry count (4 bytes)
    entries, each:
        ctime s, ns | mtime s, ns | dev | ino | mode | uid | gid | size  (10 × 4 bytes)
        sha-1 (20 bytes) | flags (2 bytes: name length in the low 12 bits)
        path bytes, then 1-8 NUL bytes so the entry length is a multiple of 8
    SHA-1 of everything above (20 bytes)

Because we write the same format, real `git status` and `git ls-files`
understand an index created by minigit, and the other way round.
"""

from __future__ import annotations

import hashlib
import os
import struct
from dataclasses import dataclass
from pathlib import Path

HEADER = struct.Struct(">4sII")
ENTRY = struct.Struct(">10I20sH")


class IndexFormatError(Exception):
    pass


@dataclass
class IndexEntry:
    path: str  # relative, with forward slashes
    sha: str
    mode: int  # 0o100644 or 0o100755
    size: int
    mtime_s: int = 0
    mtime_ns: int = 0
    ctime_s: int = 0
    ctime_ns: int = 0
    dev: int = 0
    ino: int = 0
    uid: int = 0
    gid: int = 0

    @classmethod
    def from_file(cls, path: str, full: Path, sha: str) -> "IndexEntry":
        st = full.stat()
        mode = 0o100755 if st.st_mode & 0o111 else 0o100644
        return cls(
            path=path, sha=sha, mode=mode, size=st.st_size,
            mtime_s=int(st.st_mtime), mtime_ns=st.st_mtime_ns % 1_000_000_000,
            ctime_s=int(st.st_ctime), ctime_ns=st.st_ctime_ns % 1_000_000_000,
            dev=st.st_dev & 0xFFFFFFFF, ino=st.st_ino & 0xFFFFFFFF,
            uid=getattr(st, "st_uid", 0), gid=getattr(st, "st_gid", 0),
        )

    def matches_stat(self, full: Path) -> bool:
        """Cheap change check: same size and mtime means "probably unchanged" (Git does the same)."""
        try:
            st = full.stat()
        except FileNotFoundError:
            return False
        return st.st_size == self.size and int(st.st_mtime) == self.mtime_s and st.st_mtime_ns % 1_000_000_000 == self.mtime_ns


def read_index(path: Path) -> dict[str, IndexEntry]:
    if not path.exists():
        return {}
    data = path.read_bytes()
    if len(data) < HEADER.size + 20 or hashlib.sha1(data[:-20]).digest() != data[-20:]:
        raise IndexFormatError("index file is corrupt (bad checksum)")
    sig, version, count = HEADER.unpack_from(data, 0)
    if sig != b"DIRC" or version != 2:
        raise IndexFormatError(f"unsupported index (signature {sig!r}, version {version})")

    entries: dict[str, IndexEntry] = {}
    pos = HEADER.size
    for _ in range(count):
        (ctime_s, ctime_ns, mtime_s, mtime_ns, dev, ino, mode, uid, gid, size, sha, flags) = ENTRY.unpack_from(data, pos)
        name_len = flags & 0x0FFF
        start = pos + ENTRY.size
        name = data[start:start + name_len].decode()
        entry_len = ENTRY.size + name_len
        pos += entry_len + (8 - entry_len % 8)  # 1..8 bytes of NUL padding
        entries[name] = IndexEntry(name, sha.hex(), mode, size, mtime_s, mtime_ns, ctime_s, ctime_ns, dev, ino, uid, gid)
    return entries


def write_index(path: Path, entries: dict[str, IndexEntry]) -> None:
    out = bytearray(HEADER.pack(b"DIRC", 2, len(entries)))
    # Git sorts index entries by the raw bytes of the path.
    for name in sorted(entries, key=lambda p: p.encode()):
        e = entries[name]
        encoded = name.encode()
        flags = min(len(encoded), 0x0FFF)
        out += ENTRY.pack(e.ctime_s, e.ctime_ns, e.mtime_s, e.mtime_ns, e.dev, e.ino, e.mode,
                          e.uid, e.gid, e.size, bytes.fromhex(e.sha), flags)
        out += encoded
        entry_len = ENTRY.size + len(encoded)
        out += b"\0" * (8 - entry_len % 8)
    out += hashlib.sha1(out).digest()
    tmp = path.with_name("index.lock")  # same lock-file name Git uses
    tmp.write_bytes(out)
    os.replace(tmp, path)
