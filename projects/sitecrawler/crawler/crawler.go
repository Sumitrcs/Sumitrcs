// Package crawler implements a polite, concurrent website crawler.
package crawler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Sumitrcs/sitecrawler/robots"
)

type Config struct {
	Start         []string
	MaxDepth      int           // 0 = only the start pages
	MaxPages      int           // stop after this many fetches (0 = unlimited)
	Concurrency   int           // parallel fetches across all hosts
	Delay         time.Duration // minimum gap between requests to the same host
	Timeout       time.Duration // per request
	UserAgent     string
	SameHost      bool // only follow links on the start hosts
	RespectRobots bool
	MaxBodyBytes  int64
	Client        *http.Client
}

type Page struct {
	URL         string        `json:"url"`
	FinalURL    string        `json:"final_url,omitempty"`
	Referrer    string        `json:"referrer,omitempty"`
	Depth       int           `json:"depth"`
	Status      int           `json:"status"`
	ContentType string        `json:"content_type,omitempty"`
	Title       string        `json:"title,omitempty"`
	Links       int           `json:"links"`
	Duration    time.Duration `json:"duration_ns"`
	Error       string        `json:"error,omitempty"`
	NoIndex     bool          `json:"noindex,omitempty"`
	Blocked     bool          `json:"blocked_by_robots,omitempty"`
}

// OK reports a successfully fetched page (2xx).
func (p Page) OK() bool { return p.Error == "" && p.Status >= 200 && p.Status < 300 }

type task struct {
	url      string
	referrer string
	depth    int
}

type Crawler struct {
	cfg        Config
	hosts      map[string]bool
	mu         sync.Mutex
	nextSlot   map[string]time.Time
	robotsMu   sync.Mutex
	robotsMemo map[string]*robotsEntry
}

type robotsEntry struct {
	once sync.Once
	rb   *robots.Robots
}

func New(cfg Config) (*Crawler, error) {
	if len(cfg.Start) == 0 {
		return nil, errors.New("crawler: no start URLs")
	}
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 4
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 15 * time.Second
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = "sitecrawler/1.0 (+https://github.com/Sumitrcs/sitecrawler)"
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 5 << 20
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: cfg.Timeout}
	}
	c := &Crawler{cfg: cfg, hosts: map[string]bool{}, nextSlot: map[string]time.Time{}, robotsMemo: map[string]*robotsEntry{}}
	for i, s := range cfg.Start {
		u, err := url.Parse(s)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, fmt.Errorf("crawler: invalid start URL %q", s)
		}
		c.cfg.Start[i] = Normalize(u, s)
		c.hosts[strings.ToLower(u.Host)] = true
	}
	return c, nil
}

