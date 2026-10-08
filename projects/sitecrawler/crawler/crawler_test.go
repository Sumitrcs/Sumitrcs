package crawler

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func site(t *testing.T) *httptest.Server {
	t.Helper()
	pages := map[string]string{
		"/":               `<html><head><title> Home  Page </title></head><body><a href="/about">About</a> <a href="/blog/">Blog</a> <a href="https://elsewhere.example/">ext</a> <a href="mailto:x@y.z">mail</a> <a href="#top">top</a></body></html>`,
		"/about":          `<title>About</title><a href="/team">Team</a><a href="/missing">Broken</a><a href="/old">Old</a>`,
		"/blog/":          `<title>Blog</title><base href="/blog/posts/"><a href="one">One</a><a href="/secret/plan">Secret</a><a rel="nofollow" href="/ignored">x</a>`,
		"/blog/posts/one": `<title>Post one</title><a href="/">home</a><a href="/files/report.pdf">pdf</a>`,
		"/team":           `<title>Team</title><meta name="robots" content="noindex, nofollow"><a href="/hidden">hidden</a>`,
		"/new":            `<title>New</title>`,
		"/hidden":         `<title>Hidden</title>`,
		"/ignored":        `<title>Ignored</title>`,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "User-agent: *\nDisallow: /secret/\n")
	})
	mux.HandleFunc("/old", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/new", http.StatusMovedPermanently) })
	mux.HandleFunc("/files/report.pdf", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Write([]byte("%PDF-1.7"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		body, ok := pages[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func crawl(t *testing.T, cfg Config) (map[string]Page, *Report) {
	t.Helper()
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	origin := strings.TrimSuffix(cfg.Start[0], "/")
	got := map[string]Page{} // keyed by path
	rep := &Report{Started: time.Now()}
	c.Run(context.Background(), func(p Page) {
		got[strings.TrimPrefix(p.URL, origin)] = p
		rep.Add(p)
	})
	return got, rep
}

func keys(m map[string]Page) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestCrawlWholeSite(t *testing.T) {
	srv := site(t)
	got, rep := crawl(t, Config{Start: []string{srv.URL + "/"}, MaxDepth: 5, Concurrency: 4, SameHost: true, RespectRobots: true})

	want := []string{"/", "/about", "/blog/", "/blog/posts/one", "/files/report.pdf", "/missing", "/old", "/secret/plan", "/team"}
	if fmt.Sprint(keys(got)) != fmt.Sprint(want) {
		t.Fatalf("crawled %v\nwant    %v", keys(got), want)
	}
	if got["/"].Title != "Home Page" || got["/"].Links != 3 {
		t.Errorf("home page = %+v", got["/"])
	}
	if !got["/secret/plan"].Blocked {
		t.Error("robots.txt should block /secret/")
	}
	if got["/missing"].Status != 404 || got["/missing"].Referrer == "" {
		t.Errorf("missing page = %+v", got["/missing"])
	}
	if !strings.HasSuffix(got["/old"].FinalURL, "/new") || got["/old"].Status != 200 {
		t.Errorf("redirect not followed: %+v", got["/old"])
	}
	if got["/files/report.pdf"].ContentType != "application/pdf" || got["/files/report.pdf"].Links != 0 {
		t.Errorf("pdf = %+v", got["/files/report.pdf"])
	}
	if _, ok := got["/hidden"]; ok {
		t.Error("meta nofollow should stop link extraction")
	}

	broken := rep.Broken()
	if len(broken) != 1 || !strings.HasSuffix(broken[0].URL, "/missing") {
		t.Fatalf("broken = %+v", broken)
	}
	var sm bytes.Buffer
	if err := rep.WriteSitemap(&sm); err != nil {
		t.Fatal(err)
	}
	xml := sm.String()
	if !strings.Contains(xml, srv.URL+"/new</loc>") || strings.Contains(xml, "/team") || strings.Contains(xml, ".pdf") {
		t.Errorf("sitemap wrong:\n%s", xml)
	}
	var out bytes.Buffer
	rep.Write(&out)
	if !strings.Contains(out.String(), "Broken links (1)") {
		t.Errorf("report:\n%s", out.String())
	}
}

func TestDepthAndPageLimits(t *testing.T) {
	srv := site(t)
	got, _ := crawl(t, Config{Start: []string{srv.URL + "/"}, MaxDepth: 0, SameHost: true})
	if len(got) != 1 {
		t.Fatalf("depth 0 crawled %v", keys(got))
	}
	got, _ = crawl(t, Config{Start: []string{srv.URL + "/"}, MaxDepth: 9, MaxPages: 3, SameHost: true})
	if len(got) != 3 {
		t.Fatalf("max pages 3 crawled %d", len(got))
	}
}

func TestPerHostDelayIsEnforcedAcrossWorkers(t *testing.T) {
	var mu sync.Mutex
	var hits []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits = append(hits, time.Now())
		mu.Unlock()
		w.Header().Set("Content-Type", "text/html")
		var b strings.Builder
		if r.URL.Path == "/" {
			for i := range 8 {
				fmt.Fprintf(&b, `<a href="/p%d">p</a>`, i)
			}
		}
		fmt.Fprint(w, b.String())
	}))
	defer srv.Close()
	crawl(t, Config{Start: []string{srv.URL + "/"}, MaxDepth: 1, Concurrency: 8, Delay: 40 * time.Millisecond, SameHost: true})
	if len(hits) != 9 {
		t.Fatalf("hits = %d", len(hits))
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Before(hits[j]) })
	for i := 1; i < len(hits); i++ {
		if gap := hits[i].Sub(hits[i-1]); gap < 35*time.Millisecond {
			t.Fatalf("requests %d and %d only %v apart", i-1, i, gap)
		}
	}
}

func TestServerErrorOnRobotsMeansDisallow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/robots.txt" {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte("<a href='/x'>x</a>"))
	}))
	defer srv.Close()
	got, _ := crawl(t, Config{Start: []string{srv.URL + "/"}, MaxDepth: 2, RespectRobots: true, SameHost: true})
	if !got["/"].Blocked {
		t.Fatal("5xx on robots.txt must be treated as full disallow")
	}
}

