package ratelimit

import (
	"math"
	"time"
)

// ---------------------------------------------------------------------------
// Token bucket: capacity `burst`, refilled continuously at `rate` tokens/sec.
// Allows short bursts while enforcing a long-run average.

type tokenBucket struct {
	rate  float64 // tokens per second
	burst int
}

func TokenBucket(ratePerSec float64, burst int) Algorithm {
	return tokenBucket{rate: ratePerSec, burst: burst}
}

func (a tokenBucket) newState() state {
	return &tbState{cfg: a, tokens: float64(a.burst)}
}

type tbState struct {
	cfg    tokenBucket
	tokens float64
	last   time.Time
}

func (s *tbState) allow(now time.Time, cost int) Decision {
	if !s.last.IsZero() {
		elapsed := now.Sub(s.last).Seconds()
		s.tokens = math.Min(float64(s.cfg.burst), s.tokens+elapsed*s.cfg.rate)
	}
	s.last = now
	d := Decision{Limit: s.cfg.burst}
	if s.tokens >= float64(cost) {
		s.tokens -= float64(cost)
		d.Allowed = true
	} else {
		d.RetryAfter = secs((float64(cost) - s.tokens) / s.cfg.rate)
	}
	d.Remaining = int(s.tokens)
	d.ResetAfter = secs((float64(s.cfg.burst) - s.tokens) / s.cfg.rate)
	return d
}

func (s *tbState) idleSince() time.Time {
	return s.last.Add(secs((float64(s.cfg.burst) - s.tokens) / s.cfg.rate))
}

// ---------------------------------------------------------------------------
// Fixed window: at most `limit` requests per aligned window. Simple and cheap,
// but allows up to 2× the limit around a window boundary.

type fixedWindow struct {
	limit  int
	window time.Duration
}

func FixedWindow(limit int, window time.Duration) Algorithm { return fixedWindow{limit, window} }

func (a fixedWindow) newState() state { return &fwState{cfg: a} }

type fwState struct {
	cfg   fixedWindow
	start time.Time
	count int
}

func (s *fwState) allow(now time.Time, cost int) Decision {
	ws := now.Truncate(s.cfg.window)
	if !ws.Equal(s.start) {
		s.start, s.count = ws, 0
	}
	reset := s.start.Add(s.cfg.window).Sub(now)
	d := Decision{Limit: s.cfg.limit, ResetAfter: reset}
	if s.count+cost <= s.cfg.limit {
		s.count += cost
		d.Allowed = true
	} else {
		d.RetryAfter = reset
	}
	d.Remaining = s.cfg.limit - s.count
	return d
}

func (s *fwState) idleSince() time.Time { return s.start.Add(s.cfg.window) }

// ---------------------------------------------------------------------------
// Sliding window counter: weights the previous window's count by how much of
// it still overlaps the sliding window. O(1) memory, smooths the fixed-window
// boundary problem (the approach popularised by Cloudflare).

type slidingWindow struct {
	limit  int
	window time.Duration
}

func SlidingWindow(limit int, window time.Duration) Algorithm { return slidingWindow{limit, window} }

func (a slidingWindow) newState() state { return &swState{cfg: a} }

type swState struct {
	cfg       slidingWindow
	curStart  time.Time
	cur, prev int
}

func (s *swState) allow(now time.Time, cost int) Decision {
	ws := now.Truncate(s.cfg.window)
	switch {
	case ws.Equal(s.curStart):
	case ws.Equal(s.curStart.Add(s.cfg.window)):
		s.prev, s.cur, s.curStart = s.cur, 0, ws
	default:
		s.prev, s.cur, s.curStart = 0, 0, ws
	}

	overlap := 1 - float64(now.Sub(ws))/float64(s.cfg.window)
	estimated := float64(s.prev)*overlap + float64(s.cur)
	d := Decision{Limit: s.cfg.limit}
	if estimated+float64(cost) <= float64(s.cfg.limit) {
		s.cur += cost
		estimated += float64(cost)
		d.Allowed = true
	} else {
		// Solve prev*(1 - t/W) + cur + cost <= limit for the elapsed time t.
		need := estimated + float64(cost) - float64(s.cfg.limit)
		if s.prev > 0 && need <= float64(s.prev)*overlap {
			d.RetryAfter = time.Duration(need / float64(s.prev) * float64(s.cfg.window))
		} else {
			d.RetryAfter = ws.Add(s.cfg.window).Sub(now)
		}
	}
	d.Remaining = max(0, s.cfg.limit-int(math.Ceil(estimated)))
	d.ResetAfter = ws.Add(2 * s.cfg.window).Sub(now)
	return d
}

func (s *swState) idleSince() time.Time { return s.curStart.Add(2 * s.cfg.window) }

// ---------------------------------------------------------------------------
// GCRA (Generic Cell Rate Algorithm): a token bucket expressed as a single
// timestamp — the "theoretical arrival time" (TAT). Exact, O(1) memory, and
// the algorithm used by many API gateways.

type gcra struct {
	emission  time.Duration // time per request
	tolerance time.Duration // burst allowance
	limit     int
}

// GCRA allows `limit` requests per `period`, with bursts up to `limit`.
func GCRA(limit int, period time.Duration) Algorithm {
	e := period / time.Duration(limit)
	return gcra{emission: e, tolerance: e * time.Duration(limit), limit: limit}
}

func (a gcra) newState() state { return &gcraState{cfg: a} }

type gcraState struct {
	cfg gcra
	tat time.Time
}

func (s *gcraState) allow(now time.Time, cost int) Decision {
	tat := s.tat
	if tat.Before(now) {
		tat = now
	}
	increment := s.cfg.emission * time.Duration(cost)
	newTat := tat.Add(increment)
	allowAt := newTat.Add(-s.cfg.tolerance)

	d := Decision{Limit: s.cfg.limit}
	if diff := allowAt.Sub(now); diff > 0 {
		d.RetryAfter = diff
		d.Remaining = remainingGCRA(s.cfg, tat, now)
		d.ResetAfter = tat.Sub(now)
		return d
	}
	s.tat = newTat
	d.Allowed = true
	d.Remaining = remainingGCRA(s.cfg, newTat, now)
	d.ResetAfter = newTat.Sub(now)
	return d
}

func remainingGCRA(c gcra, tat, now time.Time) int {
	free := c.tolerance - tat.Sub(now)
	if free <= 0 {
		return 0
	}
	return int(free / c.emission)
}

func (s *gcraState) idleSince() time.Time { return s.tat }

func secs(f float64) time.Duration { return time.Duration(f * float64(time.Second)) }
