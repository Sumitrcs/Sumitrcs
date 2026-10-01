/// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) — the checksum used by zip, gzip and PNG.
pub fn crc32(data: &[u8]) -> u32 {
    const TABLE: [u32; 256] = make_table();
    let mut crc = !0u32;
    for &b in data {
        crc = TABLE[((crc ^ b as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

const fn make_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

#[cfg(test)]
mod tests {
    #[test]
    fn known_vectors() {
        assert_eq!(super::crc32(b""), 0);
        assert_eq!(super::crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(
            super::crc32(b"The quick brown fox jumps over the lazy dog"),
            0x414F_A339
        );
    }
}
