package lsmkv

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"sort"
)

// SSTable file layout:
//
//	[data entries...] [sparse index] [bloom filter] [footer]
//
//	entry:  flags(1) | keyLen(uvarint) | valLen(uvarint) | key | value
//	index:  count(uvarint) then { keyLen(uvarint) | key | offset(uvarint) }
//	footer: indexOff(8) | bloomOff(8) | entries(8) | magic(4)
//
// Every indexInterval-th key is kept in the in-memory sparse index, so a
// point lookup reads at most indexInterval entries from disk.
const (
	indexInterval = 16
	footerSize    = 28
	sstMagic      = 0x4c534d31 // "LSM1"
	flagDeleted   = 1
)

type indexEntry struct {
	key    []byte
	offset int64
}

type sstable struct {
	path     string
	f        *os.File
	index    []indexEntry
	filter   *bloom
	dataEnd  int64
	entries  int
	smallest []byte
	largest  []byte
}

// writeSSTable writes sorted entries from it to path atomically (tmp + rename).
func writeSSTable(path string, it iterator, expected int, dropTombstones bool) (int, error) {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return 0, err
	}
	cleanup := func(err error) (int, error) {
		f.Close()
		os.Remove(tmp)
		return 0, err
	}

	w := bufio.NewWriterSize(f, 64<<10)
	filter := newBloom(expected, 10)
	var index []indexEntry
	var off int64
	n := 0
	var buf []byte
	for ; it.valid(); it.next() {
		e := it.entry()
		if dropTombstones && e.deleted {
			continue
		}
		if n%indexInterval == 0 {
			index = append(index, indexEntry{append([]byte(nil), e.key...), off})
		}
		filter.add(e.key)
		buf = buf[:0]
		var flags byte
		if e.deleted {
			flags = flagDeleted
		}
		buf = append(buf, flags)
		buf = binary.AppendUvarint(buf, uint64(len(e.key)))
		buf = binary.AppendUvarint(buf, uint64(len(e.value)))
		buf = append(buf, e.key...)
		buf = append(buf, e.value...)
		if _, err := w.Write(buf); err != nil {
			return cleanup(err)
		}
		off += int64(len(buf))
		n++
	}

	indexOff := off
	buf = binary.AppendUvarint(buf[:0], uint64(len(index)))
	for _, ie := range index {
		buf = binary.AppendUvarint(buf, uint64(len(ie.key)))
		buf = append(buf, ie.key...)
		buf = binary.AppendUvarint(buf, uint64(ie.offset))
	}
	bloomOff := indexOff + int64(len(buf))
	buf = append(buf, filter.encode()...)
	buf = binary.LittleEndian.AppendUint64(buf, uint64(indexOff))
	buf = binary.LittleEndian.AppendUint64(buf, uint64(bloomOff))
	buf = binary.LittleEndian.AppendUint64(buf, uint64(n))
	buf = binary.LittleEndian.AppendUint32(buf, sstMagic)
	if _, err := w.Write(buf); err != nil {
		return cleanup(err)
	}
	if err := w.Flush(); err != nil {
		return cleanup(err)
	}
	if err := f.Sync(); err != nil {
		return cleanup(err)
	}
	if err := f.Close(); err != nil {
		return cleanup(err)
	}
	return n, os.Rename(tmp, path)
}

func openSSTable(path string) (*sstable, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil || st.Size() < footerSize {
		f.Close()
		return nil, ErrCorrupt
	}
	var footer [footerSize]byte
	if _, err := f.ReadAt(footer[:], st.Size()-footerSize); err != nil {
		f.Close()
		return nil, err
	}
	if binary.LittleEndian.Uint32(footer[24:]) != sstMagic {
		f.Close()
		return nil, ErrCorrupt
	}
	indexOff := int64(binary.LittleEndian.Uint64(footer[0:]))
	bloomOff := int64(binary.LittleEndian.Uint64(footer[8:]))
	entries := int(binary.LittleEndian.Uint64(footer[16:]))
	if indexOff > bloomOff || bloomOff > st.Size()-footerSize {
		f.Close()
		return nil, ErrCorrupt
	}

	meta := make([]byte, st.Size()-footerSize-indexOff)
	if _, err := f.ReadAt(meta, indexOff); err != nil {
		f.Close()
		return nil, err
	}
	t := &sstable{path: path, f: f, dataEnd: indexOff, entries: entries}
	if t.index, err = decodeIndex(meta[:bloomOff-indexOff]); err != nil {
		f.Close()
		return nil, err
	}
	if t.filter, err = decodeBloom(meta[bloomOff-indexOff:]); err != nil {
		f.Close()
		return nil, err
	}
	if len(t.index) > 0 {
		t.smallest = t.index[0].key
		// Largest key: scan the last index block.
		it := t.iterFrom(len(t.index) - 1)
		for ; it.valid(); it.next() {
			t.largest = append(t.largest[:0], it.entry().key...)
		}
		if err := it.err; err != nil {
			f.Close()
			return nil, err
		}
	}
	return t, nil
}

