# rzip

[![CI](https://github.com/Sumitrcs/rzip/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/rzip/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A lossless file compressor written **from scratch in Rust** — no compression
crates, no dependencies. It implements the two classic ideas behind zip,
gzip and PNG: **LZ77** back-references and **Huffman coding** — and reaches
**gzip-level compression ratios**.

```bash
$ rzip --bench python-stdlib.txt        # 2 MB of Python source
level          size    ratio   comp MB/s decomp MB/s
1            512107    25.6%        39.8       124.4
6            487157    24.4%        14.4       127.8
9            485448    24.3%         4.7       130.6

gzip -6: 488724   gzip -9: 484710
```

## Usage

```bash
cargo install --path .

rzip report.csv              # -> report.csv.rz   (default level 6)
rzip -9 backup.sql           # slower, smaller
rzip -t report.csv.rz        # verify integrity (CRC-32)
rzip -d report.csv.rz        # -> report.csv
rzip --bench somefile        # compare levels
```

As a library:

```rust
let packed = rzip::compress(&data);
let original = rzip::decompress(&packed)?;   // Err on any corruption
```

## How it works

```
input ──▶ LZ77 match finder ──▶ tokens ──▶ Huffman coder ──▶ blocks ──▶ .rz file
          (hash chains,           literal        canonical codes,      + size
           lazy matching,         or (len,dist)  length-limited 15b    + CRC-32
           32 KiB window)
```

1. **LZ77 with hash chains.** Every 3-byte sequence is hashed; a chain links
   earlier positions with the same hash. For each position the encoder walks
   the chain (bounded by the compression level) to find the longest match of
   up to 258 bytes within the last 32 KiB. **Lazy matching** checks whether
   starting one byte later gives a longer match, which noticeably helps text.
2. **Alphabets.** Lengths 3–258 map to 29 length symbols and distances
   1–32768 map to 30 distance symbols with extra bits — the DEFLATE scheme.
3. **Huffman coding.** Per block, symbol frequencies build an optimal prefix
   code. Code lengths are **limited to 15 bits** by flattening frequencies until
   the tree fits, then turned into **canonical codes** so only the lengths are
   stored. Decoding uses compact count/symbol tables.
4. **Blocks and safety.** Each block of up to 65,536 tokens has its own
   tables; if coding doesn't beat the raw size, the block is stored raw, so
   random data grows by only a few bytes. The decoder validates everything:
   magic, block types, over-subscribed codes, distances before the start of
   the output, declared length, and finally the **CRC-32**.

## File format

```
"RZ1\0" | original length (u64) | CRC-32 (u32) | blocks | 0xFF
block = 0x00 | len u32 | raw bytes
      | 0x01 | len u32 | 4-bit code lengths (286 + 30) | Huffman bitstream … EOB
```

## Tests

```bash
cargo test --release
```

Round-trips at levels 1/6/9 on empty input, a single byte, 1 MB of zeros,
random bytes, source text and skewed data; verifies every length and distance
maps to the correct symbol; checks Huffman Kraft inequality and the 15-bit
limit on Fibonacci frequencies; and checks that truncated and bit-flipped
files are rejected.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
