package mdlite

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The inline pass walks a paragraph's text one character at a time. Most
// characters are copied (HTML-escaped) to the output. A few start something
// special:
//
//	\   escape the next punctuation character, or a hard line break
//	`   code span
//	< > autolink: <https://example.com>
//	[ ] link, and ![ ] image
//	* _ emphasis (one) and strong emphasis (two); ~~ strikethrough
//
// When something special doesn't work out (an unclosed `, a [ with no
// matching ]), the character is just written as plain text.
//
// Emphasis needs a second step. While scanning, a run like "**" is only
// recorded as a delimiter token, because we can't yet know whether it will
// be matched. Afterwards processEmphasis pairs closers with openers using a
// stack, the method the CommonMark spec describes. Every delimiter is pushed
// and popped at most once, so even "*a *a *a ..." with thousands of unmatched
// stars stays fast. (A naive "search ahead for the closing star" approach
// takes exponential time on such input.)

// token is either finished HTML text or a run of delimiter characters.
type token struct {
	html      strings.Builder
	delim     byte // '*', '_' or '~'; 0 for a text token
	n         int  // delimiters left in the run
	canOpen   bool
	canClose  bool
	openTags  []string // written after the run's leftover characters
	closeTags []string // written before them
}

type inline struct {
	src      string
	toks     []*token
	brackets map[int]int  // position of each [ → its matching ], found in one pass
	noCloser map[int]bool // backtick run lengths known to have no closing run
}

func renderInline(text string) string {
	src := strings.TrimRight(text, " \t\n")
	p := inline{src: src, noCloser: map[int]bool{}}
	p.run(src)
	p.processEmphasis()
	var out strings.Builder
	for _, t := range p.toks {
		if t.delim == 0 {
			out.WriteString(t.html.String())
			continue
		}
		for _, tag := range t.closeTags {
			out.WriteString(tag)
		}
		out.WriteString(strings.Repeat(string(t.delim), t.n))
		for _, tag := range t.openTags {
			out.WriteString(tag)
		}
	}
	return out.String()
}

// write appends HTML to the output, merging with a preceding text token.
// (A strings.Builder, not +=, which would copy the whole text every time.)
func (p *inline) write(html string) {
	if n := len(p.toks); n == 0 || p.toks[n-1].delim != 0 {
		p.toks = append(p.toks, &token{})
	}
	p.toks[len(p.toks)-1].html.WriteString(html)
}

func (p *inline) run(s string) {
	for i := 0; i < len(s); {
		switch c := s[i]; c {
		case '\\':
			i = p.backslash(s, i)
		case '`':
			i = p.codeSpan(s, i)
		case '<':
			i = p.autolink(s, i)
		case '!', '[':
			i = p.link(s, i)
		case '*', '_', '~':
			i = p.delimiterRun(s, i)
		case ' ':
			i = p.spaces(s, i)
		default:
			// Copy one whole UTF-8 character.
			_, size := utf8.DecodeRuneInString(s[i:])
			p.write(escapeHTML(s[i : i+size]))
			i += size
		}
	}
}

