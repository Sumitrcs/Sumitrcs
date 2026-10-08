// Package lsmkv is an embeddable key-value store built on a log-structured
// merge tree: writes go to a write-ahead log and an in-memory skip list,
// which is flushed to immutable sorted files (SSTables) and periodically
// compacted.
package lsmkv

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	ErrNotFound = errors.New("lsmkv: key not found")
	ErrCorrupt  = errors.New("lsmkv: corrupt data")
	ErrClosed   = errors.New("lsmkv: database closed")
	ErrEmptyKey = errors.New("lsmkv: empty key")
)

type Options struct {
	// MemtableSize is the approximate size in bytes at which the memtable
	// is flushed to an SSTable. Default 4 MiB.
	MemtableSize int
	// CompactAt triggers a full compaction once this many SSTables exist. Default 4.
	CompactAt int
	// SyncWrites fsyncs the WAL after every write. Slower but survives power loss.
	SyncWrites bool
}

type DB struct {
	mu      sync.RWMutex
	dir     string
	opts    Options
	mem     *memtable
	log     *wal
	tables  []*sstable // newest first
	nextSeq int
	closed  bool
	stats   Stats
}

type Stats struct {
	Flushes     int
	Compactions int
	Tables      int
	MemEntries  int
}

const (
	walName      = "wal.log"
	manifestName = "MANIFEST"
)

// Open opens (or creates) a database in dir, replaying the WAL to recover
// any writes that were not yet flushed.
func Open(dir string, opts *Options) (*DB, error) {
	o := Options{MemtableSize: 4 << 20, CompactAt: 4}
	if opts != nil {
		if opts.MemtableSize > 0 {
			o.MemtableSize = opts.MemtableSize
		}
		if opts.CompactAt > 1 {
			o.CompactAt = opts.CompactAt
		}
		o.SyncWrites = opts.SyncWrites
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}

	db := &DB{dir: dir, opts: o, mem: newMemtable()}
	if err := db.loadTables(); err != nil {
		db.closeTables()
		return nil, err
	}

	walPath := filepath.Join(dir, walName)
	err := replayWAL(walPath, func(kind byte, key, value []byte) {
		k := append([]byte(nil), key...)
		v := append([]byte(nil), value...)
		db.mem.put(k, v, kind == kindDel)
	})
	if err != nil {
		db.closeTables()
		return nil, fmt.Errorf("replaying WAL: %w", err)
	}
	if db.log, err = openWAL(walPath, o.SyncWrites); err != nil {
		db.closeTables()
		return nil, err
	}
	return db, nil
}

// loadTables opens the tables listed in the manifest and deletes leftovers
// from interrupted flushes or compactions.
func (db *DB) loadTables() error {
	live := map[string]bool{}
	data, err := os.ReadFile(filepath.Join(db.dir, manifestName))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	names := strings.Fields(string(data)) // newest first
	for _, n := range names {
		live[n] = true
		var seq int
		if _, err := fmt.Sscanf(n, "%06d.sst", &seq); err == nil && seq >= db.nextSeq {
			db.nextSeq = seq + 1
		}
	}

	files, err := os.ReadDir(db.dir)
	if err != nil {
		return err
	}
	for _, f := range files {
		name := f.Name()
		if (strings.HasSuffix(name, ".sst") && !live[name]) || strings.HasSuffix(name, ".tmp") {
			os.Remove(filepath.Join(db.dir, name))
		}
	}

	for _, n := range names {
		t, err := openSSTable(filepath.Join(db.dir, n))
		if err != nil {
			return fmt.Errorf("opening %s: %w", n, err)
		}
		db.tables = append(db.tables, t)
	}
	return nil
}

