pub const WINDOW: usize = 1 << 15;
pub const MIN_MATCH: usize = 3;
pub const MAX_MATCH: usize = 258;
const HASH_BITS: u32 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Token {
    Literal(u8),
    Match { len: u16, dist: u16 },
}

/// Hash-chain match finder over a sliding 32 KiB window, with one-step
/// lazy evaluation: if the next position has a longer match, emit a literal
/// now and take the better match instead (what gzip -6 does).
pub fn tokenize(data: &[u8], max_chain: usize) -> Vec<Token> {
    let n = data.len();
    let mut tokens = Vec::with_capacity(n / 2);
    let mut head = vec![u32::MAX; 1 << HASH_BITS];
    let mut prev = vec![u32::MAX; WINDOW];

    let hash = |i: usize| -> usize {
        let v = (data[i] as u32) << 16 | (data[i + 1] as u32) << 8 | data[i + 2] as u32;
        (v.wrapping_mul(2_654_435_761) >> (32 - HASH_BITS)) as usize
    };
    let insert = |i: usize, head: &mut Vec<u32>, prev: &mut Vec<u32>| {
        if i + MIN_MATCH <= n {
            let h = hash(i);
            prev[i % WINDOW] = head[h];
            head[h] = i as u32;
        }
    };
    let longest = |i: usize, head: &Vec<u32>, prev: &Vec<u32>| -> (usize, usize) {
        if i + MIN_MATCH > n {
            return (0, 0);
        }
        let max_len = MAX_MATCH.min(n - i);
        let (mut best_len, mut best_dist) = (0, 0);
        let mut cand = head[hash(i)];
        let mut chain = max_chain;
        while cand != u32::MAX && chain > 0 {
            let c = cand as usize;
            if c >= i || i - c > WINDOW - 1 {
                break;
            }
            // Quick reject: the byte that would extend the best match must agree.
            if data[c + best_len.min(max_len - 1)] == data[i + best_len.min(max_len - 1)] {
                let mut l = 0;
                while l < max_len && data[c + l] == data[i + l] {
                    l += 1;
                }
                if l > best_len {
                    best_len = l;
                    best_dist = i - c;
                    if l == max_len {
                        break;
                    }
                }
            }
            cand = prev[c % WINDOW];
            chain -= 1;
        }
        if best_len >= MIN_MATCH {
            (best_len, best_dist)
        } else {
            (0, 0)
        }
    };

    let mut i = 0;
    while i < n {
        let (len, dist) = longest(i, &head, &prev);
        if len == 0 {
            insert(i, &mut head, &mut prev);
            tokens.push(Token::Literal(data[i]));
            i += 1;
            continue;
        }
        insert(i, &mut head, &mut prev);
        if len < MAX_MATCH / 2 && i + 1 < n {
            let (next_len, _) = longest(i + 1, &head, &prev);
            if next_len > len {
                tokens.push(Token::Literal(data[i]));
                i += 1;
                continue;
            }
        }
        tokens.push(Token::Match {
            len: len as u16,
            dist: dist as u16,
        });
        for k in i + 1..i + len {
            insert(k, &mut head, &mut prev);
        }
        i += len;
    }
    tokens
}

/// Reconstructs data from tokens (the real decoder works on Huffman symbols directly).
#[cfg(test)]
pub fn detokenize(tokens: &[Token]) -> Vec<u8> {
    let mut out = Vec::new();
    for t in tokens {
        match *t {
            Token::Literal(b) => out.push(b),
            Token::Match { len, dist } => {
                let start = out.len() - dist as usize;
                for k in 0..len as usize {
                    out.push(out[start + k]); // byte-by-byte: overlapping copies are valid
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_repeats_and_overlapping_runs() {
        let data = b"abcabcabcabcXaaaaaaaaaaaaaaaa";
        let t = tokenize(data, 64);
        assert!(t.iter().any(|t| matches!(t, Token::Match { dist: 3, .. })));
        assert!(t.iter().any(|t| matches!(t, Token::Match { dist: 1, .. })));
        assert_eq!(detokenize(&t), data);
    }

    #[test]
    fn respects_window_and_length_limits() {
        let mut data = vec![0u8; 100_000];
        for (i, b) in data.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        let t = tokenize(&data, 32);
        for tok in &t {
            if let Token::Match { len, dist } = tok {
                assert!((*len as usize) <= MAX_MATCH && (*dist as usize) < WINDOW);
            }
        }
        assert_eq!(detokenize(&t), data);
    }
}