// Run crawls until the frontier is empty, MaxPages is reached or ctx is
// cancelled. onPage is called from a single goroutine, so it needs no locking.
func (c *Crawler) Run(ctx context.Context, onPage func(Page)) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	tasks := make(chan task)
	type result struct {
		page  Page
		links []string
		t     task
	}
	results := make(chan result)

	var wg sync.WaitGroup
	for range c.cfg.Concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range tasks {
				p, links := c.fetch(ctx, t)
				select {
				case results <- result{p, links, t}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// The coordinator owns the frontier and the seen-set, so no locks are needed for them.
	seen := map[string]bool{}
	var queue []task
	for _, s := range c.cfg.Start {
		if !seen[s] {
			seen[s] = true
			queue = append(queue, task{url: s})
		}
	}
	inflight, dispatched := 0, 0

	for (len(queue) > 0 || inflight > 0) && ctx.Err() == nil {
		var out chan task
		var next task
		if len(queue) > 0 && (c.cfg.MaxPages == 0 || dispatched < c.cfg.MaxPages) {
			out, next = tasks, queue[0]
		} else if inflight == 0 {
			break // page budget exhausted
		}
		select {
		case out <- next:
			queue = queue[1:]
			inflight++
			dispatched++
		case r := <-results:
			inflight--
			onPage(r.page)
			if r.t.depth >= c.cfg.MaxDepth {
				continue
			}
			for _, l := range r.links {
				if !seen[l] && c.inScope(l) {
					seen[l] = true
					queue = append(queue, task{url: l, referrer: r.t.url, depth: r.t.depth + 1})
				}
			}
		case <-ctx.Done():
		}
	}
	close(tasks)
	cancel()
	wg.Wait()
}

func (c *Crawler) inScope(raw string) bool {
	if !c.cfg.SameHost {
		return true
	}
	u, err := url.Parse(raw)
	return err == nil && c.hosts[u.Host]
}

func (c *Crawler) fetch(ctx context.Context, t task) (Page, []string) {
	p := Page{URL: t.url, Referrer: t.referrer, Depth: t.depth}
	u, err := url.Parse(t.url)
	if err != nil {
		p.Error = err.Error()
		return p, nil
	}
	delay := c.cfg.Delay
	if c.cfg.RespectRobots {
		rb := c.robotsFor(ctx, u)
		if !rb.Allowed(c.cfg.UserAgent, u.RequestURI()) {
			p.Blocked = true
			p.Error = "disallowed by robots.txt"
			return p, nil
		}
		delay = max(delay, rb.CrawlDelay(c.cfg.UserAgent))
	}
	if err := c.waitTurn(ctx, u.Host, delay); err != nil {
		p.Error = err.Error()
		return p, nil
	}

	start := time.Now()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, t.url, nil)
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
	resp, err := c.cfg.Client.Do(req)
	p.Duration = time.Since(start)
	if err != nil {
		p.Error = err.Error()
		return p, nil
	}
	defer resp.Body.Close()
	p.Status = resp.StatusCode
	p.ContentType, _, _ = mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if final := resp.Request.URL.String(); final != t.url {
		p.FinalURL = final
	}
	if p.ContentType != "text/html" && p.ContentType != "application/xhtml+xml" {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return p, nil
	}
	info := Extract(io.LimitReader(resp.Body, c.cfg.MaxBodyBytes), resp.Request.URL)
	p.Duration = time.Since(start)
	p.Title = info.Title
	p.Links = len(info.Links)
	p.NoIndex = info.NoIndex
	if info.NoFollow || !p.OK() {
		return p, nil
	}
	return p, info.Links
}

// waitTurn enforces a minimum gap between requests to the same host, even
// when many workers want that host at once: each caller reserves the next
// free slot under the lock, then sleeps until it arrives.
func (c *Crawler) waitTurn(ctx context.Context, host string, gap time.Duration) error {
	if gap <= 0 {
		return nil
	}
	c.mu.Lock()
	now := time.Now()
	slot := c.nextSlot[host]
	if slot.Before(now) {
		slot = now
	}
	c.nextSlot[host] = slot.Add(gap)
	c.mu.Unlock()

	timer := time.NewTimer(time.Until(slot))
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Crawler) robotsFor(ctx context.Context, u *url.URL) *robots.Robots {
	key := u.Scheme + "://" + u.Host
	c.robotsMu.Lock()
	e, ok := c.robotsMemo[key]
	if !ok {
		e = &robotsEntry{}
		c.robotsMemo[key] = e
	}
	c.robotsMu.Unlock()

	e.once.Do(func() {
		e.rb = robots.AllowAll
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, key+"/robots.txt", nil)
		if err != nil {
			return
		}
		req.Header.Set("User-Agent", c.cfg.UserAgent)
		resp, err := c.cfg.Client.Do(req)
		if err != nil {
			return
		}
		defer resp.Body.Close()
		switch {
		case resp.StatusCode >= 200 && resp.StatusCode < 300:
			e.rb = robots.Parse(resp.Body)
		case resp.StatusCode >= 500:
			// RFC 9309: an unreachable robots.txt means "assume complete disallow".
			e.rb = robots.Parse(strings.NewReader("User-agent: *\nDisallow: /\n"))
		}
	})
	return e.rb
}
