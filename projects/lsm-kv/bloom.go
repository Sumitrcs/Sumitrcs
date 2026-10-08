package lsmkv

import (
	"encoding/binary"
	"hash/fnv"
	"math"
)

// bloom is a classic Bloom filter using Kirsch–Mitzenmacher double hashing:
// the k probe positions are h1 + i*h2, derived from one 64-bit FNV hash.
type bloom struct {
	bits []byte
	k    uint8
}

func newBloom(n int, bitsPerKey int) *bloom {
	if n < 1 {
		n = 1
	}
	m := n * bitsPerKey
	if m < 64 {
		m = 64
	}
	// Optimal k = (m/n) * ln2
	k := uint8(math.Round(float64(bitsPerKey) * math.Ln2))
	if k < 1 {
		k = 1
	}
	if k > 30 {
		k = 30
	}
	return &bloom{bits: make([]byte, (m+7)/8), k: k}
}

func hashes(key []byte) (uint32, uint32) {
	h := fnv.New64a()
	h.Write(key)
	sum := h.Sum64()
	return uint32(sum), uint32(sum>>32) | 1 // odd step so probes cover all bits
}

func (b *bloom) add(key []byte) {
	h1, h2 := hashes(key)
	m := uint32(len(b.bits) * 8)
	for i := uint32(0); i < uint32(b.k); i++ {
		pos := (h1 + i*h2) % m
		b.bits[pos/8] |= 1 << (pos % 8)
	}
}

func (b *bloom) mayContain(key []byte) bool {
	h1, h2 := hashes(key)
	m := uint32(len(b.bits) * 8)
	for i := uint32(0); i < uint32(b.k); i++ {
		pos := (h1 + i*h2) % m
		if b.bits[pos/8]&(1<<(pos%8)) == 0 {
			return false
		}
	}
	return true
}

func (b *bloom) encode() []byte {
	out := make([]byte, 0, len(b.bits)+5)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(b.bits)))
	out = append(out, b.k)
	return append(out, b.bits...)
}

func decodeBloom(p []byte) (*bloom, error) {
	if len(p) < 5 {
		return nil, ErrCorrupt
	}
	n := binary.LittleEndian.Uint32(p)
	if int(n)+5 != len(p) {
		return nil, ErrCorrupt
	}
	return &bloom{k: p[4], bits: append([]byte(nil), p[5:]...)}, nil
}
