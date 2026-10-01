/// LSB-first bit writer (the same bit order DEFLATE uses).
#[derive(Default)]
pub struct BitWriter {
    out: Vec<u8>,
    acc: u64,
    n: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends the low `count` bits of `value`, least significant first.
    pub fn write(&mut self, value: u32, count: u32) {
        debug_assert!(count <= 32 && (count == 32 || value >> count == 0));
        self.acc |= (value as u64) << self.n;
        self.n += count;
        while self.n >= 8 {
            self.out.push(self.acc as u8);
            self.acc >>= 8;
            self.n -= 8;
        }
    }

    /// Huffman codes are defined MSB-first, so they are written bit-reversed.
    pub fn write_code(&mut self, code: u32, len: u32) {
        self.write(code.reverse_bits() >> (32 - len), len);
    }

    pub fn finish(mut self) -> Vec<u8> {
        if self.n > 0 {
            self.out.push(self.acc as u8);
        }
        self.out
    }
}

pub struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    acc: u64,
    n: u32,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        BitReader {
            data,
            pos: 0,
            acc: 0,
            n: 0,
        }
    }

    fn refill(&mut self) {
        while self.n <= 56 && self.pos < self.data.len() {
            self.acc |= (self.data[self.pos] as u64) << self.n;
            self.pos += 1;
            self.n += 8;
        }
    }

    pub fn read(&mut self, count: u32) -> Option<u32> {
        if count == 0 {
            return Some(0);
        }
        if self.n < count {
            self.refill();
            if self.n < count {
                return None;
            }
        }
        let v = (self.acc & ((1u64 << count) - 1)) as u32;
        self.acc >>= count;
        self.n -= count;
        Some(v)
    }

    pub fn bit(&mut self) -> Option<u32> {
        self.read(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_mixed_widths() {
        let mut w = BitWriter::new();
        let items = [
            (1, 1),
            (5, 3),
            (0x3ff, 10),
            (0, 7),
            (0xdead_beef, 32),
            (3, 2),
        ];
        for (v, c) in items {
            w.write(v, c);
        }
        w.write_code(0b110, 3);
        let bytes = w.finish();
        let mut r = BitReader::new(&bytes);
        for (v, c) in items {
            assert_eq!(r.read(c), Some(v));
        }
        assert_eq!((r.bit(), r.bit(), r.bit()), (Some(1), Some(1), Some(0)));
    }
}
