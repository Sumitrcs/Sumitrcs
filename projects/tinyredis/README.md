# tinyredis

[![CI](https://github.com/Sumitrcs/tinyredis/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/tinyredis/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**A small Redis server in Go that real Redis clients can talk to.** It speaks
the actual Redis protocol (RESP), so `redis-cli` and Redis libraries for any
language work with it. Data survives restarts thanks to an append-only file.

Built to learn how a real database server works — networking, a wire
protocol, concurrency, expiry and persistence — in code a beginner can read
in an evening. No dependencies, only Go's standard library.

```
$ tinyredis -addr 127.0.0.1:6380
$ redis-cli -p 6380
127.0.0.1:6380> SET greeting namaste EX 60
OK
127.0.0.1:6380> GET greeting
namaste
127.0.0.1:6380> TTL greeting
60
127.0.0.1:6380> INCR page:views
1
127.0.0.1:6380> RPUSH tasks "write code" "test it" "ship it"
3
127.0.0.1:6380> LRANGE tasks 0 -1
write code
test it
ship it
127.0.0.1:6380> HSET user:1 name Sumit city Delhi
2
127.0.0.1:6380> HGETALL user:1
city
Delhi
name
Sumit
127.0.0.1:6380> KEYS *
greeting
page:views
tasks
user:1
```

## Supported commands

| Group | Commands |
|---|---|
| Strings | `SET` (with `EX`, `PX`, `NX`, `XX`, `KEEPTTL`), `GET`, `INCR`, `DECR`, `INCRBY`, `DECRBY` |
| Keys | `DEL`, `EXISTS`, `TYPE`, `KEYS` (glob patterns), `DBSIZE`, `FLUSHALL` |
| Expiry | `EXPIRE`, `PEXPIRE`, `PEXPIREAT`, `TTL`, `PTTL`, `PERSIST` |
| Lists | `LPUSH`, `RPUSH`, `LPOP`, `RPOP`, `LRANGE` (negative indexes), `LLEN` |
| Hashes | `HSET`, `HGET`, `HDEL`, `HGETALL` |
| Server | `PING`, `ECHO`, `INFO`, `QUIT` |

Errors match Redis too: `WRONGTYPE`, `ERR value is not an integer`, wrong
argument counts, unknown commands.

## Run it

```bash
go install github.com/Sumitrcs/tinyredis@latest
tinyredis -addr 127.0.0.1:6380 -aof appendonly.aof
```

No `redis-cli`? Plain text works too: `nc 127.0.0.1 6380`, then type `PING`.

## How it works

```
client ──TCP──▶ goroutine per connection ──▶ resp.Reader ──▶ command table ──▶ store
                                                                  │
                                                                  └──▶ appendonly.aof
```

**1. The protocol (`resp/`).** Redis messages are simple text with lengths:
`*2\r\n$3\r\nGET\r\n$4\r\nname\r\n` means "an array of 2 strings: GET and
name". Because every string carries its length, values can contain any
bytes — even newlines. The reader also accepts plain "inline" commands like
`PING`, which is why telnet works.

**2. One goroutine per client (`server/server.go`).** Go makes this cheap.
Every connection loops: read a command, run it, write the reply. If a client
sends many commands at once (*pipelining*), replies are only flushed to the
network when no more input is waiting — one write instead of a hundred.

**3. A command table (`server/commands.go`).** Each command has an *arity*
(how many arguments it needs), a flag saying whether it changes data, and a
function. Adding a command means adding one line to the map.

**4. The store and expiry (`store/`).** All data sits in a Go map protected by
a mutex. Keys with a TTL expire two ways, exactly like Redis: *lazily* when
someone reads them, and *actively* — ten times a second the server samples 20
keys that have a TTL, deletes the expired ones, and repeats if more than a
quarter were expired.

**5. Persistence (AOF).** Every successful write command is appended to a file
in the same RESP format. On start-up the file is replayed. One subtle detail:
`SET k v EX 60` is logged as `SET k v` plus `PEXPIREAT k <absolute time>`, so
after a restart the key keeps its original deadline instead of getting a fresh
60 seconds. A half-written last command (power cut) is safely ignored.

## What you'll learn

- How a TCP server is structured in Go: `net.Listen`, `Accept`, a goroutine per connection
- Designing and parsing a wire protocol with `bufio`
- Protecting shared data with a mutex, and testing it with `go test -race`
- Time-based logic made testable by injecting a fake clock
- Write-ahead logging and crash recovery
- A glob matcher (`*`, `?`, `[a-z]`) written by hand

## Try it yourself

1. Add `APPEND`, `STRLEN` and `GETDEL` — each is a few lines in `commands.go` and `store.go`.
2. Add sets: `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER` (a `map[string]struct{}` per key).
3. Implement `BGREWRITEAOF`: write a compact AOF from the current data, then swap files.
4. Add `SELECT` with 16 numbered databases.
5. Add simple pub/sub: `SUBSCRIBE` and `PUBLISH` — a channel → subscribers map.

## Tests

```bash
go test -race ./...
```

Unit tests cover the protocol parser, every data type, expiry (with a fake
clock, so no sleeping), the glob matcher and the active sweep. Integration
tests start a real server and check pipelining of 100 commands, 20 concurrent
clients incrementing one counter to exactly 2,000, AOF replay keeping original
deadlines, a torn AOF tail, and — if it's installed — the real `redis-cli`.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
