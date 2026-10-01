# ratelimit-go

[![CI](https://github.com/Sumitrcs/ratelimit-go/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/ratelimit-go/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Production-style **rate limiting for Go** with four algorithms behind one
interface, per-key limits, sharded locking and a drop-in `net/http`
middleware. No dependencies.

```go
lim := ratelimit.New(ratelimit.GCRA(100, time.Minute)) // 100 req/min per key
http.Handle("/api/", ratelimit.Middleware(lim, ratelimit.ByIP)(apiHandler))
```

## Algorithms

| Algorithm | Memory / key | Boundary bursts | Best for |
|---|---|---|---|
| `TokenBucket(rate, burst)` | 2 numbers | controlled by `burst` | APIs that tolerate short bursts |
| `FixedWindow(limit, window)` | 2 numbers | up to **2×** at window edges | cheap quotas ("1000/day") |
| `SlidingWindow(limit, window)` | 3 numbers | smoothed by weighting the previous window | public APIs |
| `GCRA(limit, period)` | **1 timestamp** | none — exact spacing | gateways, high cardinality |

GCRA (Generic Cell Rate Algorithm) stores a single "theoretical arrival time"
per key and is mathematically equivalent to a token bucket. The tests show
the difference between the algorithms — for example, a fixed window lets 20
requests through in 2 seconds around a boundary; the sliding window allows 10.

## Features

- **Per-key limiting** — by IP, `X-Forwarded-For`, API-key header, or any `KeyFunc`
- **64 lock shards** keyed by `maphash`, so unrelated clients never contend
- **Atomic `AllowN`** — weighted requests (e.g. a bulk endpoint costs 10)
- **IETF headers** — `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`
- **Janitor** evicts idle keys to bound memory
- **Injectable clock** — every test is deterministic, no `time.Sleep`

## Example

```bash
go run ./example
for i in $(seq 1 7); do curl -si localhost:8080/ | head -1; done
# HTTP/1.1 200 OK  (x5)
# HTTP/1.1 429 Too Many Requests  (x2)
```

## Tests and benchmarks

```bash
go test -race ./...
go test -bench . .
```

The concurrency test hammers one key from 16 goroutines and checks the
limiter admits **exactly** the limit — never one more.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
