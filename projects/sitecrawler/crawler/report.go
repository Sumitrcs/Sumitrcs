package crawler

import (
	"encoding/xml"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// Report aggregates crawl results for a human-readable summary.
type Report struct {
	Pages   []Page
	Started time.Time
}

func (r *Report) Add(p Page) { r.Pages = append(r.Pages, p) }

// Broken returns pages that failed (4xx/5xx or network error), excluding robots blocks.
func (r *Report) Broken() []Page {
	var out []Page
	for _, p := range r.Pages {
		if !p.Blocked && (p.Error != "" || p.Status >= 400) {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].URL < out[j].URL })
	return out
}

func (r *Report) Write(w io.Writer) {
	byStatus := map[string]int{}
	var total time.Duration
	for _, p := range r.Pages {
		key := fmt.Sprintf("%dxx", p.Status/100)
		switch {
		case p.Blocked:
			key = "robots"
		case p.Error != "":
			key = "error"
		}
		byStatus[key]++
		total += p.Duration
	}
	fmt.Fprintf(w, "\nCrawled %d URLs in %s\n", len(r.Pages), time.Since(r.Started).Round(time.Millisecond))
	keys := make([]string, 0, len(byStatus))
	for k := range byStatus {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "  %-7s %d\n", k, byStatus[k])
	}
	if n := len(r.Pages); n > 0 {
		fmt.Fprintf(w, "  avg response %s\n", (total / time.Duration(n)).Round(time.Millisecond))
	}

	if broken := r.Broken(); len(broken) > 0 {
		fmt.Fprintf(w, "\nBroken links (%d):\n", len(broken))
		for _, p := range broken {
			why := fmt.Sprint(p.Status)
			if p.Error != "" {
				why = p.Error
			}
			fmt.Fprintf(w, "  %s  [%s]\n", p.URL, why)
			if p.Referrer != "" {
				fmt.Fprintf(w, "      linked from %s\n", p.Referrer)
			}
		}
	}

	slow := append([]Page(nil), r.Pages...)
	sort.Slice(slow, func(i, j int) bool { return slow[i].Duration > slow[j].Duration })
	if len(slow) > 5 {
		slow = slow[:5]
	}
	if len(slow) > 0 {
		fmt.Fprintln(w, "\nSlowest pages:")
		for _, p := range slow {
			fmt.Fprintf(w, "  %8s  %s\n", p.Duration.Round(time.Millisecond), p.URL)
		}
	}
}

// WriteSitemap emits a sitemaps.org XML file with every indexable HTML page.
func (r *Report) WriteSitemap(w io.Writer) error {
	type entry struct {
		Loc string `xml:"loc"`
	}
	type urlset struct {
		XMLName xml.Name `xml:"urlset"`
		XMLNS   string   `xml:"xmlns,attr"`
		URLs    []entry  `xml:"url"`
	}
	set := urlset{XMLNS: "http://www.sitemaps.org/schemas/sitemap/0.9"}
	seen := map[string]bool{}
	for _, p := range r.Pages {
		loc := p.URL
		if p.FinalURL != "" {
			loc = p.FinalURL
		}
		if p.OK() && !p.NoIndex && strings.Contains(p.ContentType, "html") && !seen[loc] {
			seen[loc] = true
			set.URLs = append(set.URLs, entry{loc})
		}
	}
	sort.Slice(set.URLs, func(i, j int) bool { return set.URLs[i].Loc < set.URLs[j].Loc })
	if _, err := io.WriteString(w, xml.Header); err != nil {
		return err
	}
	enc := xml.NewEncoder(w)
	enc.Indent("", "  ")
	if err := enc.Encode(set); err != nil {
		return err
	}
	_, err := io.WriteString(w, "\n")
	return err
}
