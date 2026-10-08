//! Container format (all integers little-endian):
//!
//! ```text
//! "RZ1\0" | original_len: u64 | crc32: u32 | block* | 0xFF
//! block  = 0x00 | len: u32 | raw bytes                      (stored)
//!        | 0x01 | len: u32 | bitstream                      (huffman)
//! bitstream = 286 literal/length code lengths (4 bits each)
//!           | 30 distance code lengths (4 bits each)
//!           | symbols … | end-of-block (256)
//! ```

use std::fmt;

use crate::bits::{BitReader, BitWriter};
use crate::crc32::crc32;
use crate::huffman::{Decoder, MAX_BITS, canonical_codes, code_lengths};
use crate::lz77::{Token, tokenize};

const MAGIC: &[u8; 4] = b"RZ1\0";
const LITLEN_SYMBOLS: usize = 286;
const DIST_SYMBOLS: usize = 30;
const END_OF_BLOCK: usize = 256;
const BLOCK_TOKENS: usize = 1 << 16;

const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LEN_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// How many hash-chain candidates to examine per position (speed vs ratio).
    pub max_chain: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options { max_chain: 128 }
    }
}

impl Options {
    pub fn level(level: u8) -> Options {
        Options {
            max_chain: [4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096][level.clamp(1, 9) as usize],
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    BadMagic,
    Truncated,
    BadBlockType(u8),
    InvalidCode,
    BadDistance,
    LengthMismatch { expected: u64, actual: u64 },
    ChecksumMismatch { expected: u32, actual: u32 },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::BadMagic => write!(f, "not an rzip file"),
            DecodeError::Truncated => write!(f, "file is truncated"),
            DecodeError::BadBlockType(t) => write!(f, "unknown block type {t:#x}"),
            DecodeError::InvalidCode => write!(f, "invalid Huffman code"),
            DecodeError::BadDistance => write!(f, "back-reference points before start of data"),
            DecodeError::LengthMismatch { expected, actual } => {
                write!(f, "expected {expected} bytes, got {actual}")
            }
            DecodeError::ChecksumMismatch { expected, actual } => {
                write!(
                    f,
                    "CRC mismatch: expected {expected:08x}, got {actual:08x} — data is corrupt"
                )
            }
        }
    }
}

impl std::error::Error for DecodeError {}

fn len_symbol(len: u16) -> (usize, u32, u32) {
    let i = LEN_BASE.partition_point(|&b| b <= len) - 1;
    (257 + i, (len - LEN_BASE[i]) as u32, LEN_EXTRA[i] as u32)
}

fn dist_symbol(dist: u16) -> (usize, u32, u32) {
    let i = DIST_BASE.partition_point(|&b| b <= dist) - 1;
    (i, (dist - DIST_BASE[i]) as u32, DIST_EXTRA[i] as u32)
}

pub fn compress(data: &[u8]) -> Vec<u8> {
    compress_with(data, Options::default())
}

pub fn compress_with(data: &[u8], opts: Options) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 2 + 32);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(data.len() as u64).to_le_bytes());
    out.extend_from_slice(&crc32(data).to_le_bytes());

    let tokens = tokenize(data, opts.max_chain);
    let mut pos = 0usize;
    for chunk in tokens.chunks(BLOCK_TOKENS) {
        let span: usize = chunk
            .iter()
            .map(|t| match t {
                Token::Literal(_) => 1,
                Token::Match { len, .. } => *len as usize,
            })
            .sum();
        let encoded = encode_block(chunk);
        if encoded.len() < span {
            out.push(1);
            out.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
            out.extend_from_slice(&encoded);
        } else {
            // Incompressible (already compressed media, random data): store raw.
            out.push(0);
            out.extend_from_slice(&(span as u32).to_le_bytes());
            out.extend_from_slice(&data[pos..pos + span]);
        }
        pos += span;
    }
    out.push(0xFF);
    out
}

