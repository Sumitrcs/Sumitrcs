import os
import shutil
import subprocess
from pathlib import Path

import pytest

from minigit import Commit, IndexFormatError, Repository, RepoError, TreeEntry, decode_tree, encode_tree, hash_object, read_index
from minigit.cli import main

HAS_GIT = shutil.which("git") is not None
needs_git = pytest.mark.skipif(not HAS_GIT, reason="git not installed")
AUTHOR = "Test User <test@example.com>"


def git(cwd, *args):
    env = {**os.environ, "GIT_AUTHOR_NAME": "Test User", "GIT_AUTHOR_EMAIL": "test@example.com",
           "GIT_COMMITTER_NAME": "Test User", "GIT_COMMITTER_EMAIL": "test@example.com"}
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    r = Repository.init(tmp_path)
    (tmp_path / "README.md").write_text("# demo\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hi')\n")
    return r


def test_hash_object_known_values():
    # Same ids git produces: `echo -n "" | git hash-object --stdin` etc.
    assert hash_object(b"")[0] == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    assert hash_object(b"hello world\n")[0] == "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"


def test_tree_round_trip_and_git_sort_order():
    entries = [TreeEntry("100644", "a.txt", "1" * 40), TreeEntry("40000", "a", "2" * 40), TreeEntry("100644", "a-b", "3" * 40)]
    decoded = decode_tree(encode_tree(entries))
    # Directories sort as if their name ended in "/", and "." (0x2E) < "/" (0x2F),
    # so git's order is a-b, a.txt, a/ — checked against real `git write-tree`.
    assert [e.name for e in decoded] == ["a-b", "a.txt", "a"]
    assert set(decoded) == set(entries)


def test_commit_round_trip():
    c = Commit("a" * 40, ["b" * 40], f"{AUTHOR} 1 +0530", f"{AUTHOR} 1 +0530", "Subject\n\nBody\n")
    assert Commit.decode(c.encode()) == c


def test_add_commit_log(repo, tmp_path):
    repo.add([Path(".")])
    first = repo.commit("Initial commit", author=AUTHOR, when=1_700_000_000, tz="+0530")
    (tmp_path / "README.md").write_text("# demo\nmore\n")
    repo.add([Path("README.md")])
    second = repo.commit("Expand readme", author=AUTHOR)
    history = list(repo.log())
    assert [sha for sha, _ in history] == [second, first]
    assert history[0][1].parents == [first]
    assert history[1][1].author.endswith("1700000000 +0530")
    assert repo.objects.resolve(second[:7]) == second


def test_status_reports_every_kind_of_change(repo, tmp_path):
    st = repo.status()
    assert st.untracked == ["README.md", "src/main.py"]
    repo.add([Path(".")])
    assert repo.status().staged == {"README.md": "new file", "src/main.py": "new file"}
    repo.commit("init", author=AUTHOR)
    assert repo.status().clean

    (tmp_path / "README.md").write_text("changed\n")
    (tmp_path / "src" / "main.py").unlink()
    (tmp_path / "notes.txt").write_text("x")
    st = repo.status()
    assert st.unstaged == {"README.md": "modified", "src/main.py": "deleted"}
    assert st.untracked == ["notes.txt"]

    repo.add([Path("README.md"), Path("src/main.py")])
    assert repo.status().staged == {"README.md": "modified", "src/main.py": "deleted"}


def test_nothing_to_commit_and_empty_message(repo):
    with pytest.raises(RepoError, match="index is empty"):
        repo.commit("x", author=AUTHOR)
    repo.add([Path(".")])
    repo.commit("init", author=AUTHOR)
    with pytest.raises(RepoError, match="nothing to commit"):
        repo.commit("again", author=AUTHOR)
    with pytest.raises(RepoError, match="empty commit message"):
        repo.commit("  ", author=AUTHOR)


def test_branch_and_checkout(repo, tmp_path):
    repo.add([Path(".")])
    repo.commit("init", author=AUTHOR)
    repo.create_branch("feature")
    repo.checkout("feature")
    assert repo.current_branch() == "feature"
    (tmp_path / "src" / "feature.py").write_text("x = 1\n")
    repo.add([Path("src/feature.py")])
    repo.commit("add feature", author=AUTHOR)

    repo.checkout("main")
    assert not (tmp_path / "src" / "feature.py").exists()
    repo.checkout("feature")
    assert (tmp_path / "src" / "feature.py").read_text() == "x = 1\n"
    assert repo.branches() == ["feature", "main"]

    (tmp_path / "README.md").write_text("dirty\n")
    with pytest.raises(RepoError, match="uncommitted changes"):
        repo.checkout("main")
    with pytest.raises(RepoError, match="already exists"):
        repo.create_branch("main")


def test_corrupt_index_is_detected(repo):
    repo.add([Path(".")])
    data = bytearray(repo.index_path.read_bytes())
    data[20] ^= 0xFF
    repo.index_path.write_bytes(bytes(data))
    with pytest.raises(IndexFormatError, match="checksum"):
        read_index(repo.index_path)


def test_find_walks_up_and_init_refuses_existing(repo, tmp_path):
    assert Repository.find(tmp_path / "src").worktree == tmp_path.resolve()
    with pytest.raises(RepoError, match="already exists"):
        Repository.init(tmp_path)


@needs_git
def test_real_git_accepts_minigit_repository(repo, tmp_path):
    repo.add([Path(".")])
    repo.commit("Initial commit", author=AUTHOR)
    (tmp_path / "README.md").write_text("v2\n")
    repo.add([Path("README.md")])
    sha = repo.commit("Second commit", author=AUTHOR)

    assert git(tmp_path, "rev-parse", "HEAD").strip() == sha
    git(tmp_path, "fsck", "--strict")  # raises on any malformed object
    assert git(tmp_path, "status", "--porcelain") == ""  # git understands our index
    assert git(tmp_path, "log", "--format=%s").split("\n")[:2] == ["Second commit", "Initial commit"]
    ours = {p: e.sha for p, e in read_index(repo.index_path).items()}
    theirs = {}
    for line in git(tmp_path, "ls-files", "-s").splitlines():
        meta, path = line.split("\t")
        theirs[path] = meta.split(" ")[1]
    assert ours == theirs


@needs_git
def test_minigit_reads_repository_made_by_real_git(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "a.txt").write_text("from git\n")
    git(tmp_path, "add", "a.txt")
    git(tmp_path, "commit", "-q", "-m", "made by git")
    r = Repository.find(tmp_path)
    [(sha, c)] = list(r.log())
    assert sha == git(tmp_path, "rev-parse", "HEAD").strip()
    assert c.message == "made by git\n"
    assert r.tree_files(c.tree)["a.txt"][1] == git(tmp_path, "hash-object", "a.txt").strip()
    assert r.status().clean  # reads git's own index file


def test_cli_end_to_end(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MINIGIT_AUTHOR", AUTHOR)
    assert main(["init"]) == 0
    (tmp_path / "f.txt").write_text("data\n")
    assert main(["add", "f.txt"]) == 0
    assert main(["commit", "-m", "first"]) == 0
    capsys.readouterr()
    assert main(["log", "--oneline"]) == 0
    assert "first" in capsys.readouterr().out
    assert main(["cat-file", "-t", "HEAD"]) == 0
    assert capsys.readouterr().out.strip() == "commit"
    assert main(["cat-file", "-p", "HEAD^{tree}"]) == 0
    assert "f.txt" in capsys.readouterr().out
    assert main(["status"]) == 0
    assert "nothing to commit" in capsys.readouterr().out
    assert main(["checkout", "nope"]) == 1