func TestCancellationStopsQuickly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		// An infinite site: every page links to two new pages.
		fmt.Fprintf(w, `<a href="%sa">a</a><a href="%sb">b</a>`, r.URL.Path, r.URL.Path)
	}))
	defer srv.Close()
	c, _ := New(Config{Start: []string{srv.URL + "/"}, MaxDepth: 1000, Concurrency: 4, SameHost: true})
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	n := 0
	c.Run(ctx, func(Page) { n++ })
	if time.Since(start) > time.Second || n == 0 {
		t.Fatalf("run took %v, crawled %d", time.Since(start), n)
	}
}

func TestNormalize(t *testing.T) {
	base, _ := url.Parse("https://Example.com:443/a/b?x=1")
	cases := map[string]string{
		"c":                             "https://example.com/a/c",
		"../d#frag":                     "https://example.com/d",
		"HTTP://EXAMPLE.COM:80":         "http://example.com/",
		"//cdn.example.com/x.js":        "https://cdn.example.com/x.js",
		"?q=2":                          "https://example.com/a/b?q=2",
		"mailto:a@b.c":                  "",
		"javascript:void(0)":            "",
		"#only-fragment":                "",
		"https://user:pw@example.com/p": "https://example.com/p",
	}
	for in, want := range cases {
		if got := Normalize(base, in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestInvalidConfig(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Error("expected error for no start URLs")
	}
	if _, err := New(Config{Start: []string{"ftp://x"}}); err == nil {
		t.Error("expected error for non-http start URL")
	}
}
