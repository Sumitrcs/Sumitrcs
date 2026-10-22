import re

from conftest import write
from snapvault.cli import human, main, parse_size


def run(capsys, *args):
    code = main([str(a) for a in args])
    out = capsys.readouterr()
    return code, out.out, out.err


def test_a_full_session(capsys, tmp_path, source):
    vault = tmp_path / "vault"
    assert run(capsys, "init", vault)[0] == 0
    code, out, _ = run(capsys, "backup", vault, source)
    assert code == 0
    first = re.search(r"snapshot (\w+) saved", out).group(1)
    assert "files: 7 (7 new, 0 changed, 0 unchanged), 3 folders, 1 symlinks" in out

    write(source / "notes.txt", "changed!", mtime=1_000)
    code, out, _ = run(capsys, "backup", vault, source)
    second = re.search(r"snapshot (\w+) saved \(compared with (\w+)\)", out)
    assert second.group(2) == first
    assert "1 changed, 6 unchanged" in out
    assert "added: 1 new chunk," in out

    code, out, _ = run(capsys, "snapshots", vault)
    assert first in out and second.group(1) in out

    code, out, _ = run(capsys, "diff", vault, first, "latest")
    assert out.splitlines() == ["M notes.txt", "0 added, 0 removed, 1 modified"]

    code, out, _ = run(capsys, "ls", vault, "latest", "photos")
    assert "146.5 KiB  photos/goa.jpg" in out and "notes" not in out

    code, out, _ = run(capsys, "restore", vault, first[:5], tmp_path / "old")
    assert code == 0 and (tmp_path / "old" / "notes.txt").read_text() == "remember the milk\n"

    code, out, _ = run(capsys, "check", vault, "--read-data")
    assert code == 0 and "no problems found" in out

    code, out, _ = run(capsys, "forget", vault, "--keep-last", "1", "--prune")
    assert f"forgot snapshot {first}" in out and "deleted 1 unused chunks" in out

    code, out, _ = run(capsys, "stats", vault)
    assert "snapshots:      1" in out and "space saving:" in out


def test_errors_are_reported_without_a_traceback(capsys, tmp_path):
    code, _, err = run(capsys, "snapshots", tmp_path)
    assert code == 1 and "is not a vault" in err
    run(capsys, "init", tmp_path / "v")
    code, _, err = run(capsys, "restore", tmp_path / "v", "latest", tmp_path / "out")
    assert code == 1 and "no snapshots yet" in err
    code, _, err = run(capsys, "forget", tmp_path / "v")
    assert code == 2 and "--keep-last" in err


def test_check_reports_problems(capsys, tmp_path, source):
    vault = tmp_path / "vault"
    run(capsys, "init", vault)
    run(capsys, "backup", vault, source)
    next((vault / "chunks").rglob("*/*")).unlink()
    code, out, _ = run(capsys, "check", vault)
    assert code == 1 and "PROBLEM: chunk" in out and "1 problem(s) found" in out


def test_sizes():
    assert human(512) == "512 B"
    assert human(1536) == "1.5 KiB"
    assert human(5 * 1024**3) == "5.0 GiB"
    assert parse_size("8K") == 8192
    assert parse_size("1MiB") == 1 << 20
    assert parse_size("4096") == 4096
