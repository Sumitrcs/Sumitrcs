"""The vault: where backups are stored.

A vault is an ordinary directory:

    vault/
      config.json              chunker settings, format version
      chunks/3f/3fa9...e1      one file per distinct chunk, zlib-compressed,
                               named by the SHA-256 of its *uncompressed* bytes
      snapshots/9c0d1e2f.json  one file per backup: every file's path,
                               metadata and the list of chunks it is made of

A chunk is stored once no matter how many files or snapshots use it. That is
the whole trick: the tenth backup of a folder where one file changed costs
only the chunks of that one file.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import stat
import time
import zlib
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Iterable

from .chunker import Chunker

FORMAT_VERSION = 1


class VaultError(Exception):
    pass


@dataclass
class Entry:
    path: str  # relative to the backed-up folder, with "/" separators
    type: str  # "file", "dir" or "symlink"
    mode: int
    mtime_ns: int
    size: int = 0
    chunks: list[str] = field(default_factory=list)
    target: str = ""  # for symlinks

    @classmethod
    def from_dict(cls, d: dict) -> Entry:
        return cls(**d)


@dataclass
class Snapshot:
    id: str
    time: str  # ISO 8601, UTC
    source: str
    parent: str | None
    entries: list[Entry]

    @property
    def size(self) -> int:
        return sum(e.size for e in self.entries)

    def files(self) -> list[Entry]:
        return [e for e in self.entries if e.type == "file"]

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=1, sort_keys=True)

    @classmethod
    def from_json(cls, text: str) -> Snapshot:
        d = json.loads(text)
        d["entries"] = [Entry.from_dict(e) for e in d["entries"]]
        return cls(**d)


@dataclass
class BackupStats:
    files: int = 0
    dirs: int = 0
    symlinks: int = 0
    new_files: int = 0
    changed_files: int = 0
    unchanged_files: int = 0
    bytes_read: int = 0
    chunks_new: int = 0
    bytes_new: int = 0  # size of the new chunks before compression
    bytes_stored: int = 0  # ...and after
    errors: list[str] = field(default_factory=list)
    seconds: float = 0.0


@dataclass
class Change:
    kind: str  # "+" added, "-" removed, "M" modified
    path: str


def _atomic_write(path: Path, data: bytes) -> None:
    """Write a file so that it is either complete or not there at all.

    The data goes to a temporary file in the same directory, which is then
    renamed over the real name. A rename within one file system is atomic,
    so a crash or power cut can never leave a half-written file behind
    under the real name: at worst a stray temporary file, which prune
    removes."""
    tmp = path.with_name(f".tmp-{os.getpid()}-{path.name}")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def safe_relpath(rel: str) -> PurePosixPath:
    """Check that a path from a snapshot stays inside the restore folder.

    A snapshot is just a JSON file. If someone edits it to contain a path
    like "../../.bashrc" or "/etc/passwd", restoring it must not write
    outside the destination."""
    p = PurePosixPath(rel)
    if not rel or p.is_absolute() or any(part in ("", ".", "..") for part in rel.split("/")):
        raise VaultError(f"unsafe path in snapshot: {rel!r}")
    return p


class Vault:
    def __init__(self, root: str | os.PathLike):
        self.root = Path(root)
        config_file = self.root / "config.json"
        if not config_file.is_file():
            raise VaultError(f"{self.root} is not a vault (create one with: snapvault init {self.root})")
        config = json.loads(config_file.read_text())
        if config.get("version") != FORMAT_VERSION:
            raise VaultError(f"unsupported vault version {config.get('version')}")
        c = config["chunker"]
        self.chunker = Chunker(c["min_size"], c["avg_size"], c["max_size"])

    @classmethod
    def init(cls, root: str | os.PathLike, avg_size: int = 8192) -> Vault:
        root = Path(root)
        if root.exists() and any(root.iterdir()):
            raise VaultError(f"{root} already exists and is not empty")
        chunker = Chunker(avg_size // 4, avg_size, avg_size * 8)
        (root / "chunks").mkdir(parents=True)
        (root / "snapshots").mkdir()
        config = {
            "version": FORMAT_VERSION,
            "chunker": {"min_size": chunker.min_size, "avg_size": chunker.avg_size, "max_size": chunker.max_size},
        }
        _atomic_write(root / "config.json", json.dumps(config, indent=1).encode())
        return cls(root)

    # ---- chunks --------------------------------------------------------

    def chunk_path(self, digest: str) -> Path:
        return self.root / "chunks" / digest[:2] / digest

    def put_chunk(self, data: bytes) -> tuple[str, int]:
        """Store a chunk unless it's already there. Returns its hash and the
        number of bytes written (0 if it was a duplicate)."""
        digest = hashlib.sha256(data).hexdigest()
        path = self.chunk_path(digest)
        if path.exists():
            return digest, 0
        path.parent.mkdir(exist_ok=True)
        packed = zlib.compress(data, 6)
        _atomic_write(path, packed)
        return digest, len(packed)

    def get_chunk(self, digest: str) -> bytes:
        try:
            data = zlib.decompress(self.chunk_path(digest).read_bytes())
        except FileNotFoundError:
            raise VaultError(f"chunk {digest[:12]} is missing") from None
        except zlib.error:
            raise VaultError(f"chunk {digest[:12]} is corrupted (can't decompress)") from None
        if hashlib.sha256(data).hexdigest() != digest:
            raise VaultError(f"chunk {digest[:12]} is corrupted (wrong checksum)")
        return data

    def all_chunks(self) -> Iterable[Path]:
        for sub in sorted((self.root / "chunks").iterdir()):
            if sub.is_dir():
                yield from sorted(sub.iterdir())

    # ---- snapshots -----------------------------------------------------

    def snapshots(self) -> list[Snapshot]:
        snaps = [Snapshot.from_json(p.read_text()) for p in (self.root / "snapshots").glob("*.json")]
        return sorted(snaps, key=lambda s: (s.time, s.id))

    def load(self, ref: str) -> Snapshot:
        """Find a snapshot by id, a unique prefix of its id, or "latest"."""
        snaps = self.snapshots()
        if ref == "latest":
            if not snaps:
                raise VaultError("the vault has no snapshots yet")
            return snaps[-1]
        found = [s for s in snaps if s.id.startswith(ref)]
        if not found or not ref:
            raise VaultError(f"no snapshot {ref!r}")
        if len(found) > 1:
            raise VaultError(f"{ref!r} matches several snapshots: {', '.join(s.id for s in found)}")
        return found[0]

    def _save(self, snap: Snapshot) -> None:
        _atomic_write(self.root / "snapshots" / f"{snap.id}.json", snap.to_json().encode())

    # ---- backup --------------------------------------------------------

    def backup(self, source: str | os.PathLike, exclude: Iterable[str] = (), parent: str | None = "auto"):
        """Back up a folder. Returns (snapshot, stats).

        parent is the snapshot to compare with: files whose size and
        modification time haven't changed since then are not read again.
        "auto" picks the latest snapshot of the same folder; None reads all."""
        started = time.monotonic()
        source = Path(source).resolve()
        if not source.is_dir():
            raise VaultError(f"{source} is not a folder")
        if parent == "auto":
            same = [s for s in self.snapshots() if s.source == str(source)]
            base = same[-1] if same else None
        else:
            base = self.load(parent) if parent else None
        previous = {e.path: e for e in base.entries} if base else {}
        patterns = list(exclude)
        vault_root = self.root.resolve()
        stats = BackupStats()
        entries: list[Entry] = []

        def excluded(rel: str, name: str) -> bool:
            return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(name, p) for p in patterns)

        def walk(folder: Path, prefix: str) -> None:
            try:
                items = sorted(os.scandir(folder), key=lambda d: d.name)
            except OSError as e:
                stats.errors.append(f"{prefix or '.'}: {e.strerror}")
                return
            for item in items:
                rel = f"{prefix}{item.name}"
                if excluded(rel, item.name):
                    continue
                try:
                    st = item.stat(follow_symlinks=False)
                except OSError as e:
                    stats.errors.append(f"{rel}: {e.strerror}")
                    continue
                if stat.S_ISLNK(st.st_mode):
                    stats.symlinks += 1
                    entries.append(Entry(rel, "symlink", st.st_mode, st.st_mtime_ns, target=os.readlink(item.path)))
                elif stat.S_ISDIR(st.st_mode):
                    if Path(item.path).resolve() == vault_root:
                        continue  # never back up the vault into itself
                    stats.dirs += 1
                    entries.append(Entry(rel, "dir", st.st_mode, st.st_mtime_ns))
                    walk(Path(item.path), rel + "/")
                elif stat.S_ISREG(st.st_mode):
                    entry = self._backup_file(Path(item.path), rel, st, previous.get(rel), stats)
                    if entry:
                        entries.append(entry)
                # Sockets, pipes and device files are skipped.

        walk(source, "")
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        snap = Snapshot(id="", time=now, source=str(source), parent=base.id if base else None, entries=entries)
        snap.id = hashlib.sha256(snap.to_json().encode()).hexdigest()[:12]
        # The snapshot is written last. If the backup is interrupted before
        # this line, the vault simply has some unused chunks.
        self._save(snap)
        stats.seconds = time.monotonic() - started
        return snap, stats

    def _backup_file(self, path: Path, rel: str, st: os.stat_result, old: Entry | None, stats: BackupStats):
        stats.files += 1
        if (
            old is not None
            and old.type == "file"
            and old.size == st.st_size
            and old.mtime_ns == st.st_mtime_ns
            and all(self.chunk_path(c).exists() for c in old.chunks)
        ):
            # Same size and modification time as last time: assume the same
            # content, like rsync, restic and git do. Much faster than reading.
            stats.unchanged_files += 1
            return Entry(rel, "file", st.st_mode, st.st_mtime_ns, old.size, list(old.chunks))
        chunks = []
        size = 0
        try:
            with open(path, "rb") as f:
                for data in self.chunker.chunks(f):
                    digest, stored = self.put_chunk(data)
                    chunks.append(digest)
                    size += len(data)
                    if stored:
                        stats.chunks_new += 1
                        stats.bytes_new += len(data)
                        stats.bytes_stored += stored
        except OSError as e:
            stats.files -= 1
            stats.errors.append(f"{rel}: {e.strerror}")
            return None
        stats.bytes_read += size
        if old is None:
            stats.new_files += 1
        else:
            stats.changed_files += 1
        return Entry(rel, "file", st.st_mode, st.st_mtime_ns, size, chunks)

    # ---- restore -------------------------------------------------------

    def restore(self, snap: Snapshot, dest: str | os.PathLike, only: str | None = None) -> int:
        """Recreate a snapshot's files under dest. Returns the number of
        entries restored. only limits it to one file or folder."""
        dest = Path(dest)
        if dest.exists() and (not dest.is_dir() or any(dest.iterdir())):
            raise VaultError(f"{dest} already exists and is not empty")
        only = only.strip("/") if only else None
        chosen = [e for e in snap.entries if not only or e.path == only or e.path.startswith(only + "/")]
        if only and not chosen:
            raise VaultError(f"{only!r} is not in snapshot {snap.id}")
        for e in chosen:
            safe_relpath(e.path)
        dest.mkdir(parents=True, exist_ok=True)
        root = dest.resolve()

        def target(e: Entry) -> Path:
            path = dest / e.path
            # Even with clean paths, a symlink restored earlier could point a
            # parent folder elsewhere. Symlinks are restored last, but check
            # anyway that we're still writing inside dest.
            if not path.parent.resolve().is_relative_to(root):
                raise VaultError(f"refusing to write outside {dest}: {e.path}")
            if e.type != "dir" and os.path.lexists(path):
                raise VaultError(f"snapshot lists {e.path} more than once")
            return path

        dirs = [e for e in chosen if e.type == "dir"]
        for e in dirs:
            target(e).mkdir(parents=True, exist_ok=True)
        for e in chosen:
            if e.type != "file":
                continue
            path = target(e)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "wb") as f:
                for digest in e.chunks:
                    f.write(self.get_chunk(digest))
            os.chmod(path, stat.S_IMODE(e.mode))
            os.utime(path, ns=(e.mtime_ns, e.mtime_ns))
        for e in chosen:
            if e.type == "symlink":
                path = target(e)
                path.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(e.target, path)
                if os.utime in os.supports_follow_symlinks:
                    os.utime(path, ns=(e.mtime_ns, e.mtime_ns), follow_symlinks=False)
        # Folders last, deepest first: creating files inside a folder
        # changes its modification time, so it must be set afterwards.
        for e in sorted(dirs, key=lambda e: e.path.count("/"), reverse=True):
            os.chmod(dest / e.path, stat.S_IMODE(e.mode))
            os.utime(dest / e.path, ns=(e.mtime_ns, e.mtime_ns))
        return len(chosen)

    # ---- comparing, checking, cleaning up --------------------------------

    @staticmethod
    def diff(old: Snapshot, new: Snapshot) -> list[Change]:
        a = {e.path: e for e in old.entries}
        b = {e.path: e for e in new.entries}
        changes = []
        for path in sorted(a.keys() | b.keys()):
            if path not in b:
                changes.append(Change("-", path))
            elif path not in a:
                changes.append(Change("+", path))
            else:
                x, y = a[path], b[path]
                if (x.type, x.chunks, x.target, stat.S_IMODE(x.mode)) != (y.type, y.chunks, y.target, stat.S_IMODE(y.mode)):
                    changes.append(Change("M", path))
        return changes

    def check(self, read_data: bool = False) -> list[str]:
        """Look for problems. With read_data, every chunk is read back and
        its checksum verified, which finds disk corruption too."""
        problems = []
        needed: dict[str, str] = {}  # chunk → one snapshot that uses it
        for snap in self.snapshots():
            for e in snap.entries:
                try:
                    safe_relpath(e.path)
                except VaultError as err:
                    problems.append(f"snapshot {snap.id}: {err}")
                for c in e.chunks:
                    needed.setdefault(c, f"{snap.id}:{e.path}")
        for digest, used_by in sorted(needed.items()):
            if not self.chunk_path(digest).exists():
                problems.append(f"chunk {digest[:12]} is missing (used by {used_by})")
            elif read_data:
                try:
                    self.get_chunk(digest)
                except VaultError as err:
                    problems.append(f"{err} (used by {used_by})")
        return problems

    def forget(self, ids: Iterable[str]) -> list[Snapshot]:
        """Delete snapshots (but not their chunks: see prune)."""
        gone = [self.load(i) for i in ids]
        for snap in gone:
            (self.root / "snapshots" / f"{snap.id}.json").unlink()
        return gone

    def forget_keep_last(self, n: int) -> list[Snapshot]:
        """Keep the newest n snapshots of each source folder."""
        by_source: dict[str, list[Snapshot]] = {}
        for snap in self.snapshots():
            by_source.setdefault(snap.source, []).append(snap)
        old = [s.id for snaps in by_source.values() for s in snaps[: max(0, len(snaps) - n)]]
        return self.forget(old)

    def prune(self) -> tuple[int, int]:
        """Delete chunks no snapshot uses any more. Returns (chunks, bytes)."""
        used = {c for snap in self.snapshots() for e in snap.entries for c in e.chunks}
        removed = freed = 0
        for path in list(self.all_chunks()):
            if path.name not in used:
                freed += path.stat().st_size
                path.unlink()
                removed += 1
        for leftover in self.root.rglob(".tmp-*"):  # from an interrupted write
            leftover.unlink()
        return removed, freed

    def stats(self) -> dict:
        snaps = self.snapshots()
        chunk_files = list(self.all_chunks())
        stored = sum(p.stat().st_size for p in chunk_files)
        logical = sum(s.size for s in snaps)
        return {
            "snapshots": len(snaps),
            "chunks": len(chunk_files),
            "stored_bytes": stored,
            "logical_bytes": logical,  # what all snapshots add up to if restored
            "ratio": logical / stored if stored else 0.0,
        }
