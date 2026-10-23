"""Drives the real editor through a pseudo-terminal, like a person would.

A pseudo-terminal (pty) is a pair of file descriptors that behaves like a
terminal: the editor thinks it's talking to a real one. We send key presses
into it, and read back what the editor draws. A small screen model below
understands the few escape codes tinyed uses, so tests can look at the
screen as text.

usage: python3 tests/test_terminal.py build/tinyed
"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time

BINARY = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "build/tinyed")

UP, DOWN, RIGHT, LEFT = "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"
HOME, END, DELETE = "\x1b[H", "\x1b[F", "\x1b[3~"
ESC, ENTER, BACKSPACE = "\x1b", "\r", "\x7f"


def ctrl(c):
    return chr(ord(c) & 0x1F)


class Screen:
    """Just enough of a terminal to replay tinyed's output."""

    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.lines = [[" "] * cols for _ in range(rows)]
        self.y = self.x = 0

    def feed(self, data):
        i = 0
        while i < len(data):
            m = re.match(r"\x1b\[(\??)([\d;]*)([A-Za-z])", data[i:])
            if m:
                private, args, cmd = m.groups()
                nums = [int(a) for a in args.split(";") if a]
                if cmd == "H" and not private:
                    self.y = (nums[0] - 1) if nums else 0
                    self.x = (nums[1] - 1) if len(nums) > 1 else 0
                elif cmd == "K":
                    for x in range(self.x, self.cols):
                        self.lines[self.y][x] = " "
                elif cmd == "J":
                    self.lines = [[" "] * self.cols for _ in range(self.rows)]
                i += m.end()
                continue
            c = data[i]
            if c == "\r":
                self.x = 0
            elif c == "\n":
                self.y = min(self.y + 1, self.rows - 1)
            elif c >= " " and self.x < self.cols and self.y < self.rows:
                self.lines[self.y][self.x] = c
                self.x += 1
            i += 1

    def line(self, y):
        return "".join(self.lines[y]).rstrip()

    def text(self):
        return "\n".join(self.line(y) for y in range(self.rows))


class Editor:
    def __init__(self, *args, rows=12, cols=60, cwd=None):
        self.rows, self.cols = rows, cols
        self.screen = Screen(rows, cols)
        self.raw = ""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.environ["TERM"] = "xterm"
            if cwd:
                os.chdir(cwd)
            os.execv(BINARY, [BINARY, *args])
        self.read()

    def read(self, quiet=0.15, limit=3.0):
        """Read output until the editor has been quiet for a moment."""
        end = time.time() + limit
        last = time.time()
        while time.time() < end and time.time() - last < quiet:
            r, _, _ = select.select([self.fd], [], [], 0.02)
            if r:
                try:
                    chunk = os.read(self.fd, 65536).decode("utf-8", "replace")
                except OSError:
                    break
                self.raw += chunk
                self.screen.feed(chunk)
                last = time.time()

    def keys(self, *keys):
        for k in keys:
            os.write(self.fd, k.encode())
            time.sleep(0.01)
        self.read()
        return self

    def type(self, text):
        for line_no, part in enumerate(text.split("\n")):
            if line_no:
                self.keys(ENTER)
            for ch in part:
                os.write(self.fd, ch.encode())
        self.read()
        return self

    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.screen = Screen(rows, cols)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)
        self.read(quiet=0.3)

    def alive(self):
        return os.waitpid(self.pid, os.WNOHANG) == (0, 0)

    def wait(self):
        self.read()
        _, status = os.waitpid(self.pid, 0)
        # Under `make sanitize`, memory errors and undefined behaviour are
        # reported on the terminal.
        check("no sanitizer reports", "runtime error" not in self.raw and "Sanitizer" not in self.raw, self.raw[-800:])
        return os.waitstatus_to_exitcode(status)


passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"FAIL: {name}\n{detail}")


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


tmp = tempfile.mkdtemp(prefix="tinyed-")
path = lambda name: os.path.join(tmp, name)

# 1. Open a file: line numbers, the status bar and syntax colors are drawn.
write(path("hello.c"), "#include <stdio.h>\n\nint main(void) {\n\treturn 0;\n}\n")
ed = Editor("hello.c", cwd=tmp)
s = ed.screen
check("line numbers and text", s.line(0) == "1  #include <stdio.h>" and s.line(3) == "4      return 0;", s.text())
check("tilde after the end", s.line(5) == "~", s.text())
check("status bar", "hello.c - 5 lines" in s.line(ed.rows - 2) and "C | Ln 1, Col 1" in s.line(ed.rows - 2), s.line(ed.rows - 2))
check("help message", "Ctrl-S save" in s.line(ed.rows - 1), s.line(ed.rows - 1))
check("keywords are colored", "\x1b[33mreturn" in ed.raw and "\x1b[32mint" in ed.raw)
check("uses the alternate screen", "\x1b[?1049h" in ed.raw)
ed.keys(ctrl("q"))
check("quits without changes", ed.wait() == 0)
check("restores the screen", ed.raw.endswith("\x1b[?1049l") or "\x1b[?1049l" in ed.raw[-50:])

