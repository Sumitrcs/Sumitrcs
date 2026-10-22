import json
import os
from pathlib import Path

import pytest

from conftest import tree, write
from snapvault import Vault, VaultError


@pytest.fixture
def vault(tmp_path: Path) -> Vault:
    return Vault.init(tmp_path / "vault")


def test_backup_and_restore_round_trip(vault, source, tmp_path):
    snap, stats = vault.backup(source)
    assert (stats.files, stats.dirs, stats.symlinks) == (7, 3, 1)
    assert stats.new_files == 7 and not stats.errors
    n = vault.restore(vault.load(snap.id), tmp_path / "out")
    assert n == 11
    restored, original = tree(tmp_path / "out"), tree(source)
    assert restored == original  # contents, modes, file mtimes, symlinks, empty folders
    for rel in ("photos", "code", "empty-folder"):
        assert (tmp_path / "out" / rel).stat().st_mtime_ns == (source / rel).stat().st_mtime_ns


def test_identical_content_is_stored_once(vault, source):
    _, stats = vault.backup(source)
    photo = 150_000
    assert stats.bytes_read > 2 * photo
    assert stats.bytes_new < stats.bytes_read - photo + 1  # the copy added nothing
    assert vault.stats()["stored_bytes"] < stats.bytes_read - photo


def test_second_backup_skips_unchanged_files(vault, source):
    first, _ = vault.backup(source)
    second, stats = vault.backup(source)
    assert second.parent == first.id
    assert (stats.unchanged_files, stats.changed_files, stats.new_files) == (7, 0, 0)
    assert stats.bytes_read == 0 and stats.chunks_new == 0
    assert [e.chunks for e in second.files()] == [e.chunks for e in first.files()]


def test_a_small_edit_stores_only_a_little(vault, source):
    vault.backup(source)
    data = bytearray((source / "photos" / "goa.jpg").read_bytes())
    data[70_000:70_010] = b"edited...."
    write(source / "photos" / "goa.jpg", bytes(data), mtime=1_700_000_000)
    _, stats = vault.backup(source)
    assert stats.changed_files == 1
    assert stats.bytes_read == len(data)
    assert stats.chunks_new <= 2 and stats.bytes_new < 20_000, stats


def test_new_deleted_and_changed_files_show_in_diff(vault, source):
    old, _ = vault.backup(source)
    (source / "notes.txt").write_text("remember the eggs\n")
    os.utime(source / "notes.txt", (1, 1))
    (source / "empty.txt").unlink()
    write(source / "new.txt", "new")
    (source / "code" / "run.sh").chmod(0o644)
    new, stats = vault.backup(source)
    # chmod doesn't change the modification time, so run.sh isn't re-read,
    # but its new mode is still recorded.
    assert (stats.new_files, stats.changed_files, stats.unchanged_files) == (1, 1, 5)
    changes = [(c.kind, c.path) for c in Vault.diff(old, new)]
    assert changes == [("M", "code/run.sh"), ("-", "empty.txt"), ("+", "new.txt"), ("M", "notes.txt")]


def test_same_size_and_mtime_is_trusted(vault, source):
    # Like rsync and restic, a file with the same size and modification time
    # is assumed unchanged. --full (parent=None) reads everything.
    vault.backup(source)
    st = (source / "notes.txt").stat()
    (source / "notes.txt").write_text("remember the salt\n")  # same length
    os.utime(source / "notes.txt", ns=(st.st_atime_ns, st.st_mtime_ns))
    _, quick = vault.backup(source)
    assert quick.changed_files == 0
    snap, full = vault.backup(source, parent=None)
    assert full.new_files == 7
    out = source.parent / "check"
    vault.restore(snap, out, only="notes.txt")
    assert (out / "notes.txt").read_text() == "remember the salt\n"


def test_exclude_patterns(vault, source):
    snap, _ = vault.backup(source, exclude=["*.jpg", "code"])
    paths = {e.path for e in snap.entries}
    assert "photos" in paths and "photos/goa.jpg" not in paths
    assert not any(p.startswith("code") for p in paths)


def test_a_vault_inside_the_source_is_not_backed_up(source):
    vault = Vault.init(source / "backups")
    snap, _ = vault.backup(source)
    assert not any(e.path.startswith("backups") for e in snap.entries)


def test_restore_one_file_or_folder(vault, source, tmp_path):
    snap, _ = vault.backup(source)
    vault.restore(snap, tmp_path / "a", only="photos")
    assert sorted(p.name for p in (tmp_path / "a").rglob("*")) == ["copy-of-goa.jpg", "goa.jpg", "photos"]
    vault.restore(snap, tmp_path / "b", only="/code/main.py")
    assert (tmp_path / "b" / "code" / "main.py").read_text().startswith("print")
    with pytest.raises(VaultError, match="not in snapshot"):
        vault.restore(snap, tmp_path / "c", only="nope")


