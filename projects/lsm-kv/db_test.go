package lsmkv

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
)

func key(i int) []byte { return []byte(fmt.Sprintf("key-%06d", i)) }

func mustOpen(t *testing.T, dir string, o *Options) *DB {
	t.Helper()
	db, err := Open(dir, o)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func TestPutGetDelete(t *testing.T) {
	db := mustOpen(t, t.TempDir(), nil)
	defer db.Close()

	if err := db.Put([]byte("a"), []byte("1")); err != nil {
		t.Fatal(err)
	}
	db.Put([]byte("a"), []byte("2"))
	if v, _ := db.Get([]byte("a")); string(v) != "2" {
		t.Fatalf("got %q", v)
	}
	db.Delete([]byte("a"))
	if _, err := db.Get([]byte("a")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if err := db.Put(nil, []byte("x")); !errors.Is(err, ErrEmptyKey) {
		t.Fatal("empty key should be rejected")
	}
}

// Compare the DB against a plain map across flushes and compactions.
func TestRandomizedAgainstMap(t *testing.T) {
	dir := t.TempDir()
	db := mustOpen(t, dir, &Options{MemtableSize: 8 << 10, CompactAt: 3})
	model := map[string]string{}
	r := rand.New(rand.NewPCG(42, 7))

	for i := 0; i < 20000; i++ {
		k := key(r.IntN(3000))
		switch r.IntN(10) {
		case 0, 1:
			if err := db.Delete(k); err != nil {
				t.Fatal(err)
			}
			delete(model, string(k))
		default:
			v := fmt.Sprintf("v%d", i)
			if err := db.Put(k, []byte(v)); err != nil {
				t.Fatal(err)
			}
			model[string(k)] = v
		}
	}
	st := db.Stats()
	if st.Flushes == 0 || st.Compactions == 0 {
		t.Fatalf("expected flushes and compactions, got %+v", st)
	}
	verify(t, db, model)

	// Reopen and verify again: data must survive via SSTables + WAL.
	db.Close()
	db = mustOpen(t, dir, &Options{MemtableSize: 8 << 10, CompactAt: 3})
	defer db.Close()
	verify(t, db, model)
}

func verify(t *testing.T, db *DB, model map[string]string) {
	t.Helper()
	for i := 0; i < 3000; i++ {
		k := key(i)
		v, err := db.Get(k)
		want, ok := model[string(k)]
		if ok && (err != nil || string(v) != want) {
			t.Fatalf("Get(%s) = %q, %v; want %q", k, v, err, want)
		}
		if !ok && !errors.Is(err, ErrNotFound) {
			t.Fatalf("Get(%s) = %q, %v; want not found", k, v, err)
		}
	}
	var keys []string
	for k := range model {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var got []string
	err := db.Scan(nil, nil, func(k, v []byte) bool {
		if model[string(k)] != string(v) {
			t.Fatalf("scan value mismatch for %s", k)
		}
		got = append(got, string(k))
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(keys) {
		t.Fatalf("scan returned %d keys, want %d", len(got), len(keys))
	}
	for i := range keys {
		if keys[i] != got[i] {
			t.Fatalf("scan order mismatch at %d: %s vs %s", i, got[i], keys[i])
		}
	}
}

func TestRecoveryFromWALWithoutClose(t *testing.T) {
	dir := t.TempDir()
	db := mustOpen(t, dir, nil)
	for i := 0; i < 100; i++ {
		db.Put(key(i), []byte("x"))
	}
	db.Delete(key(5))
	// Simulate a crash: drop the handle without Close.
	db.log.f.Close()

	db2 := mustOpen(t, dir, nil)
	defer db2.Close()
	if _, err := db2.Get(key(99)); err != nil {
		t.Fatal("lost write after crash")
	}
	if _, err := db2.Get(key(5)); !errors.Is(err, ErrNotFound) {
		t.Fatal("lost delete after crash")
	}
}

func TestTornWALTailIsIgnored(t *testing.T) {
	dir := t.TempDir()
	db := mustOpen(t, dir, nil)
	db.Put([]byte("good"), []byte("1"))
	db.Close()

	f, _ := os.OpenFile(filepath.Join(dir, walName), os.O_APPEND|os.O_WRONLY, 0)
	f.Write([]byte{0xde, 0xad, 0xbe}) // half a header
	f.Close()

	db = mustOpen(t, dir, nil)
	defer db.Close()
	if v, err := db.Get([]byte("good")); err != nil || string(v) != "1" {
		t.Fatalf("got %q, %v", v, err)
	}
	// New writes after a torn tail must still be readable after reopening.
	db.Put([]byte("after"), []byte("2"))
	db.Close()
	db = mustOpen(t, dir, nil)
	if v, _ := db.Get([]byte("after")); string(v) != "2" {
		t.Fatal("write after torn tail lost")
	}
}

func TestDeletedKeysStayDeletedAfterCompaction(t *testing.T) {
	db := mustOpen(t, t.TempDir(), &Options{CompactAt: 100})
	defer db.Close()
	db.Put([]byte("k"), []byte("old"))
	db.Flush()
	db.Delete([]byte("k"))
	db.Flush()
	if err := db.Compact(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Get([]byte("k")); !errors.Is(err, ErrNotFound) {
		t.Fatal("tombstone lost: deleted key resurrected")
	}
	if db.Stats().Tables != 1 {
		t.Fatal("expected a single table after compaction")
	}
}

func TestInterruptedCompactionLeftoversAreIgnored(t *testing.T) {
	dir := t.TempDir()
	db := mustOpen(t, dir, &Options{CompactAt: 100})
	db.Put([]byte("k"), []byte("v"))
	db.Flush()
	db.Close()
	// A stray table not in the manifest (e.g. crash before manifest write).
	os.WriteFile(filepath.Join(dir, "000099.sst"), []byte("garbage"), 0o644)
	os.WriteFile(filepath.Join(dir, "000100.sst.tmp"), []byte("garbage"), 0o644)

	db = mustOpen(t, dir, nil)
	defer db.Close()
	if v, _ := db.Get([]byte("k")); string(v) != "v" {
		t.Fatal("lost data")
	}
	if _, err := os.Stat(filepath.Join(dir, "000099.sst")); !os.IsNotExist(err) {
		t.Fatal("orphan table should be removed")
	}
}

func TestScanRange(t *testing.T) {
	db := mustOpen(t, t.TempDir(), &Options{MemtableSize: 1 << 10})
	defer db.Close()
	for i := 0; i < 500; i++ {
		db.Put(key(i), []byte{byte(i)})
	}
	var got [][]byte
	db.Scan(key(100), key(110), func(k, _ []byte) bool {
		got = append(got, append([]byte(nil), k...))
		return true
	})
	if len(got) != 10 || !bytes.Equal(got[0], key(100)) || !bytes.Equal(got[9], key(109)) {
		t.Fatalf("unexpected range: %q", got)
	}
	n := 0
	db.Scan(nil, nil, func(_, _ []byte) bool { n++; return n < 5 })
	if n != 5 {
		t.Fatal("early stop not honoured")
	}
}

func TestConcurrentReadersAndWriters(t *testing.T) {
	db := mustOpen(t, t.TempDir(), &Options{MemtableSize: 4 << 10})
	defer db.Close()
	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				db.Put([]byte(fmt.Sprintf("w%d-%d", w, i)), []byte("v"))
				db.Get([]byte(fmt.Sprintf("w%d-%d", (w+1)%4, i)))
			}
		}(w)
	}
	wg.Wait()
	count := 0
	db.Scan(nil, nil, func(_, _ []byte) bool { count++; return true })
	if count != 2000 {
		t.Fatalf("count = %d", count)
	}
}

func TestBloomFalsePositiveRate(t *testing.T) {
	b := newBloom(10000, 10)
	for i := 0; i < 10000; i++ {
		b.add(key(i))
	}
	for i := 0; i < 10000; i++ {
		if !b.mayContain(key(i)) {
			t.Fatal("bloom filter must never return a false negative")
		}
	}
	fp := 0
	for i := 10000; i < 110000; i++ {
		if b.mayContain(key(i)) {
			fp++
		}
	}
	if rate := float64(fp) / 100000; rate > 0.02 {
		t.Fatalf("false positive rate %.4f too high", rate)
	}
}

func BenchmarkPut(b *testing.B) {
	db, _ := Open(b.TempDir(), nil)
	defer db.Close()
	v := bytes.Repeat([]byte("x"), 100)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		db.Put(key(i), v)
	}
}

func BenchmarkGet(b *testing.B) {
	db, _ := Open(b.TempDir(), &Options{MemtableSize: 256 << 10})
	defer db.Close()
	for i := 0; i < 50000; i++ {
		db.Put(key(i), []byte("value"))
	}
	db.Flush()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		db.Get(key(i % 50000))
	}
}
