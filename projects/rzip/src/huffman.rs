use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub const MAX_BITS: usize = 15;

/// Computes code lengths (≤ `limit`) for the given symbol frequencies.
/// Unused symbols get length 0. A lone used symbol gets length 1.
pub fn code_lengths(freqs: &[u32], limit: usize) -> Vec<u8> {
    let mut f: Vec<u64> = freqs.iter().map(|&x| x as u64).collect();
    loop {
        let lens = build(&f);
        if lens.iter().all(|&l| (l as usize) <= limit) {
            return lens;
        }
        // Too deep: flatten the distribution and try again. Halving while
        // keeping every used symbol non-zero converges quickly in practice.
        for x in f.iter_mut().filter(|x| **x > 0) {
            *x = (*x >> 1) | 1;
        }
    }
}

fn build(freqs: &[u64]) -> Vec<u8> {
    let used: Vec<usize> = (0..freqs.len()).filter(|&i| freqs[i] > 0).collect();
    let mut lens = vec![0u8; freqs.len()];
    match used.len() {
        0 => return lens,
        1 => {
            lens[used[0]] = 1;
            return lens;
        }
        _ => {}
    }
    // Nodes: leaves first, then internal nodes. parent[] lets us read depths.
    let mut parent = vec![usize::MAX; used.len() * 2];
    let mut heap: BinaryHeap<Reverse<(u64, usize)>> = used
        .iter()
        .enumerate()
        .map(|(i, &s)| Reverse((freqs[s], i)))
        .collect();
    let mut next = used.len();
    while heap.len() > 1 {
        let Reverse((fa, a)) = heap.pop().unwrap();
        let Reverse((fb, b)) = heap.pop().unwrap();
        parent[a] = next;
        parent[b] = next;
        heap.push(Reverse((fa + fb, next)));
        next += 1;
    }
    for (i, &sym) in used.iter().enumerate() {
        let mut depth = 0u8;
        let mut n = i;
        while parent[n] != usize::MAX {
            n = parent[n];
            depth += 1;
        }
        lens[sym] = depth;
    }
    lens
}

/// Assigns canonical codes: shorter codes first, ties broken by symbol order.
pub fn canonical_codes(lens: &[u8]) -> Vec<u32> {
    let mut bl_count = [0u32; MAX_BITS + 1];
    for &l in lens {
        bl_count[l as usize] += 1;
    }
    bl_count[0] = 0;
    let mut next = [0u32; MAX_BITS + 2];
    let mut code = 0u32;
    for bits in 1..=MAX_BITS {
        code = (code + bl_count[bits - 1]) << 1;
        next[bits] = code;
    }
    lens.iter()
        .map(|&l| {
            if l == 0 {
                0
            } else {
                let c = next[l as usize];
                next[l as usize] += 1;
                c
            }
        })
        .collect()
}

/// Canonical Huffman decoder (count/symbol tables, as in zlib's `puff`).
pub struct Decoder {
    counts: [u16; MAX_BITS + 1],
    symbols: Vec<u16>,
}

impl Decoder {
    /// Returns None if the lengths describe an over-subscribed (invalid) code.
    pub fn new(lens: &[u8]) -> Option<Decoder> {
        let mut counts = [0u16; MAX_BITS + 1];
        for &l in lens {
            if l as usize > MAX_BITS {
                return None;
            }
            counts[l as usize] += 1;
        }
        counts[0] = 0;
        let mut left: i32 = 1;
        for &c in counts.iter().skip(1) {
            left = (left << 1) - c as i32;
            if left < 0 {
                return None;
            }
        }
        let mut offs = [0u16; MAX_BITS + 2];
        for len in 1..=MAX_BITS {
            offs[len + 1] = offs[len] + counts[len];
        }
        let mut symbols = vec![0u16; lens.len()];
        for (sym, &l) in lens.iter().enumerate() {
            if l != 0 {
                symbols[offs[l as usize] as usize] = sym as u16;
                offs[l as usize] += 1;
            }
        }
        Some(Decoder { counts, symbols })
    }

    pub fn decode(&self, mut next_bit: impl FnMut() -> Option<u32>) -> Option<u16> {
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for len in 1..=MAX_BITS {
            code |= next_bit()? as i32;
            let count = self.counts[len] as i32;
            if code - count < first {
                return Some(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_respect_limit_and_kraft() {
        // Fibonacci frequencies produce a maximally skewed tree.
        let mut f = vec![1u32, 1];
        while f.len() < 30 {
            let n = f[f.len() - 1] + f[f.len() - 2];
            f.push(n);
        }
        let lens = code_lengths(&f, 15);
        assert!(lens.iter().all(|&l| (1..=15).contains(&l)));
        let kraft: f64 = lens.iter().map(|&l| 0.5f64.powi(l as i32)).sum();
        assert!(kraft <= 1.0 + 1e-12);
    }

    #[test]
    fn canonical_codes_are_prefix_free_and_decodable() {
        let freqs = [5u32, 9, 12, 13, 16, 45, 0, 1];
        let lens = code_lengths(&freqs, 15);
        let codes = canonical_codes(&lens);
        let dec = Decoder::new(&lens).unwrap();
        for (sym, (&c, &l)) in codes.iter().zip(&lens).enumerate() {
            if l == 0 {
                continue;
            }
            let mut bits = (0..l).rev().map(|i| (c >> i) & 1);
            assert_eq!(dec.decode(|| bits.next()), Some(sym as u16));
        }
    }

    #[test]
    fn rejects_oversubscribed_codes() {
        assert!(Decoder::new(&[1, 1, 1]).is_none());
    }
}