# 2. Type a new file with auto-indent, then save.
ed = Editor("new.py", cwd=tmp)
ed.type("def greet():\n    print('hi')\nreturn")
check("modified marker", "(modified)" in ed.screen.line(ed.rows - 2))
check("auto-indent", ed.screen.line(2) == "3      return", ed.screen.text())
ed.keys(ctrl("s"))
check("save message", "Saved" in ed.screen.line(ed.rows - 1) and "(modified)" not in ed.screen.line(ed.rows - 2))
ed.keys(ctrl("q"))
check("exit after save", ed.wait() == 0)
check("saved content", read(path("new.py")) == "def greet():\n    print('hi')\n    return\n", repr(read(path("new.py"))))

# 3. Quitting with unsaved changes needs a second Ctrl-Q, and keeps the file.
write(path("keep.txt"), "important\n")
ed = Editor("keep.txt", cwd=tmp)
ed.type("junk ")
ed.keys(ctrl("q"))
check("warns before losing changes", "Unsaved changes" in ed.screen.line(ed.rows - 1) and ed.alive())
ed.keys(LEFT)  # any other key cancels the warning
ed.keys(ctrl("q"))
check("still running after cancelled quit", ed.alive())
ed.keys(ctrl("q"))
check("second Ctrl-Q quits", ed.wait() == 0)
check("file untouched", read(path("keep.txt")) == "important\n")

# 4. Undo and redo.
write(path("undo.txt"), "abc\n")
ed = Editor("undo.txt", cwd=tmp)
ed.type("XYZ")
check("typed", ed.screen.line(0) == "1  XYZabc")
ed.keys(ctrl("z"))
check("undo removes the whole word", ed.screen.line(0) == "1  abc", ed.screen.line(0))
ed.keys(ctrl("z"))
check("nothing more to undo", "Nothing to undo" in ed.screen.line(ed.rows - 1))
ed.keys(ctrl("y"))
check("redo", ed.screen.line(0) == "1  XYZabc")
ed.keys(END, BACKSPACE, BACKSPACE, ctrl("z"))
check("undo backspaces", ed.screen.line(0) == "1  XYZabc", ed.screen.line(0))
ed.keys(ctrl("s"), ctrl("q"))
ed.wait()
check("saved after undo/redo", read(path("undo.txt")) == "XYZabc\n")

# 5. Editing keys: Delete and Backspace join lines, Home/End, arrows.
write(path("keys.txt"), "ab\ncd\nef\n")
ed = Editor("keys.txt", cwd=tmp)
ed.keys(END, DELETE)            # join line 1 and 2
ed.keys(DOWN, HOME, BACKSPACE)  # join (abcd) and ef
ed.keys(LEFT, LEFT, DELETE)     # the cursor is after "abcd": delete 'c'
ed.keys(ctrl("s"), ctrl("q"))
ed.wait()
check("delete/backspace/arrows", read(path("keys.txt")) == "abdef\n", repr(read(path("keys.txt"))))

# 6. Search, then type at the match; Escape returns to where we were.
write(path("find.txt"), "".join(f"line {i}\n" for i in range(1, 101)).replace("line 70\n", "line 70 needle\n"))
ed = Editor("find.txt", cwd=tmp)
ed.keys(ctrl("f"))
ed.type("needle")
check("search moves to the match", "Ln 70, Col 9" in ed.screen.line(ed.rows - 2), ed.screen.line(ed.rows - 2))
check("match is visible", any("70  line 70 needle" in ed.screen.line(y) for y in range(ed.rows)), ed.screen.text())
check("match is highlighted", "\x1b[34mneedle" in ed.raw)
ed.keys(ENTER)
ed.type(">")
ed.keys(ctrl("f"))
ed.type("line 9")
ed.keys(ESC)
check("escape goes back", "Ln 70, Col 10" in ed.screen.line(ed.rows - 2), ed.screen.line(ed.rows - 2))
ed.keys(ctrl("f"))
ed.type("zzz")
check("not found stays put", "Ln 70, Col 10" in ed.screen.line(ed.rows - 2))
ed.keys(ENTER)
check("not found message", "Not found: zzz" in ed.screen.line(ed.rows - 1), ed.screen.line(ed.rows - 1))
ed.keys(ctrl("s"), ctrl("q"))
ed.wait()
check("typed at the match", "line 70 >needle\n" in read(path("find.txt")))

