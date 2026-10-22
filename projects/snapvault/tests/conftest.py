import os
import random
from pathlib import Path

import pytest


def write(path: Path, data: bytes | str, mtime: int | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


@pytest.fixture
def source(tmp_path: Path) -> Path:
    """A small folder with a bit of everything."""
    rnd = random.Random(7)
    src = tmp_path / "src"
    write(src / "notes.txt", "remember the milk\n")
    write(src / "empty.txt", b"")
    write(src / "photos" / "goa.jpg", rnd.randbytes(150_000))
    write(src / "photos" / "copy-of-goa.jpg", (src / "photos" / "goa.jpg").read_bytes())
    write(src / "code" / "main.py", "print('hello')\n" * 2000)
    write(src / "हिंदी नाम.txt", "unicode names work\n")
    (src / "empty-folder").mkdir()
    (src / "link-to-notes").symlink_to("notes.txt")
    script = write(src / "code" / "run.sh", "#!/bin/sh\necho hi\n")
    script.chmod(0o755)
    return src


def tree(root: Path) -> dict:
    """Everything about a folder that a backup should preserve."""
    out = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        st = path.lstat()
        if path.is_symlink():
            out[rel] = ("link", os.readlink(path))
        elif path.is_dir():
            out[rel] = ("dir", st.st_mode)
        else:
            out[rel] = ("file", st.st_mode, st.st_mtime_ns, path.read_bytes())
    return out
