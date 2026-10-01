package robots

import (
	"strings"
	"testing"
	"time"
)

const sample = `
# Example
User-agent: *
Disallow: /admin/
Disallow: /*.pdf$
Allow: /admin/public/
Crawl-delay: 1.5

User-agent: BadBot
User-agent: EvilBot
Disallow: /

User-agent: sitecrawler
Disallow: /private
Allow: /private/ok

Sitemap: https://example.com/sitemap.xml
`

func TestRules(t *testing.T) {
	rb := Parse(strings.NewReader(sample))
	cases := []struct {
		ua, path string
		want     bool
	}{
		{"Mozilla", "/", true},
		{"Mozilla", "/admin/users", false},
		{"Mozilla", "/admin/public/logo.png", true}, // longer Allow beats Disallow
		{"Mozilla", "/files/report.pdf", false},
		{"Mozilla", "/files/report.pdf?x=1", true}, // $ anchors the end
		{"BadBot/2.0", "/anything", false},
		{"evilbot", "/", false},              // grouped user-agents, case-insensitive
		{"sitecrawler/1.0", "/admin/", true}, // specific group replaces the * group
		{"sitecrawler/1.0", "/private/x", false},
		{"sitecrawler/1.0", "/private/ok", true},
		{"BadBot", "/robots.txt", true}, // always fetchable
	}
	for _, c := range cases {
		if got := rb.Allowed(c.ua, c.path); got != c.want {
			t.Errorf("Allowed(%q, %q) = %v, want %v", c.ua, c.path, got, c.want)
		}
	}
	if d := rb.CrawlDelay("Mozilla"); d != 1500*time.Millisecond {
		t.Errorf("crawl delay = %v", d)
	}
	if len(rb.Sitemaps) != 1 {
		t.Errorf("sitemaps = %v", rb.Sitemaps)
	}
}

func TestEmptyDisallowAllowsEverything(t *testing.T) {
	rb := Parse(strings.NewReader("User-agent: *\nDisallow:\n"))
	if !rb.Allowed("x", "/secret") {
		t.Fatal("empty Disallow must allow all")
	}
	if !AllowAll.Allowed("x", "/anything") {
		t.Fatal("AllowAll must allow")
	}
}
