//! rzip — a lossless compressor built from first principles.
//!
//! Pipeline: **LZ77** (hash chains + lazy matching over a 32 KiB window)
//! turns input into literals and back-references; those tokens are then
//! **Huffman coded** with canonical, length-limited codes using the same
//! length/distance alphabets as DEFLATE. Each block carries its own code
//! tables and falls back to a stored block when compression wouldn't help.
//! The container stores the original size and a CRC-32 checked on decode.
//!
//! ```
//! let data = b"to be or not to be, that is the question".repeat(200);
//! let packed = rzip::compress(&data);
//! assert!(packed.len() < data.len() / 5);
//! assert_eq!(rzip::decompress(&packed).unwrap(), data);
//! ```

mod bits;
mod crc32;
mod format;
mod huffman;
mod lz77;

pub use crc32::crc32;
pub use format::{DecodeError, Options, compress, compress_with, decompress};
pub use lz77::Token;
