# minigit

[![CI](https://github.com/Sumitrcs/minigit/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/minigit/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**A small Git, written in about 700 lines of readable Python, that uses
Git's real on-disk formats.** Repositories made by minigit open in the real
`git` — and minigit can read repositories made by `git`.

You use Git every day. This project shows what it actually does when you run
`add` and `commit`, so the "magic" turns into a few simple ideas.

```
$ minigit init
Initialized empty minigit repository in /home/sumit/demo/.git
$ echo "hello world" > hello.txt
$ minigit add hello.txt
$ minigit commit -m "First commit"
[main 403f896] First commit
$ minigit cat-file -p HEAD
tree 68aba62e560c0ebc3396e8ae9335232cd93a3f60
author Sumit <sumit@example.com> 1791432750 +0000
committer Sumit <sumit@example.com> 1791432750 +0000

First commit
$ minigit cat-file -p "HEAD^{tree}"
100644 blob 3b18e512dba79e4c8300dd08aeb37f8e728b8dad	hello.txt
$ git log --oneline        # the real git reads it!
403f896 First commit
```

## Commands

| Command | What it does |
|---|---|
| `minigit init [-b main]` | create `.git/` with `objects/`, `refs/` and `HEAD` |
| `minigit hash-object [-w] FILE` | compute a file's object id (and store it with `-w`) |
| `minigit cat-file -p\|-t\|-s OBJ` | show any object; accepts `HEAD`, branch names, short ids and `HEAD^{tree}` |
| `minigit add PATH...` | stage files or whole folders (staging a deleted file records the deletion) |
| `minigit ls-files [-s]` | list what's in the index |
| `minigit write-tree` | turn the index into tree objects |
| `minigit commit -m MSG` | record a commit and move the branch |
| `minigit log [--oneline] [-n N]` | walk the history |
| `minigit status` | staged, unstaged and untracked changes |
| `minigit branch [NAME]` | list or create branches |
| `minigit checkout BRANCH` | switch branches (refuses if you have uncommitted work) |

```bash
pip install .
export MINIGIT_AUTHOR="Your Name <you@example.com>"
```

## How it works — Git in five ideas

**1. Everything is an object named by its content.**
A file's contents become a *blob*. Git writes `"blob <size>\0" + content`,
takes the SHA-1 of those bytes, and that hash *is* the object's name. Two
identical files are stored once. Change one byte and you get a new name.
→ `minigit/objects.py`, `hash_object()`

**2. Objects live in `.git/objects`, compressed.**
The id `3b18e512…` is stored at `.git/objects/3b/18e512…`, compressed with
zlib. Objects never change, so writing the same one twice is skipped.
→ `ObjectStore.write()`

**3. A tree is a folder; a commit is a snapshot plus history.**
A *tree* lists names, modes and the ids of blobs or sub-trees. A *commit* is
plain text: the root tree, the parent commit(s), author, date and message.
Because each commit names its parent, history is a linked list you can walk
backwards. → `encode_tree()`, `Commit.encode()`, `Repository.log()`

**4. The index is the staging area.**
`.git/index` is a binary file listing every staged path with its blob id and
file stats. `add` stores the blob and updates the index; `commit` turns the
index into trees. minigit writes the real version-2 format (with its 8-byte
padding and SHA-1 checksum), which is why `git status` understands it.
→ `minigit/index.py`

**5. Branches are tiny files.**
`.git/refs/heads/main` contains one commit id. `HEAD` says which branch you're
on (`ref: refs/heads/main`). Committing writes a new commit and overwrites
that one line. Creating a branch just writes another file.
→ `Repository.commit()`, `create_branch()`, `checkout()`

## What you'll learn

- Content-addressable storage and why hashing makes Git fast and safe
- Reading and writing binary formats with `struct` and checksums
- Turning a flat list of paths into a nested tree (recursion)
- How `status` compares three things: HEAD, the index and your files
- Writing files safely: write to a temp/lock file, then rename
- Testing against a reference implementation (the real `git`)

## Try it yourself

1. **`minigit tag NAME`** — write `.git/refs/tags/NAME` pointing at HEAD (`resolve()` already reads tags).
2. **`minigit diff`** — compare the index with the working tree using Python's `difflib`.
3. **`minigit rm PATH`** — remove a file from the index and the working tree.
4. **Merge commits** — let `commit` accept two parents, and make `log --graph` follow both.
5. **Packfiles** — real Git compresses old objects into `.git/objects/pack`. Read the
   `.idx` file format and add support for packed objects (a big, rewarding challenge).

## Tests

```bash
pip install -e ".[dev]"
pytest
```

Besides unit tests for every command, the suite checks **compatibility with
real Git**: object ids match `git hash-object`, `git fsck --strict` accepts
minigit's commits and trees, `git status` is clean on minigit's index,
`git ls-files -s` matches, and minigit reads a repository created by `git`.
(Those tests are skipped automatically if git isn't installed.)

Limitations by design: no packfiles, merges, remotes or rename detection —
the goal is clarity, not a replacement for Git.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
