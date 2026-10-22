# snapvault

[![CI](https://github.com/Sumitrcs/snapvault/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/snapvault/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**Deduplicating, incremental backups in under 800 lines of commented Python.** Every snapshot is a complete copy of your folder that you can restore on its own, yet a new snapshot only takes as much space as the data that actually changed.
It's the idea behind restic, borg and Time Machine-style tools, built from scratch with the standard library only and explained step by step.

```text
$ snapvault init backups
created vault backups

$ snapvault backup backups projects
snapshot 4279c13d4597 saved
  files: 474 (474 new, 0 changed, 0 unchanged), 200 folders, 0 symlinks
  read:  2.4 MiB of 2.4 MiB
  added: 713 new chunks, 2.4 MiB (1.3 MiB compressed)
  time:  0.79 s

$ echo "## Notes" >> projects/minigit/README.md                                  # edit one file
$ cp projects/json-lens/docs/screenshot.png projects/json-lens/docs/screenshot-copy.png   # copy another

$ snapvault backup backups projects
snapshot 3a64058c1a7b saved (compared with 4279c13d4597)
  files: 475 (1 new, 1 changed, 473 unchanged), 200 folders, 0 symlinks
  read:  115.0 KiB of 2.5 MiB
  added: 2 new chunks, 3.2 KiB (1.6 KiB compressed)
  time:  0.06 s

$ snapvault diff backups 4279 3a64
+ json-lens/docs/screenshot-copy.png
M minigit/README.md
1 added, 0 removed, 1 modified

$ snapvault stats backups
snapshots:      2
chunks:         715
stored on disk: 1.3 MiB
all snapshots:  5.0 MiB if restored
space saving:   3.9x (deduplication + compression)

$ snapvault restore backups 4279 restored --path minigit/README.md
restored 1 entry from snapshot 4279c13d4597 to restored
```

The second backup read only the two files that changed. The 110 KiB copy of the screenshot cost **nothing**, because its chunks were already in the vault, and the edit to the README cost one small chunk.

## Commands

```bash
pip install .            # or run without installing: python -m snapvault ...

snapvault init VAULT                         # create a vault (an ordinary folder)
snapvault backup VAULT FOLDER [--exclude '*.tmp'] [--exclude node_modules] [--full]
snapvault snapshots VAULT                    # list snapshots
snapvault ls VAULT SNAPSHOT [PATH]           # list files in a snapshot
snapvault restore VAULT SNAPSHOT DEST [--path PATH]
snapvault diff VAULT OLD NEW                 # what changed between two snapshots
snapvault check VAULT [--read-data]          # verify everything is there and intact
snapvault forget VAULT --keep-last 7 [--prune]
snapvault prune VAULT                        # delete chunks no snapshot uses
snapvault stats VAULT
```

`SNAPSHOT` can be `latest` or the first few characters of an id, like a git commit.

## How it works

### 1. Files are cut into chunks, and each chunk is stored once

Every file is split into pieces of about 6 KiB. Each piece is named by its **SHA-256 hash**, a 64-character fingerprint that is (for all practical purposes) different for different data:

```text
vault/
  config.json
  chunks/3f/3fa9c1...e1     ← one file per distinct chunk, compressed with zlib
  chunks/a0/a07b44...9c
  snapshots/4279c13d4597.json
```

Before storing a chunk, the vault checks whether a file with that name already exists. If it does, the same data is already there and nothing is written. This is **content-addressed storage**, the same idea git uses for its objects.

A snapshot is a JSON file listing every file with its size, permissions, modification time and the hashes of its chunks:

```json
{"chunks": ["828b...", "bf3d...", "365d..."], "mode": 33188, "mtime_ns": 1792639678438433598,
 "path": "minigit/README.md", "size": 5321, "target": "", "type": "file"}
```

Restoring a file means reading its chunks in order and writing them one after another.

### 2. Where to cut: content-defined chunking

The obvious way to split is into fixed 8 KiB blocks. But insert a single byte at the start of a file and **every** block boundary shifts by one, so every block's hash changes and the whole file is stored again:

```text
fixed blocks:   |AAAAAAAA|BBBBBBBB|CCCCCCCC|        insert "x" at the start →
                |xAAAAAAA|ABBBBBBB|BCCCCCCC|C       every block is different
```

snapvault instead lets the **content** decide where to cut. It slides a *rolling hash* along the file and cuts wherever the hash has a particular bit pattern (its top 12 bits are all zero, which happens once every 4,096 bytes on average). The cut points depend only on the nearby bytes, so after an insertion the same content produces the same cut points again:

```text
content-defined: |AAAAAAA|BBBBBBBBBB|CCCCC|         insert "x" →
                 |xAAAAAAA|BBBBBBBBBB|CCCCC|        only the first chunk changes
```

The tests measure this: inserting text into a 1 MB file leaves at least all but 3 of its ~160 chunks unchanged, while with fixed blocks **zero** are reused.

The rolling hash is the *gear hash* from the FastCDC paper:

```python
h = ((h << 1) + GEAR[byte]) & MASK64
```

`GEAR` is a fixed table of 256 random 64-bit numbers, one per byte value. Each step shifts the old bits one place left, so after 64 bytes a byte has been shifted out entirely: the top bits of `h` depend only on the last 64 bytes. That's a rolling hash for free, with no "subtract the byte leaving the window" step. Chunks are also kept between 2 KiB and 64 KiB, and the first 2 KiB of each chunk aren't hashed at all, since a cut there isn't allowed anyway.

### 3. Incremental backups: don't even read unchanged files

Hashing still means reading every byte. So, like rsync, restic and git, snapvault first compares each file's **size and modification time** with the previous snapshot of the same folder. If both match, it reuses the old chunk list without opening the file. That's why the second backup above read 115 KiB instead of 2.5 MiB.
(`--full` reads everything, in case you don't trust modification times.)

### 4. Never leave a half-written vault

Every file in the vault is written to a temporary name, flushed to disk with `fsync`, and then **renamed** into place. A rename is atomic: other programs see either the old state or the new one, never half a file.
The snapshot file is written **last**, so if a backup is interrupted (Ctrl-C, a crash, a full disk), the vault simply has some chunks no snapshot uses yet. Nothing is corrupted, and `prune` cleans them up. A test interrupts a backup halfway and checks exactly this.

### 5. Trust nothing when reading back

- Each chunk is **checksummed when it is read**: its SHA-256 must match its name, so disk corruption is caught instead of being restored silently. `check --read-data` verifies every chunk this way.
- A snapshot is just a JSON file that anyone could edit. Restore refuses paths like `../../.bashrc` or `/etc/passwd`, and never writes through a symlink, so a tampered snapshot can't write outside the destination folder (*path traversal*, a real class of security bugs in archive tools).

### 6. Forget and prune

`forget` deletes snapshot files only. Chunks may be shared with other snapshots, so they can't be deleted at the same time.
`prune` is a small **mark-and-sweep garbage collector**: it collects every chunk hash used by any remaining snapshot (mark), then deletes every chunk file not in that set (sweep).

## Limits

This is a learning project. Unlike restic or borg, it doesn't encrypt (anyone who can read the vault can read your files), it doesn't lock the vault against two backups running at once, and the pure-Python chunker processes about 12 MB/s, so a first backup of 100 GB would take a few hours.
Hard links are stored as separate files, and sockets and device files are skipped.

## What you'll learn

- Content-addressed storage and deduplication, the idea behind git, Docker layers and backup tools
- Rolling hashes and content-defined chunking (gear hash, FastCDC)
- Incremental backups with size + mtime change detection, and its trade-offs
- Crash safety: write to a temporary file, `fsync`, then atomic rename
- Integrity checking with SHA-256, and defending against path traversal
- Mark-and-sweep garbage collection
- Python: `os.scandir`, `stat`, `zlib`, `hashlib`, dataclasses, `argparse` subcommands, and pytest with `tmp_path` and `monkeypatch`

## Try it yourself

1. **Encryption.** Encrypt each chunk with AES-GCM (`pip install cryptography`) using a key derived from a password with `hashlib.scrypt`. Should the chunk name be the hash of the plain or the encrypted data? (Think about what the name reveals.)
2. **A faster chunker.** Profile it with `python -m cProfile`. Then try a C extension, or Rust via PyO3, for `cut_point` alone.
3. **Pack files.** Thousands of tiny chunk files are slow on some file systems. Append chunks to larger pack files and keep an index of (pack, offset, length).
4. **Retention policies.** Add `--keep-daily 7 --keep-weekly 4 --keep-monthly 12` to `forget`.
5. **Mount a snapshot.** Use FUSE (`pip install fusepy`) to browse a snapshot like a normal folder without restoring it.

## Run the tests

```bash
pip install -e ".[dev]"
pytest -q          # 38 tests
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