func (p *inline) backslash(s string, i int) int {
	if i+1 < len(s) {
		next := s[i+1]
		if next == '\n' {
			p.write("<br>\n")
			return i + 2
		}
		if isPunct(next) {
			p.write(escapeHTML(s[i+1 : i+2]))
			return i + 2
		}
	}
	p.write(`\`)
	return i + 1
}

// Two or more spaces at the end of a line make a hard line break.
func (p *inline) spaces(s string, i int) int {
	j := i
	for j < len(s) && s[j] == ' ' {
		j++
	}
	if j < len(s) && s[j] == '\n' {
		if j-i >= 2 {
			p.write("<br>\n")
		} else {
			p.write("\n")
		}
		return j + 1
	}
	p.write(s[i:j])
	return j
}

// A code span starts with a run of N backticks and ends with the next run of
// exactly N, so a span opened with two backticks can contain a single one.
func (p *inline) codeSpan(s string, i int) int {
	n := runLength(s, i, '`')
	for j := i + n; j < len(s) && !p.noCloser[n]; {
		k := strings.IndexByte(s[j:], '`')
		if k < 0 {
			// Nothing to close a run of this length from here on, so don't
			// search again for the next one (that would be quadratic).
			p.noCloser[n] = true
			break
		}
		j += k
		m := runLength(s, j, '`')
		if m == n {
			code := strings.ReplaceAll(s[i+n:j], "\n", " ")
			// One space just inside each end is stripped, so `` `x` `` works.
			if len(code) >= 2 && code[0] == ' ' && code[len(code)-1] == ' ' && strings.Trim(code, " ") != "" {
				code = code[1 : len(code)-1]
			}
			p.write("<code>" + escapeHTML(code) + "</code>")
			return j + m
		}
		j += m
	}
	p.write(s[i : i+n]) // no closing run: literal backticks
	return i + n
}

var (
	reURLAutolink   = regexp.MustCompile(`^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>`)
	reEmailAutolink = regexp.MustCompile(`^<([a-zA-Z0-9.!#$%&'*+/=?^_{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+)>`)
)

func (p *inline) autolink(s string, i int) int {
	if m := reURLAutolink.FindStringSubmatch(s[i:]); m != nil {
		if href, ok := safeURL(m[1]); ok {
			p.write(`<a href="` + href + `">` + escapeHTML(m[1]) + "</a>")
			return i + len(m[0])
		}
	}
	if m := reEmailAutolink.FindStringSubmatch(s[i:]); m != nil {
		p.write(`<a href="mailto:` + escapeHTML(m[1]) + `">` + escapeHTML(m[1]) + "</a>")
		return i + len(m[0])
	}
	p.write("&lt;")
	return i + 1
}

// link handles [text](url "title") and ![alt](src "title").
func (p *inline) link(s string, i int) int {
	image := s[i] == '!'
	open := i
	if image {
		if i+1 >= len(s) || s[i+1] != '[' {
			p.write("!")
			return i + 1
		}
		open = i + 1
	}
	close := p.matchingBracket(open)
	if close < 0 || close+1 >= len(s) || s[close+1] != '(' {
		p.write(s[i : open+1])
		return open + 1
	}
	dest, title, end, ok := linkTarget(s, close+2)
	if !ok {
		p.write(s[i : open+1])
		return open + 1
	}
	label := s[open+1 : close]
	href, safe := safeURL(dest)
	titleAttr := ""
	if title != "" {
		titleAttr = ` title="` + escapeHTML(title) + `"`
	}
	switch {
	case image && safe:
		p.write(`<img src="` + href + `" alt="` + escapeHTML(plainText(label)) + `"` + titleAttr + ">")
	case image:
		p.write(escapeHTML(plainText(label)))
	case safe:
		// The label is rendered on its own, so emphasis can't leak out of a link.
		p.write(`<a href="` + href + `"` + titleAttr + ">" + renderInline(label) + "</a>")
	default:
		p.write(renderInline(label)) // a javascript: link becomes plain text
	}
	return end
}

// matchingBracket finds the ] that closes the [ at position open, allowing
// nested brackets and skipping escaped ones. All pairs are found in a single
// pass with a stack the first time it is called.
func (p *inline) matchingBracket(open int) int {
	if p.brackets == nil {
		p.brackets = map[int]int{}
		var stack []int
		for k := 0; k < len(p.src); k++ {
			switch p.src[k] {
			case '\\':
				k++
			case '[':
				stack = append(stack, k)
			case ']':
				if len(stack) > 0 {
					p.brackets[stack[len(stack)-1]] = k
					stack = stack[:len(stack)-1]
				}
			}
		}
	}
	if close, ok := p.brackets[open]; ok {
		return close
	}
	return -1
}

// maxTarget caps how far a link's (url "title") part may run. Without a
// limit, text like "[a](" repeated thousands of times makes every link
// attempt scan to the end of the paragraph.
const maxTarget = 4096

// linkTarget parses `url "title")` starting just after the "(".
func linkTarget(s string, k int) (dest, title string, end int, ok bool) {
	if len(s) > k+maxTarget {
		s = s[:k+maxTarget]
	}
	skip := func() {
		for k < len(s) && (s[k] == ' ' || s[k] == '\n') {
			k++
		}
	}
	skip()
	if k < len(s) && s[k] == '<' { // <url with spaces>
		j := strings.IndexByte(s[k:], '>')
		if j < 0 {
			return "", "", 0, false
		}
		dest, k = s[k+1:k+j], k+j+1
	} else {
		start, depth := k, 0
		for ; k < len(s) && s[k] != ' ' && s[k] != '\n'; k++ {
			if s[k] == '\\' && k+1 < len(s) {
				k++
			} else if s[k] == '(' {
				depth++
			} else if s[k] == ')' {
				if depth == 0 {
					break
				}
				depth--
			}
		}
		dest = s[start:k]
	}
	skip()
	if k < len(s) && (s[k] == '"' || s[k] == '\'') {
		q := s[k]
		j := strings.IndexByte(s[k+1:], q)
		if j < 0 {
			return "", "", 0, false
		}
		title, k = s[k+1:k+1+j], k+j+2
		skip()
	}
	if k >= len(s) || s[k] != ')' {
		return "", "", 0, false
	}
	return unescape(dest), unescape(title), k + 1, true
}

// delimiterRun records a run of * _ or ~ as a token, noting whether it could
// open emphasis, close it, or both. Matching happens later.
func (p *inline) delimiterRun(s string, i int) int {
	c := s[i]
	n := runLength(s, i, c)
	if c == '~' && n != 2 { // only ~~ means strikethrough
		p.write(s[i : i+n])
		return i + n
	}
	p.toks = append(p.toks, &token{delim: c, n: n, canOpen: opens(s, i, n, c), canClose: closes(s, i, n, c)})
	return i + n
}

// processEmphasis pairs closing delimiter runs with the nearest earlier
// opening run of the same character:
//
//	*a **b** c*   →   <em>a <strong>b</strong> c</em>
//
// Two delimiters on both sides make <strong>, one makes <em>. Runs left over
// stay as plain characters. bottom[c] remembers how far down the stack a
// search for c already failed, so it is never repeated.
func (p *inline) processEmphasis() {
	var stack []*token
	bottom := map[byte]int{}
	for _, t := range p.toks {
		if t.delim == 0 {
			continue
		}
		for t.canClose && t.n > 0 {
			found := -1
			for k := len(stack) - 1; k >= min(bottom[t.delim], len(stack)); k-- {
				if stack[k].delim == t.delim {
					found = k
					break
				}
			}
			if found < 0 {
				bottom[t.delim] = len(stack)
				break
			}
			opener := stack[found]
			use := 1
			if opener.n >= 2 && t.n >= 2 {
				use = 2
			}
			tag := map[int]string{1: "em", 2: "strong"}[use]
			if t.delim == '~' {
				tag = "del"
			}
			opener.n -= use
			t.n -= use
			// Tags added later wrap the earlier ones: ***x*** → <em><strong>x</strong></em>.
			opener.openTags = append([]string{"<" + tag + ">"}, opener.openTags...)
			t.closeTags = append(t.closeTags, "</"+tag+">")
			// Delimiters between the pair can no longer match anything.
			stack = stack[:found+1]
			if opener.n == 0 {
				stack = stack[:found]
			}
		}
		if t.canOpen && t.n > 0 {
			stack = append(stack, t)
		}
	}
}

// A run can open emphasis if it is followed by a non-space character, and
// close it if it is preceded by one. For _ the run must also not be inside
// a word, so snake_case_names stay as they are.
func opens(s string, i, n int, c byte) bool {
	after := i + n
	if after >= len(s) || isSpace(s[after]) {
		return false
	}
	return c != '_' || i == 0 || !isWordChar(s, i, -1)
}

func closes(s string, i, n int, c byte) bool {
	if i == 0 || isSpace(s[i-1]) {
		return false
	}
	return c != '_' || i+n >= len(s) || !isWordChar(s, i+n, +1)
}

func runLength(s string, i int, c byte) int {
	n := 0
	for i+n < len(s) && s[i+n] == c {
		n++
	}
	return n
}

func isSpace(b byte) bool { return b == ' ' || b == '\n' || b == '\t' }

func isPunct(b byte) bool {
	return b < 128 && unicode.IsPunct(rune(b)) || strings.IndexByte("$+<=>^`|~", b) >= 0
}

// isWordChar reports whether the character just before i (dir -1) or at i
// (dir +1) is a letter or digit.
func isWordChar(s string, i, dir int) bool {
	var r rune
	if dir < 0 {
		r, _ = utf8.DecodeLastRuneInString(s[:i])
	} else {
		r, _ = utf8.DecodeRuneInString(s[i:])
	}
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

func escapeHTML(s string) string { return htmlEscaper.Replace(s) }

// unescape removes backslashes before punctuation: \* → *.
func unescape(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for k := 0; k < len(s); k++ {
		if s[k] == '\\' && k+1 < len(s) && isPunct(s[k+1]) {
			k++
		}
		b.WriteByte(s[k])
	}
	return b.String()
}

// plainText is the text of some inline markup without the markup, for alt
// attributes: "**bold** `x`" → "bold x".
func plainText(s string) string {
	html := renderInline(s)
	var b strings.Builder
	inTag := false
	for _, r := range html {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
		case !inTag:
			b.WriteRune(r)
		}
	}
	return strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", `"`, "&amp;", "&").Replace(b.String())
}

// safeURL escapes a URL for an attribute and refuses schemes that run code.
// Browsers ignore tabs, newlines and control characters inside a scheme, so
// "java\tscript:" is checked as "javascript:".
func safeURL(raw string) (string, bool) {
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x21 || r == 0x7f {
			return -1
		}
		return r
	}, raw)
	if colon := strings.IndexByte(cleaned, ':'); colon >= 0 && !strings.ContainsAny(cleaned[:colon], "/?#") {
		switch strings.ToLower(cleaned[:colon]) {
		case "http", "https", "mailto", "ftp", "tel":
		default:
			return "", false
		}
	}
	return escapeHTML(strings.ReplaceAll(raw, " ", "%20")), true
}
