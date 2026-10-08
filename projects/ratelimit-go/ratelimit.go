// Package ratelimit provides per-key rate limiters with four interchangeable
// algorithms and an net/http middleware.
//
//	lim := ratelimit.New(ratelimit.GCRA(100, time.Minute))
//	http.Handle("/", ratelimit.Middleware(lim, ratelimit.ByIP)(handler))
package ratelimit

import (
	"hash/maphash"
	"sync"
	"time"
)

// Decision is the outcome of a single Allow call.
type Decision struct {
	Allowed   bool
	Limit     int
	Remaining int
	// RetryAfter is how long to wait before the next request can succeed (0 if allowed).
	RetryAfter time.Duration
	// ResetAfter is how long until the limiter is completely full again.
	ResetAfter time.Duration
}

// Algorithm holds per-key state and decides whether a request at time now is allowed.
// Implementations are not goroutine-safe; Limiter serialises access per key.
type Algorithm interface {
	newState() state
}

type state interface {
	allow(now time.Time, cost int) Decision
	// idleSince reports when the state stopped carrying information
	// (fully refilled / window expired) so it can be evicted.
	idleSince() time.Time
}

// Clock lets tests control time.
type Clock interface{ Now() time.Time }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

const shardCount = 64

type shard struct {
	mu    sync.Mutex
	items map[string]state
}

// Limiter applies an Algorithm independently per key (user ID, IP, API key…).
// Keys are spread over 64 lock shards so unrelated clients never contend.
type Limiter struct {
	algo   Algorithm
	clock  Clock
	seed   maphash.Seed
	shards [shardCount]shard
}

type Option func(*Limiter)

// WithClock overrides the time source (useful for tests).
func WithClock(c Clock) Option { return func(l *Limiter) { l.clock = c } }

func New(algo Algorithm, opts ...Option) *Limiter {
	l := &Limiter{algo: algo, clock: realClock{}, seed: maphash.MakeSeed()}
	for i := range l.shards {
		l.shards[i].items = map[string]state{}
	}
	for _, o := range opts {
		o(l)
	}
	return l
}

func (l *Limiter) shardFor(key string) *shard {
	return &l.shards[maphash.String(l.seed, key)%shardCount]
}

// Allow consumes one unit for key.
func (l *Limiter) Allow(key string) Decision { return l.AllowN(key, 1) }

// AllowN consumes cost units for key atomically: either all or nothing.
func (l *Limiter) AllowN(key string, cost int) Decision {
	if cost < 1 {
		cost = 1
	}
	s := l.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.items[key]
	if !ok {
		st = l.algo.newState()
		s.items[key] = st
	}
	return st.allow(l.clock.Now(), cost)
}

// Cleanup evicts keys whose state is back to "fresh", bounding memory for
// limiters that see many short-lived clients. Returns the number evicted.
func (l *Limiter) Cleanup() int {
	now := l.clock.Now()
	n := 0
	for i := range l.shards {
		s := &l.shards[i]
		s.mu.Lock()
		for k, st := range s.items {
			if !st.idleSince().After(now) {
				delete(s.items, k)
				n++
			}
		}
		s.mu.Unlock()
	}
	return n
}

// Len reports the number of tracked keys.
func (l *Limiter) Len() int {
	n := 0
	for i := range l.shards {
		l.shards[i].mu.Lock()
		n += len(l.shards[i].items)
		l.shards[i].mu.Unlock()
	}
	return n
}

// StartJanitor runs Cleanup every interval until stop is closed.
func (l *Limiter) StartJanitor(interval time.Duration, stop <-chan struct{}) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				l.Cleanup()
			case <-stop:
				return
			}
		}
	}()
}