fn encode_block(tokens: &[Token]) -> Vec<u8> {
    let mut lit_freq = [0u32; LITLEN_SYMBOLS];
    let mut dist_freq = [0u32; DIST_SYMBOLS];
    for t in tokens {
        match *t {
            Token::Literal(b) => lit_freq[b as usize] += 1,
            Token::Match { len, dist } => {
                lit_freq[len_symbol(len).0] += 1;
                dist_freq[dist_symbol(dist).0] += 1;
            }
        }
    }
    lit_freq[END_OF_BLOCK] = 1;

    let lit_lens = code_lengths(&lit_freq, MAX_BITS);
    let dist_lens = code_lengths(&dist_freq, MAX_BITS);
    let lit_codes = canonical_codes(&lit_lens);
    let dist_codes = canonical_codes(&dist_lens);

    let mut w = BitWriter::new();
    for &l in lit_lens.iter().chain(dist_lens.iter()) {
        w.write(l as u32, 4);
    }
    for t in tokens {
        match *t {
            Token::Literal(b) => w.write_code(lit_codes[b as usize], lit_lens[b as usize] as u32),
            Token::Match { len, dist } => {
                let (sym, extra, bits) = len_symbol(len);
                w.write_code(lit_codes[sym], lit_lens[sym] as u32);
                w.write(extra, bits);
                let (dsym, dextra, dbits) = dist_symbol(dist);
                w.write_code(dist_codes[dsym], dist_lens[dsym] as u32);
                w.write(dextra, dbits);
            }
        }
    }
    w.write_code(lit_codes[END_OF_BLOCK], lit_lens[END_OF_BLOCK] as u32);
    w.finish()
}

pub fn decompress(input: &[u8]) -> Result<Vec<u8>, DecodeError> {
    if input.len() < 16 || &input[..4] != MAGIC {
        return Err(DecodeError::BadMagic);
    }
    let expected_len = u64::from_le_bytes(input[4..12].try_into().unwrap());
    let expected_crc = u32::from_le_bytes(input[12..16].try_into().unwrap());
    // Don't trust the header for allocation size: cap the up-front reservation.
    let mut out: Vec<u8> = Vec::with_capacity(expected_len.min(64 << 20) as usize);
    let mut p = 16;

    loop {
        let kind = *input.get(p).ok_or(DecodeError::Truncated)?;
        p += 1;
        if kind == 0xFF {
            break;
        }
        let len = u32::from_le_bytes(
            input
                .get(p..p + 4)
                .ok_or(DecodeError::Truncated)?
                .try_into()
                .unwrap(),
        ) as usize;
        p += 4;
        let body = input.get(p..p + len).ok_or(DecodeError::Truncated)?;
        p += len;
        match kind {
            0 => out.extend_from_slice(body),
            1 => decode_block(body, &mut out, expected_len)?,
            t => return Err(DecodeError::BadBlockType(t)),
        }
        if out.len() as u64 > expected_len {
            return Err(DecodeError::LengthMismatch {
                expected: expected_len,
                actual: out.len() as u64,
            });
        }
    }

    if out.len() as u64 != expected_len {
        return Err(DecodeError::LengthMismatch {
            expected: expected_len,
            actual: out.len() as u64,
        });
    }
    let actual = crc32(&out);
    if actual != expected_crc {
        return Err(DecodeError::ChecksumMismatch {
            expected: expected_crc,
            actual,
        });
    }
    Ok(out)
}

