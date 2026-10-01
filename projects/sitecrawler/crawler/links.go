package crawler

import (
	"io"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

// Normalize resolves ref against base and canonicalises the result so the
// same page is never queued twice under different spellings. It returns ""
// for links that aren't crawlable (mailto:, javascript:, tel:, …).
func Normalize(base *url.URL, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" || strings.HasPrefix(ref, "#") {
		return ""
	}
	u, err := base.Parse(ref)
	if err != nil {
		return ""
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	u.Host = strings.ToLower(u.Host)
	if (u.Scheme == "http" && u.Port() == "80") || (u.Scheme == "https" && u.Port() == "443") {
		u.Host = u.Hostname()
	}
	u.Fragment = ""
	u.RawFragment = ""
	u.User = nil
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String()
}

// PageInfo is what we learn from an HTML document.
type PageInfo struct {
	Title    string
	Links    []string // normalised, de-duplicated, in document order
	NoFollow bool     // <meta name="robots" content="nofollow">
	NoIndex  bool
}

// Extract parses HTML with a streaming tokenizer (no DOM is built), honouring
// <base href>, rel="nofollow" and the robots meta tag.
func Extract(r io.Reader, pageURL *url.URL) PageInfo {
	var info PageInfo
	base := pageURL
	seen := map[string]bool{}
	z := html.NewTokenizer(r)
	inTitle := false
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return info
		case html.TextToken:
			if inTitle && info.Title == "" {
				info.Title = strings.Join(strings.Fields(string(z.Text())), " ")
			}
		case html.EndTagToken:
			if name, _ := z.TagName(); string(name) == "title" {
				inTitle = false
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			attrs := map[string]string{}
			for hasAttr {
				var k, v []byte
				k, v, hasAttr = z.TagAttr()
				attrs[string(k)] = string(v)
			}
			switch string(name) {
			case "title":
				inTitle = tt == html.StartTagToken
			case "base":
				if b, err := pageURL.Parse(attrs["href"]); err == nil && attrs["href"] != "" {
					base = b
				}
			case "meta":
				if strings.EqualFold(attrs["name"], "robots") {
					c := strings.ToLower(attrs["content"])
					info.NoFollow = info.NoFollow || strings.Contains(c, "nofollow") || strings.Contains(c, "none")
					info.NoIndex = info.NoIndex || strings.Contains(c, "noindex") || strings.Contains(c, "none")
				}
			case "a", "area":
				if hasToken(attrs["rel"], "nofollow") {
					continue
				}
				if u := Normalize(base, attrs["href"]); u != "" && !seen[u] {
					seen[u] = true
					info.Links = append(info.Links, u)
				}
			}
		}
	}
}

func hasToken(list, token string) bool {
	for _, f := range strings.Fields(strings.ToLower(list)) {
		if f == token {
			return true
		}
	}
	return false
}
