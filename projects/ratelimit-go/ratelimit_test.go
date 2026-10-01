package ratelimit

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)} }
func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func countAllowed(l *Limiter, key string, n int) int {
	ok := 0
	for i := 0; i < n; i++ {
		if l.Allow(key).Allowed {
			ok++
		}
	}
	return ok
}

func TestAllAlgorithmsEnforceBurst(t *testing.T) {
	algos := map[string]Algorithm{
		"token":   TokenBucket(1, 10),
		"fixed":   FixedWindow(10, time.Minute),
		"sliding": SlidingWindow(10, time.Minute),
		"gcra":    GCRA(10, time.Minute),
	}
	for name, a := range algos {
		t.Run(name, func(t *testing.T) {
			l := New(a, WithClock(newClock()))
			if got := countAllowed(l, "k", 25); got != 10 {
				t.Fatalf("allowed %d, want 10", got)
			}
			d := l.Allow("k")
			if d.Allowed || d.RetryAfter <= 0 || d.Remaining != 0 {
				t.Fatalf("expected rejection with retry hint, got %+v", d)
			}
			// Keys are independent.
			if !l.Allow("other").Allowed {
				t.Fatal("other key should not be limited")
			}
		})
	}
}

func TestTokenBucketRefill(t *testing.T) {
	c := newClock()
	l := New(TokenBucket(2, 4), WithClock(c)) // 2 tokens/sec
	countAllowed(l, "k", 4)
	if l.Allow("k").Allowed {
		t.Fatal("bucket should be empty")
	}
	c.Advance(500 * time.Millisecond) // +1 token
	if !l.Allow("k").Allowed {
		t.Fatal("expected one token after 500ms")
	}
	if l.Allow("k").Allowed {
		t.Fatal("only one token should have refilled")
	}
	c.Advance(10 * time.Second) // refill capped at burst
	if got := countAllowed(l, "k", 10); got != 4 {
		t.Fatalf("refill should cap at burst 4, got %d", got)
	}
}

func TestFixedWindowBoundaryBurst(t *testing.T) {
	c := newClock()
	l := New(FixedWindow(10, time.Minute), WithClock(c))
	c.Advance(59 * time.Second)
	a := countAllowed(l, "k", 10)
	c.Advance(2 * time.Second) // next window
	b := countAllowed(l, "k", 10)
	if a+b != 20 {
		t.Fatalf("fixed window allows 2x at boundary; got %d", a+b)
	}
}

func TestSlidingWindowSmoothsBoundary(t *testing.T) {
	c := newClock()
	l := New(SlidingWindow(10, time.Minute), WithClock(c))
	c.Advance(59 * time.Second)
	a := countAllowed(l, "k", 10)
	c.Advance(2 * time.Second) // 1s into next window: ~98% of previous still counts
	b := countAllowed(l, "k", 10)
	if a != 10 || b > 1 {
		t.Fatalf("sliding window should block the boundary burst, got %d + %d", a, b)
	}
	c.Advance(30 * time.Second) // halfway: previous window weighs ~48%
	got := countAllowed(l, "k", 10)
	if got < 4 || got > 6 {
		t.Fatalf("expected ~5 allowed halfway through, got %d", got)
	}
}

func TestGCRASpacing(t *testing.T) {
	c := newClock()
	l := New(GCRA(60, time.Minute), WithClock(c)) // 1 per second sustained
	countAllowed(l, "k", 60)
	d := l.Allow("k")
	if d.Allowed {
		t.Fatal("burst exhausted")
	}
	if d.RetryAfter != time.Second {
		t.Fatalf("RetryAfter = %v, want 1s", d.RetryAfter)
	}
	c.Advance(time.Second)
	if !l.Allow("k").Allowed {
		t.Fatal("one request per second should be allowed")
	}
}

func TestAllowNIsAtomic(t *testing.T) {
	l := New(TokenBucket(1, 5), WithClock(newClock()))
	if !l.AllowN("k", 3).Allowed {
		t.Fatal("3 of 5 should pass")
	}
	if l.AllowN("k", 3).Allowed {
		t.Fatal("3 more should fail (only 2 left)")
	}
	if !l.AllowN("k", 2).Allowed {
		t.Fatal("failed AllowN must not consume tokens")
	}
}

func TestCleanupEvictsIdleKeys(t *testing.T) {
	c := newClock()
	l := New(GCRA(10, time.Second), WithClock(c))
	for i := 0; i < 1000; i++ {
		l.Allow(fmt.Sprint(i))
	}
	if l.Len() != 1000 {
		t.Fatal("expected 1000 keys")
	}
	c.Advance(2 * time.Second)
	if n := l.Cleanup(); n != 1000 || l.Len() != 0 {
		t.Fatalf("evicted %d, remaining %d", n, l.Len())
	}
}

func TestConcurrentAccessNeverOverAdmits(t *testing.T) {
	l := New(FixedWindow(1000, time.Hour), WithClock(newClock()))
	var allowed atomic.Int64
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				if l.Allow("shared").Allowed {
					allowed.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 1000 {
		t.Fatalf("allowed %d, want exactly 1000", allowed.Load())
	}
}

func TestMiddleware(t *testing.T) {
	l := New(FixedWindow(2, time.Minute), WithClock(newClock()))
	h := Middleware(l, ByIP)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	}))

	codes := []int{}
	var last *httptest.ResponseRecorder
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = "203.0.113.7:5555"
		last = httptest.NewRecorder()
		h.ServeHTTP(last, req)
		codes = append(codes, last.Code)
	}
	if codes[0] != 200 || codes[1] != 200 || codes[2] != 429 {
		t.Fatalf("codes = %v", codes)
	}
	if last.Header().Get("Retry-After") != "60" || last.Header().Get("RateLimit-Limit") != "2" {
		t.Fatalf("headers = %v", last.Header())
	}

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-For", "198.51.100.1, 10.0.0.1")
	if ByForwardedIP(req) != "198.51.100.1" {
		t.Fatal("ByForwardedIP should use the client address")
	}
}

func BenchmarkAllowParallel(b *testing.B) {
	l := New(GCRA(1_000_000, time.Second))
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			l.Allow(fmt.Sprint(i % 1024))
			i++
		}
	})
}