def test_restore_refuses_a_non_empty_destination(vault, source, tmp_path):
    snap, _ = vault.backup(source)
    write(tmp_path / "busy" / "x", "x")
    with pytest.raises(VaultError, match="not empty"):
        vault.restore(snap, tmp_path / "busy")


@pytest.mark.parametrize("bad", ["../escape.txt", "/etc/evil", "a/../../b", "a//b", "./x"])
def test_restore_refuses_paths_outside_the_destination(vault, source, tmp_path, bad):
    snap, _ = vault.backup(source)
    path = vault.root / "snapshots" / f"{snap.id}.json"
    data = json.loads(path.read_text())
    data["entries"][0]["path"] = bad
    path.write_text(json.dumps(data))
    with pytest.raises(VaultError, match="unsafe path"):
        vault.restore(vault.load(snap.id), tmp_path / "out")
    assert not (tmp_path / "escape.txt").exists()
    assert any("unsafe path" in p for p in vault.check())


def test_restore_never_writes_through_a_symlink(vault, tmp_path):
    # A tampered snapshot: "dir" is a symlink pointing outside, and a file
    # is listed under it. The file must not end up outside the destination.
    src = tmp_path / "s"
    write(src / "dir" / "f.txt", "data")
    snap, _ = vault.backup(src)
    path = vault.root / "snapshots" / f"{snap.id}.json"
    data = json.loads(path.read_text())
    outside = tmp_path / "outside"
    outside.mkdir()
    data["entries"] = [
        {"path": "dir", "type": "symlink", "mode": 0o120777, "mtime_ns": 0, "size": 0, "chunks": [], "target": str(outside)},
        dict(data["entries"][1]),
    ]
    data["entries"][0], data["entries"][1] = data["entries"][1], data["entries"][0]
    path.write_text(json.dumps(data))
    try:
        vault.restore(vault.load(snap.id), tmp_path / "out")
    except VaultError:
        pass
    assert list(outside.iterdir()) == []


def test_check_finds_missing_and_corrupted_chunks(vault, source):
    snap, _ = vault.backup(source)
    assert vault.check(read_data=True) == []
    chunks = sorted(vault.all_chunks())
    chunks[0].unlink()
    packed = bytearray(chunks[1].read_bytes())
    packed[-5] ^= 0xFF
    chunks[1].write_bytes(bytes(packed))
    quick = vault.check()
    assert len(quick) == 1 and "missing" in quick[0]
    deep = vault.check(read_data=True)
    assert len(deep) == 2 and "corrupted" in deep[1]


def test_a_corrupted_chunk_is_never_restored_silently(vault, source, tmp_path):
    snap, _ = vault.backup(source)
    digest = snap.files()[0].chunks[0]  # code/main.py
    import zlib

    vault.chunk_path(digest).write_bytes(zlib.compress(b"something else"))
    with pytest.raises(VaultError, match="wrong checksum"):
        vault.restore(snap, tmp_path / "out")


def test_forget_and_prune(vault, source):
    first, _ = vault.backup(source)
    (source / "photos" / "goa.jpg").unlink()
    (source / "photos" / "copy-of-goa.jpg").unlink()
    second, _ = vault.backup(source)
    before = vault.stats()
    assert vault.prune() == (0, 0)  # everything is still used by the first snapshot
    gone = vault.forget_keep_last(1)
    assert [s.id for s in gone] == [first.id]
    removed, freed = vault.prune()
    assert removed > 10 and freed > 100_000
    assert vault.stats()["chunks"] == before["chunks"] - removed
    assert vault.check(read_data=True) == []
    assert [s.id for s in vault.snapshots()] == [second.id]


def test_an_interrupted_backup_leaves_a_consistent_vault(vault, source, monkeypatch):
    vault.backup(source)
    write(source / "big.bin", os.urandom(300_000))
    calls = 0
    real_put = Vault.put_chunk

    def failing_put(self, data):
        nonlocal calls
        calls += 1
        if calls == 10:
            raise KeyboardInterrupt
        return real_put(self, data)

    monkeypatch.setattr(Vault, "put_chunk", failing_put)
    with pytest.raises(KeyboardInterrupt):
        vault.backup(source)
    monkeypatch.undo()
    assert len(vault.snapshots()) == 1  # the unfinished snapshot was never written
    assert vault.check(read_data=True) == []
    removed, _ = vault.prune()  # the chunks it did write are cleaned up
    assert removed == 9
    snap, stats = vault.backup(source)
    assert stats.new_files == 1


def test_snapshot_lookup(vault, source):
    a, _ = vault.backup(source)
    assert vault.load(a.id[:4]).id == a.id
    assert vault.load("latest").id == a.id
    with pytest.raises(VaultError, match="no snapshot"):
        vault.load("zzzz")
    with pytest.raises(VaultError, match="no snapshot"):
        vault.load("")


def test_not_a_vault(tmp_path):
    with pytest.raises(VaultError, match="not a vault"):
        Vault(tmp_path)
    write(tmp_path / "x" / "file", "x")
    with pytest.raises(VaultError, match="not empty"):
        Vault.init(tmp_path / "x")
