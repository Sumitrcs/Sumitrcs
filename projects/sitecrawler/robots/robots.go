// Package robots implements the Robots Exclusion Protocol (RFC 9309).
package robots

import (
	"bufio"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type rule struct {
	allow   bool
	pattern string
	re      *regexp.Regexp
}

type group struct {
	agents     []string
	rules      []rule
	crawlDelay time.Duration
}

// Robots is a parsed robots.txt file.
type Robots struct {
	groups   []*group
	Sitemaps []string
}

// AllowAll is used when a site has no robots.txt (404) — everything is permitted.
var AllowAll = &Robots{}

// Parse reads robots.txt content. Unknown lines are ignored, as the RFC requires.
func Parse(r io.Reader) *Robots {
	rb := &Robots{}
	var cur *group
	lastWasAgent := false
	sc := bufio.NewScanner(io.LimitReader(r, 500*1024)) // RFC 9309: parse at least 500 KiB
	for sc.Scan() {
		line := sc.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)

		switch key {
		case "user-agent":
			// Consecutive user-agent lines share one group.
			if cur == nil || !lastWasAgent {
				cur = &group{}
				rb.groups = append(rb.groups, cur)
			}
			cur.agents = append(cur.agents, strings.ToLower(value))
			lastWasAgent = true
			continue
		case "allow", "disallow":
			if cur != nil && (value != "" || key == "allow") {
				cur.rules = append(cur.rules, rule{allow: key == "allow", pattern: value, re: compile(value)})
			}
		case "crawl-delay":
			if cur != nil {
				if secs, err := strconv.ParseFloat(value, 64); err == nil && secs >= 0 {
					cur.crawlDelay = time.Duration(secs * float64(time.Second))
				}
			}
		case "sitemap":
			rb.Sitemaps = append(rb.Sitemaps, value)
		}
		lastWasAgent = false
	}
	return rb
}

// compile turns a robots pattern into an anchored regexp: '*' matches any
// sequence and a trailing '$' anchors the end.
func compile(p string) *regexp.Regexp {
	anchored := strings.HasSuffix(p, "$")
	p = strings.TrimSuffix(p, "$")
	parts := strings.Split(p, "*")
	for i, s := range parts {
		parts[i] = regexp.QuoteMeta(s)
	}
	expr := "^" + strings.Join(parts, ".*")
	if anchored {
		expr += "$"
	}
	return regexp.MustCompile(expr)
}

// groupFor picks the group whose user-agent token is the longest match for
// the crawler's name, falling back to "*".
func (rb *Robots) groupFor(userAgent string) *group {
	ua := strings.ToLower(userAgent)
	var best *group
	bestLen := -1
	for _, g := range rb.groups {
		for _, a := range g.agents {
			if a == "*" && bestLen < 0 {
				best, bestLen = g, 0
			} else if a != "*" && strings.Contains(ua, a) && len(a) > bestLen {
				best, bestLen = g, len(a)
			}
		}
	}
	return best
}

// Allowed reports whether userAgent may fetch path (path plus optional query).
// The most specific (longest) matching rule wins; on a tie, Allow wins.
func (rb *Robots) Allowed(userAgent, path string) bool {
	if path == "/robots.txt" {
		return true
	}
	g := rb.groupFor(userAgent)
	if g == nil {
		return true
	}
	allowed, bestLen := true, -1
	for _, r := range g.rules {
		if r.pattern == "" {
			continue
		}
		if r.re.MatchString(path) {
			l := len(r.pattern)
			if l > bestLen || (l == bestLen && r.allow) {
				allowed, bestLen = r.allow, l
			}
		}
	}
	return allowed
}

// CrawlDelay returns the requested delay between requests for userAgent (0 if none).
func (rb *Robots) CrawlDelay(userAgent string) time.Duration {
	if g := rb.groupFor(userAgent); g != nil {
		return g.crawlDelay
	}
	return 0
}