func decodeIndex(p []byte) ([]indexEntry, error) {
	r := bytes.NewReader(p)
	n, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, ErrCorrupt
	}
	out := make([]indexEntry, 0, n)
	for i := uint64(0); i < n; i++ {
		kl, err := binary.ReadUvarint(r)
		if err != nil {
			return nil, ErrCorrupt
		}
		key := make([]byte, kl)
		if _, err := io.ReadFull(r, key); err != nil {
			return nil, ErrCorrupt
		}
		off, err := binary.ReadUvarint(r)
		if err != nil {
			return nil, ErrCorrupt
		}
		out = append(out, indexEntry{key, int64(off)})
	}
	return out, nil
}

// blockFor returns the index position whose block may contain key.
func (t *sstable) blockFor(key []byte) int {
	i := sort.Search(len(t.index), func(i int) bool { return bytes.Compare(t.index[i].key, key) > 0 })
	return i - 1
}

func (t *sstable) get(key []byte) (value []byte, deleted, found bool, err error) {
	if !t.filter.mayContain(key) {
		return nil, false, false, nil
	}
	b := t.blockFor(key)
	if b < 0 {
		return nil, false, false, nil
	}
	it := t.iterFrom(b)
	for i := 0; i < indexInterval && it.valid(); i++ {
		e := it.entry()
		switch c := bytes.Compare(e.key, key); {
		case c == 0:
			return e.value, e.deleted, true, nil
		case c > 0:
			return nil, false, false, nil
		}
		it.next()
	}
	return nil, false, false, it.err
}

func (t *sstable) close() error { return t.f.Close() }

type sstIter struct {
	r   *bufio.Reader
	cur entry
	ok  bool
	pos int64
	end int64
	err error
}

func (t *sstable) iterFrom(block int) *sstIter {
	off := int64(0)
	if block >= 0 && block < len(t.index) {
		off = t.index[block].offset
	}
	it := &sstIter{r: bufio.NewReader(io.NewSectionReader(t.f, off, t.dataEnd-off)), pos: off, end: t.dataEnd}
	it.next()
	return it
}

// iter returns an iterator positioned at the first key >= start.
func (t *sstable) iter(start []byte) iterator {
	b := 0
	if start != nil {
		if b = t.blockFor(start); b < 0 {
			b = 0
		}
	}
	it := t.iterFrom(b)
	for it.valid() && start != nil && bytes.Compare(it.cur.key, start) < 0 {
		it.next()
	}
	return it
}

func (it *sstIter) valid() bool  { return it.ok }
func (it *sstIter) entry() entry { return it.cur }
func (it *sstIter) close() error { return it.err }

func (it *sstIter) next() {
	it.ok = false
	if it.pos >= it.end {
		return
	}
	flags, err := it.r.ReadByte()
	if err != nil {
		it.setErr(err)
		return
	}
	kl, err1 := binary.ReadUvarint(it.r)
	vl, err2 := binary.ReadUvarint(it.r)
	if err1 != nil || err2 != nil {
		it.setErr(ErrCorrupt)
		return
	}
	data := make([]byte, kl+vl)
	if _, err := io.ReadFull(it.r, data); err != nil {
		it.setErr(err)
		return
	}
	it.cur = entry{key: data[:kl], value: data[kl:], deleted: flags&flagDeleted != 0}
	it.pos += int64(1+uvarintLen(kl)+uvarintLen(vl)) + int64(kl+vl)
	it.ok = true
}

func (it *sstIter) setErr(err error) {
	if !errors.Is(err, io.EOF) {
		it.err = err
	}
}

func uvarintLen(x uint64) int {
	n := 1
	for x >= 0x80 {
		x >>= 7
		n++
	}
	return n
}
