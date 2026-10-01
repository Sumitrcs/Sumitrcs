package ratelimit

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// KeyFunc extracts the rate-limit key from a request. Returning "" skips limiting.
type KeyFunc func(*http.Request) string

// ByIP keys on the client IP from RemoteAddr. Behind a proxy use ByForwardedIP.
func ByIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ByForwardedIP trusts the first address in X-Forwarded-For. Only use this
// when every request passes through a proxy you control.
func ByForwardedIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		return strings.TrimSpace(first)
	}
	return ByIP(r)
}

// ByHeader keys on a header such as an API key.
func ByHeader(name string) KeyFunc {
	return func(r *http.Request) string { return r.Header.Get(name) }
}

// Middleware rejects requests over the limit with 429 and sets the IETF
// RateLimit-* headers plus Retry-After on every response.
func Middleware(l *Limiter, key KeyFunc) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			k := key(r)
			if k == "" {
				next.ServeHTTP(w, r)
				return
			}
			d := l.Allow(k)
			h := w.Header()
			h.Set("RateLimit-Limit", strconv.Itoa(d.Limit))
			h.Set("RateLimit-Remaining", strconv.Itoa(d.Remaining))
			h.Set("RateLimit-Reset", ceilSeconds(d.ResetAfter))
			if !d.Allowed {
				h.Set("Retry-After", ceilSeconds(d.RetryAfter))
				http.Error(w, http.StatusText(http.StatusTooManyRequests), http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func ceilSeconds(d time.Duration) string {
	return strconv.Itoa(int(math.Ceil(d.Seconds())))
}