fn decode_block(body: &[u8], out: &mut Vec<u8>, limit: u64) -> Result<(), DecodeError> {
    let mut r = BitReader::new(body);
    let mut lens = [0u8; LITLEN_SYMBOLS + DIST_SYMBOLS];
    for l in lens.iter_mut() {
        *l = r.read(4).ok_or(DecodeError::Truncated)? as u8;
    }
    let lit = Decoder::new(&lens[..LITLEN_SYMBOLS]).ok_or(DecodeError::InvalidCode)?;
    let dist = Decoder::new(&lens[LITLEN_SYMBOLS..]).ok_or(DecodeError::InvalidCode)?;

    loop {
        let sym = lit.decode(|| r.bit()).ok_or(DecodeError::InvalidCode)? as usize;
        match sym {
            0..=255 => out.push(sym as u8),
            END_OF_BLOCK => return Ok(()),
            257..=285 => {
                let i = sym - 257;
                let len = LEN_BASE[i] as usize
                    + r.read(LEN_EXTRA[i] as u32).ok_or(DecodeError::Truncated)? as usize;
                let dsym = dist.decode(|| r.bit()).ok_or(DecodeError::InvalidCode)? as usize;
                if dsym >= DIST_SYMBOLS {
                    return Err(DecodeError::InvalidCode);
                }
                let d = DIST_BASE[dsym] as usize
                    + r.read(DIST_EXTRA[dsym] as u32)
                        .ok_or(DecodeError::Truncated)? as usize;
                if d > out.len() {
                    return Err(DecodeError::BadDistance);
                }
                if (out.len() + len) as u64 > limit {
                    return Err(DecodeError::LengthMismatch {
                        expected: limit,
                        actual: (out.len() + len) as u64,
                    });
                }
                let start = out.len() - d;
                if d >= len {
                    out.extend_from_within(start..start + len);
                } else {
                    for k in 0..len {
                        out.push(out[start + k]); // overlapping run
                    }
                }
            }
            _ => return Err(DecodeError::InvalidCode),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *seed >> 33
    }

    #[test]
    fn symbol_tables_cover_every_length_and_distance() {
        for len in 3..=258u16 {
            let (sym, extra, bits) = len_symbol(len);
            assert!((257..=285).contains(&sym));
            assert_eq!(LEN_BASE[sym - 257] + extra as u16, len);
            assert!(extra < (1 << bits) || bits == 0);
        }
        for dist in 1..=32768u32 {
            let (sym, extra, _) = dist_symbol(dist as u16);
            assert_eq!(DIST_BASE[sym] as u32 + extra, dist);
        }
    }

    #[test]
    fn round_trips() {
        let mut seed = 42;
        let random: Vec<u8> = (0..50_000).map(|_| lcg(&mut seed) as u8).collect();
        let text = include_str!("lib.rs").repeat(30).into_bytes();
        let skewed: Vec<u8> = (0..200_000)
            .map(|_| {
                if lcg(&mut seed).is_multiple_of(10) {
                    b'x'
                } else {
                    b'a'
                }
            })
            .collect();
        for data in [
            Vec::new(),
            vec![7u8],
            vec![0u8; 1_000_000],
            random,
            text,
            skewed,
        ] {
            for level in [1, 6, 9] {
                let c = compress_with(&data, Options::level(level));
                assert_eq!(
                    decompress(&c).unwrap(),
                    data,
                    "level {level}, len {}",
                    data.len()
                );
            }
        }
    }

    #[test]
    fn compresses_text_well_and_never_expands_much() {
        let text = include_str!("format.rs").repeat(10).into_bytes();
        assert!(compress(&text).len() * 8 < text.len());
        let mut seed = 7;
        let random: Vec<u8> = (0..100_000).map(|_| lcg(&mut seed) as u8).collect();
        assert!(
            compress(&random).len() <= random.len() + 64,
            "stored fallback should cap expansion"
        );
    }

    #[test]
    fn detects_corruption() {
        let data = b"hello hello hello hello hello world".repeat(100);
        let mut c = compress(&data);
        assert_eq!(decompress(b"nope"), Err(DecodeError::BadMagic));
        assert_eq!(decompress(&c[..c.len() - 5]), Err(DecodeError::Truncated));
        let mid = c.len() / 2;
        c[mid] ^= 0x55;
        assert!(decompress(&c).is_err());
    }
}
