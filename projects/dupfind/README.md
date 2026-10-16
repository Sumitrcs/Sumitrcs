# dupfind

[![CI](https://github.com/Sumitrcs/dupfind/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/dupfind/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Find duplicate files: the same photo saved three times, the PDF in both Downloads and Documents, the copy of a backup.
`dupfind` lists every set of identical files and tells you how much space you could free.

It is fast because it avoids reading files whenever it can. It is also a readable example of real systems code in Rust: **SHA-256 written from scratch**, a three-stage filter, and hashing spread over all CPU cores, with **no dependencies**.

```text
$ dupfind
Scanned 9 files (14.6 MiB) in 0.02s, reading only 11.3 MiB of it.

3 copies of 3.2 MiB (6.5 MiB wasted)  sha256:d8d9cff93329…
  ./Backup/phone/IMG_2041.jpg
  ./Downloads/IMG_2041 (1).jpg
  ./Photos/2025/IMG_2041.jpg

2 copies of 793.0 KiB (793.0 KiB wasted)  sha256:43788e71815a…
  ./Documents/GST-return-Sep.pdf
  ./Downloads/GST-return-Sep.pdf

2 copies of 6 B (6 B wasted)  sha256:444e0fffbd82…
  ./Documents/todo.txt
  ./Downloads/todo.txt

3 groups of duplicates, 4 extra copies: 7.3 MiB could be freed.
```

On a real system folder (`/usr/lib`: 15,439 files, 2.1 GiB) it found 619 groups of duplicates in **0.12 s**, reading only **35.5 MiB**, that is 1.7% of the data.

dupfind only *reports* duplicates. It never deletes anything; you decide what to remove.

## Install and use

```bash
cargo install --path .

dupfind                          # current directory
dupfind ~/Pictures /mnt/backup   # several places at once
dupfind --min-size 1M --skip .git --skip node_modules ~/code
dupfind --json ~/Downloads       # for scripts
```

It also works as a drop-in for `sha256sum`, which is handy for checking downloads and backups:

```text
$ dupfind hash ubuntu.iso > SHA256SUMS
$ dupfind check SHA256SUMS
ubuntu.iso: OK
```

The sums file is in exactly the format `sha256sum` reads and writes, so the two tools are interchangeable.

## How it works

### 1. Three stages, from cheap to expensive

Comparing every file with every other file byte by byte would be hopeless. Hashing every file completely works, but it means reading your whole disk.
Instead, each stage throws away files that cannot possibly have a twin, and only the survivors go on to the next, more expensive stage:

```text
all files ──► same size? ──► same first 4 KiB? ──► same SHA-256? ──► duplicates
             (free: the       (reads 4 KiB         (reads the whole file,
              file system      per file)            only for the few left)
              knows sizes)
```

- **Size.** Two files of different sizes can't be identical, and the size comes free from the directory listing. Most files have a size no other file shares, so they are done without reading a single byte.
- **First 4 KiB.** Files of the same size often differ right at the start (different photos, different headers). A small file of 4 KiB or less is finished here, because its prefix *is* the whole file.
- **Full SHA-256.** Only the files still tied after that get read completely.

In the demo above, `IMG_2042.jpg` had exactly the same size as `IMG_2041.jpg`, but its first 4 KiB were different, so it was never read in full.

### 2. SHA-256 from scratch (`src/sha256.rs`)

A **hash** turns any amount of data into a 32-byte fingerprint. If two files have the same SHA-256, they are identical: nobody has ever found two different inputs with the same SHA-256.

The algorithm, as in the FIPS 180-4 standard:

1. **Pad** the data: add a `1` bit, then zeros, then the length. The total becomes a multiple of 64 bytes.
2. Start from 8 fixed numbers, the square roots of the first 8 primes.
3. For each 64-byte block, expand its 16 words to 64, then do 64 **rounds** of mixing:

```rust
let choose   = (e & f) ^ (!e & g);           // each bit of e picks f or g
let majority = (a & b) ^ (a & c) ^ (b & c);  // each bit is a 2-out-of-3 vote
let t1 = h + Σ1(e) + choose + K[i] + w[i];   // (wrapping additions)
```

4. The 8 numbers at the end are the hash.

The tests check the official NIST vectors (including a million `a`s) and the padding edge cases at 55, 56 and 64 bytes.
During development the output was also compared with `sha256sum` on 297 random files of every awkward size, and every one matched.

### 3. Using every CPU core (`hash_files`)

Hashing is CPU work, so dupfind runs one thread per core with `std::thread::scope`.
Each thread takes the next unclaimed file from a shared **atomic counter**:

```rust
let i = next.fetch_add(1, Ordering::Relaxed);   // claim file number i
```

That way one huge video can't leave the other cores idle while they wait for it, which is a classic problem when work is split into fixed chunks up front.

### 4. Not being fooled by the file system

- **Hard links** are two names for *one* file. They don't waste space, so dupfind identifies files by (device, inode) and counts each once.
- **Symbolic links** are not followed. Following them could loop forever, for example with a link to a parent folder.
- An unreadable file or a missing folder is reported, and the scan carries on.

### Honest performance note

This SHA-256 is plain, portable Rust: about 210 MB/s on one core. `sha256sum` reaches about 1.1 GB/s because it uses the CPU's dedicated SHA instructions.
For finding duplicates that hardly matters, because the stages above avoid nearly all the reading. Closing the gap is the first exercise below.

## What you'll learn

- How a cryptographic hash is actually computed: padding, message schedule, rounds and bit tricks
- Designing a pipeline that does cheap checks before expensive ones, a pattern used everywhere from databases to compilers
- Scoped threads, atomics and work stealing in Rust, without any crates
- Walking a directory tree safely: symlinks, hard links and errors
- Testing against official vectors and against an existing tool (`sha256sum`)
- Writing a CLI with sub-commands, JSON output and grep-style exit codes

## Try it yourself

1. **Hardware SHA.** Use `std::arch::x86_64` SHA-NI intrinsics, behind a runtime CPU check, and measure the speed-up.
2. **Last 4 KiB too.** Many files share a header, like videos from the same camera. Add a stage that also compares the *last* 4 KiB before reading the middle.
3. **Hard-link mode.** Add `--link`, which replaces duplicates with hard links to one copy. Think carefully about what could go wrong first.
4. **A cache.** Store (path, size, modified time) → hash in a file, so a second scan of the same folder is almost instant.
5. **Similar images.** Exact hashes miss resized photos. Read about *perceptual hashing* (aHash, dHash) and try it on JPEG thumbnails.

## Run the tests

```bash
cargo test                               # 16 tests
cargo clippy --all-targets -- -D warnings
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