# 7. Search with arrows: next and previous, wrapping around.
write(path("many.txt"), "x\nfoo 1\nx\nfoo 2\nx\nfoo 3\n")
ed = Editor("many.txt", cwd=tmp)
ed.keys(ctrl("f"))
ed.type("foo")
check("first match", "Ln 2," in ed.screen.line(ed.rows - 2))
ed.keys(DOWN)
check("next match", "Ln 4," in ed.screen.line(ed.rows - 2))
ed.keys(DOWN, DOWN)
check("wraps to the first", "Ln 2," in ed.screen.line(ed.rows - 2))
ed.keys(UP)
check("previous wraps to the last", "Ln 6," in ed.screen.line(ed.rows - 2))
ed.keys(ENTER, ctrl("q"))
check("quit after search", ed.wait() == 0)

# 8. Go to line and Ctrl-K, with undo.
write(path("goto.txt"), "".join(f"row {i}\n" for i in range(1, 51)))
ed = Editor("goto.txt", cwd=tmp)
ed.keys(ctrl("g"))
ed.type("42")
ed.keys(ENTER)
check("go to line", "Ln 42, Col 1" in ed.screen.line(ed.rows - 2))
ed.keys(ctrl("k"))
check("cut line", any(ed.screen.line(y) == "42  row 43" for y in range(ed.rows)), ed.screen.text())
ed.keys(ctrl("k"), ctrl("z"))
check("undo cut", any(ed.screen.line(y) == "42  row 43" for y in range(ed.rows)), ed.screen.text())
ed.keys(ctrl("g"))
ed.type("999")
ed.keys(ENTER)
check("go past the end", "Ln 49," in ed.screen.line(ed.rows - 2), ed.screen.line(ed.rows - 2))
ed.keys(ctrl("k"))
ed.keys(ctrl("s"), ctrl("q"))
ed.wait()
lines = read(path("goto.txt")).splitlines()
check("cut lines saved", len(lines) == 48 and "row 42" not in lines and lines[-1] == "row 49", lines[-3:])

# 9. Scrolling a long line horizontally, and a window resize.
write(path("wide.txt"), "start " + "x" * 100 + " END\nshort\n")
ed = Editor("wide.txt", cwd=tmp)
ed.keys(END)
check("scrolls right", ed.screen.line(0).endswith("x END"), ed.screen.line(0))
ed.keys(HOME)
check("scrolls back", ed.screen.line(0).startswith("1  start"), ed.screen.line(0))
ed.resize(8, 40)
check("redraws at the new size", len(ed.screen.line(6)) <= 40 and "wide.txt" in ed.screen.line(6), ed.screen.text())
ed.keys(ctrl("q"))
check("quit after resize", ed.wait() == 0)

# 10. UTF-8: the cursor moves over whole characters.
write(path("utf8.txt"), "naïve café\n")
ed = Editor("utf8.txt", cwd=tmp)
ed.keys(END, LEFT, LEFT)
check("column counts characters", "Col 9" in ed.screen.line(ed.rows - 2), ed.screen.line(ed.rows - 2))
ed.keys(BACKSPACE)
ed.type("ű")
ed.keys(ctrl("s"), ctrl("q"))
ed.wait()
check("utf-8 edit", read(path("utf8.txt")) == "naïve cűfé\n", read(path("utf8.txt")))

# 11. No file name: Ctrl-S asks for one.
ed = Editor(cwd=tmp)
check("welcome screen", "tinyed 1.0.0" in ed.screen.text())
ed.type("x = 1")
ed.keys(ctrl("s"))
check("asks for a name", "Save as:" in ed.screen.line(ed.rows - 1))
ed.type("named.py")
ed.keys(ENTER)
check("language detected after naming", "Python" in ed.screen.line(ed.rows - 2), ed.screen.line(ed.rows - 2))
ed.keys(ctrl("q"))
ed.wait()
check("saved under the new name", read(path("named.py")) == "x = 1\n")

# 12. Errors: a folder can't be opened; not a terminal.
ed = Editor(tmp)
check("can't open a folder", ed.wait() == 1 and "can't open" in ed.raw, ed.raw)
check("help", os.system(f"{BINARY} --help > /dev/null") == 0)
check("needs a terminal", os.system(f"echo | {BINARY} 2>/dev/null >/dev/null") != 0)

os.system(f"rm -rf {tmp}")
print(f"terminal tests: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
