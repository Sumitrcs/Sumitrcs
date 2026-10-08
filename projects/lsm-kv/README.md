# lsm-kv

[![CI](https://github.com/Sumitrcs/lsm-kv/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/lsm-kv/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

An embeddable, crash-safe **key-value storage engine** in pure Go, built on a
**log-structured merge tree** — the same design behind LevelDB, RocksDB and
Cassandra. Zero dependencies, about 1,000 lines, heavily commented.

I built it to really understand how databases turn random writes into
sequential disk I/O and still serve fast reads.

## Architecture

```
            Put / Delete
                 │
      ┌──────────▼──────────┐       ┌────────────┐
      │  Write-ahead log    │──────▶│  wal.log   │  CRC32 per record
      └──────────┬──────────┘       └────────────┘
                 │
      ┌──────────▼──────────┐
      │  Memtable           │  skip list, newest version per key
      │  (in memory)        │
      └──────────┬──────────┘
                 │ flush when > MemtableSize
      ┌──────────▼──────────┐
      │  SSTables (disk)    │  sorted, immutable, newest first
      │  000007.sst         │  + sparse index + Bloom filter
      │  000006.sst ...     │
      └──────────┬──────────┘
                 │ compaction when >= CompactAt tables
                 ▼
         one merged SSTable (tombstones dropped)
```

**Reads** check the memtable, then each SSTable from newest to oldest. Each
table is skipped instantly if the key is outside its `[smallest, largest]`
range or its **Bloom filter** says "definitely not here". Otherwise a binary
search on the in-memory sparse index jumps to a block of at most 16 entries.

**Range scans** use a k-way **heap merge iterator** across the memtable and
all tables; when the same key exists in several places the newest wins.

## Durability

| Failure | What happens |
|---|---|
| Process crash before flush | WAL is replayed on `Open` |
| Power loss mid-WAL-append | Torn tail record is detected by CRC and truncated |
| Crash while writing an SSTable | Written to `.tmp`, then atomically renamed |
| Crash during compaction | `MANIFEST` (atomic rename) lists live tables; orphans are deleted on open, so dropped tombstones can never resurrect old values |

`SyncWrites: true` fsyncs every write for full power-loss safety.

## Usage

```go
db, err := lsmkv.Open("./data", &lsmkv.Options{MemtableSize: 4 << 20})
if err != nil { log.Fatal(err) }
defer db.Close()

db.Put([]byte("user:42"), []byte(`{"name":"Sumit"}`))
v, err := db.Get([]byte("user:42"))
db.Delete([]byte("user:42"))

// Range scan [start, end)
db.Scan([]byte("user:"), []byte("user;"), func(k, v []byte) bool {
    fmt.Printf("%s => %s\n", k, v)
    return true // false stops early
})
```

### Interactive shell

```bash
go run ./cmd/kvcli ./data
> put user:1 Sumit
> get user:1
Sumit
> scan user:
user:1 = Sumit
(1 keys)
> stats
{Flushes:1 Compactions:0 Tables:1 MemEntries:0}
```

## Testing

```bash
go test -race ./...
go test -bench . -benchtime 20000x
```

The test-suite includes a **randomized model test** — 20,000 random puts and
deletes checked against a plain Go map across many flushes, compactions and
a full reopen — plus crash recovery, torn WAL tails, orphaned compaction
output, concurrent readers/writers and a Bloom filter false-positive check
(< 2% at 10 bits per key).

Sample numbers on a 4-core VM (100-byte values):

| Benchmark | ns/op |
|---|---|
| Put (WAL + memtable) | ~1,450 |
| Get (from SSTable)   | ~2,800 |

## File layout

| File | Responsibility |
|---|---|
| `db.go` | public API, flush, compaction, manifest |
| `wal.go` | write-ahead log and crash recovery |
| `memtable.go` | skip list |
| `sstable.go` | on-disk sorted table format, sparse index |
| `bloom.go` | Bloom filter with double hashing |
| `iterator.go` | k-way merge iterator |

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