func (db *DB) writeManifest() error {
	var b strings.Builder
	for _, t := range db.tables {
		b.WriteString(filepath.Base(t.path))
		b.WriteByte('\n')
	}
	tmp := filepath.Join(db.dir, manifestName+".tmp")
	if err := os.WriteFile(tmp, []byte(b.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(db.dir, manifestName))
}

func (db *DB) Put(key, value []byte) error { return db.write(kindPut, key, value) }
func (db *DB) Delete(key []byte) error     { return db.write(kindDel, key, nil) }

func (db *DB) write(kind byte, key, value []byte) error {
	if len(key) == 0 {
		return ErrEmptyKey
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.closed {
		return ErrClosed
	}
	if err := db.log.append(kind, key, value); err != nil {
		return err
	}
	db.mem.put(append([]byte(nil), key...), append([]byte(nil), value...), kind == kindDel)
	if db.mem.size >= db.opts.MemtableSize {
		return db.flushLocked()
	}
	return nil
}

// Get returns the newest value for key or ErrNotFound.
func (db *DB) Get(key []byte) ([]byte, error) {
	db.mu.RLock()
	defer db.mu.RUnlock()
	if db.closed {
		return nil, ErrClosed
	}
	if v, deleted, ok := db.mem.get(key); ok {
		if deleted {
			return nil, ErrNotFound
		}
		return append([]byte(nil), v...), nil
	}
	for _, t := range db.tables {
		if bytes.Compare(key, t.smallest) < 0 || bytes.Compare(key, t.largest) > 0 {
			continue
		}
		v, deleted, ok, err := t.get(key)
		if err != nil {
			return nil, err
		}
		if ok {
			if deleted {
				return nil, ErrNotFound
			}
			return v, nil
		}
	}
	return nil, ErrNotFound
}

// Scan calls fn for each live key in [start, end) in ascending order.
// A nil end means "to the last key". Returning false from fn stops the scan.
func (db *DB) Scan(start, end []byte, fn func(key, value []byte) bool) error {
	db.mu.RLock()
	defer db.mu.RUnlock()
	if db.closed {
		return ErrClosed
	}
	sources := []iterator{db.mem.iter(start)}
	for _, t := range db.tables {
		sources = append(sources, t.iter(start))
	}
	it := newMergeIter(sources)
	for ; it.valid(); it.next() {
		e := it.entry()
		if end != nil && bytes.Compare(e.key, end) >= 0 {
			break
		}
		if e.deleted {
			continue
		}
		if !fn(e.key, e.value) {
			break
		}
	}
	return it.close()
}

// Flush forces the memtable to disk.
func (db *DB) Flush() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.closed {
		return ErrClosed
	}
	return db.flushLocked()
}

func (db *DB) flushLocked() error {
	if db.mem.count == 0 {
		return nil
	}
	path := filepath.Join(db.dir, fmt.Sprintf("%06d.sst", db.nextSeq))
	if _, err := writeSSTable(path, db.mem.iter(nil), db.mem.count, false); err != nil {
		return err
	}
	t, err := openSSTable(path)
	if err != nil {
		return err
	}
	db.nextSeq++
	db.tables = append([]*sstable{t}, db.tables...)
	if err := db.writeManifest(); err != nil {
		return err
	}

	// The data is durable in the SSTable; start a fresh WAL.
	if err := db.log.close(); err != nil {
		return err
	}
	walPath := filepath.Join(db.dir, walName)
	if err := os.Remove(walPath); err != nil {
		return err
	}
	if db.log, err = openWAL(walPath, db.opts.SyncWrites); err != nil {
		return err
	}
	db.mem = newMemtable()
	db.stats.Flushes++

	if len(db.tables) >= db.opts.CompactAt {
		return db.compactLocked()
	}
	return nil
}

// Compact merges every SSTable into one, discarding overwritten values and
// tombstones.
func (db *DB) Compact() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.closed {
		return ErrClosed
	}
	return db.compactLocked()
}

func (db *DB) compactLocked() error {
	if len(db.tables) < 2 {
		return nil
	}
	sources := make([]iterator, len(db.tables))
	total := 0
	for i, t := range db.tables {
		sources[i] = t.iter(nil)
		total += t.entries
	}
	merged := newMergeIter(sources)
	path := filepath.Join(db.dir, fmt.Sprintf("%06d.sst", db.nextSeq))
	// All tables participate, so this is the bottom level: tombstones can go.
	_, err := writeSSTable(path, merged, total, true)
	if cerr := merged.close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	t, err := openSSTable(path)
	if err != nil {
		return err
	}
	db.nextSeq++
	old := db.tables
	db.tables = []*sstable{t}
	if err := db.writeManifest(); err != nil {
		return err
	}
	for _, o := range old {
		o.close()
		os.Remove(o.path)
	}
	db.stats.Compactions++
	return nil
}

func (db *DB) Stats() Stats {
	db.mu.RLock()
	defer db.mu.RUnlock()
	s := db.stats
	s.Tables = len(db.tables)
	s.MemEntries = db.mem.count
	return s
}

func (db *DB) closeTables() {
	for _, t := range db.tables {
		t.close()
	}
}

// Close flushes the WAL buffer and releases file handles. Unflushed memtable
// data stays in the WAL and is recovered on the next Open.
func (db *DB) Close() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.closed {
		return nil
	}
	db.closed = true
	err := db.log.close()
	db.closeTables()
	return err
}
