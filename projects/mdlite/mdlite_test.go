package mdlite

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite the golden .html files in testdata")

type tc struct{ name, in, want string }

func run(t *testing.T, cases []tc) {
	t.Helper()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ToHTML(c.in); got != c.want {
				t.Errorf("input:\n%s\n--- got:\n%s\n--- want:\n%s", c.in, got, c.want)
			}
		})
	}
}

func TestBlocks(t *testing.T) {
	run(t, []tc{
		{"atx headings", "# One\n### Three ###\n####### seven", "<h1 id=\"one\">One</h1>\n<h3 id=\"three\">Three</h3>\n<p>####### seven</p>\n"},
		{"hashtag is not a heading", "#hashtag", "<p>#hashtag</p>\n"},
		{"setext headings", "Title\n=====\nSub\n---", "<h1 id=\"title\">Title</h1>\n<h2 id=\"sub\">Sub</h2>\n"},
		{"paragraphs", "one\ntwo\n\nthree", "<p>one\ntwo</p>\n<p>three</p>\n"},
		{"rules", "***\n- - -\n___", "<hr>\n<hr>\n<hr>\n"},
		{"fenced code keeps everything literal", "```js\nif (a < b) { *x* }\n\n```", "<pre><code class=\"language-js\">if (a &lt; b) { *x* }\n\n</code></pre>\n"},
		{"tilde fence and longer closing fence", "~~~\ncode\n~~~~~", "<pre><code>code\n</code></pre>\n"},
		{"unclosed fence runs to the end", "```\nabc", "<pre><code>abc\n</code></pre>\n"},
		{"fence inside indentation", "  ```\n  x\n    y\n  ```", "<pre><code>x\n  y\n</code></pre>\n"},
		{"quote with nesting and a list", "> a\n> > b\n> - c", "<blockquote>\n<p>a</p>\n<blockquote>\n<p>b</p>\n</blockquote>\n<ul>\n<li>c</li>\n</ul>\n</blockquote>\n"},
		{"heading interrupts a paragraph", "text\n# Head", "<p>text</p>\n<h1 id=\"head\">Head</h1>\n"},
	})
}

func TestLists(t *testing.T) {
	run(t, []tc{
		{"tight bullets", "- a\n- b", "<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n"},
		{"loose list gets paragraphs", "- a\n\n- b", "<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>\n"},
		{"ordered with start", "3. c\n4. d", "<ol start=\"3\">\n<li>c</li>\n<li>d</li>\n</ol>\n"},
		{"paren delimiter", "1) x", "<ol>\n<li>x</li>\n</ol>\n"},
		{"nested", "- a\n  - b\n    - c\n- d", "<ul>\n<li>\na\n<ul>\n<li>\nb\n<ul>\n<li>c</li>\n</ul>\n</li>\n</ul>\n</li>\n<li>d</li>\n</ul>\n"},
		{"different marker starts a new list", "- a\n+ b", "<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>\n"},
		{"lazy continuation", "- one\ntwo", "<ul>\n<li>one\ntwo</li>\n</ul>\n"},
		{"code inside an item", "- run:\n\n  ```\n  go test\n  ```", "<ul>\n<li>\n<p>run:</p>\n<pre><code>go test\n</code></pre>\n</li>\n</ul>\n"},
		{"star rule is not a list", "* * *", "<hr>\n"},
		{"empty item", "-\n- b", "<ul>\n<li></li>\n<li>b</li>\n</ul>\n"},
	})
}

func TestTables(t *testing.T) {
	run(t, []tc{
		{"alignment, escaped pipe, code with pipe",
			"| a | b | c |\n|:--|:-:|--:|\n| `x|y` | 2 \\| 3 | **z** |",
			"<table>\n<thead>\n<tr><th style=\"text-align:left\">a</th><th style=\"text-align:center\">b</th><th style=\"text-align:right\">c</th></tr>\n</thead>\n<tbody>\n<tr><td style=\"text-align:left\"><code>x|y</code></td><td style=\"text-align:center\">2 | 3</td><td style=\"text-align:right\"><strong>z</strong></td></tr>\n</tbody>\n</table>\n"},
		{"missing cells are filled, extra dropped",
			"a | b\n---|---\n1\n1 | 2 | 3",
			"<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td><td></td></tr>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table>\n"},
		{"header only", "| x |\n| - |", "<table>\n<thead>\n<tr><th>x</th></tr>\n</thead>\n</table>\n"},
		{"column count must match", "a | b\n---", "<h2 id=\"a--b\">a | b</h2>\n"},
	})
}

func TestInline(t *testing.T) {
	p := func(s string) string { return "<p>" + s + "</p>\n" }
	run(t, []tc{
		{"emphasis", "*a* _b_ **c** __d__ ~~e~~", p("<em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong> <del>e</del>")},
		{"nesting", "*a **b** c* and ***x***", p("<em>a <strong>b</strong> c</em> and <em><strong>x</strong></em>")},
		{"intraword underscores stay", "snake_case_name and 2*3*4", p("snake_case_name and 2<em>3</em>4")},
		{"spaces don't open or close", "a * b * c and ** no **", p("a * b * c and ** no **")},
		{"unclosed stays literal", "*open and **half", p("*open and **half")},
		{"code spans", "`a` `` b`c `` ` d `", p("<code>a</code> <code>b`c</code> <code>d</code>")},
		{"code is literal", "`*x* <b>`", p("<code>*x* &lt;b&gt;</code>")},
		{"no emphasis across code", "*a `*` b*", p("<em>a <code>*</code> b</em>")},
		{"escapes", `\*not\* \_ \\ \a`, p(`*not* _ \ \a`)},
		{"links", `[Go](https://go.dev) [t](/x "T") [**b**](#h)`, p(`<a href="https://go.dev">Go</a> <a href="/x" title="T">t</a> <a href="#h"><strong>b</strong></a>`)},
		{"parentheses in URL", "[w](https://en.wikipedia.org/wiki/C_(language))", p(`<a href="https://en.wikipedia.org/wiki/C_(language)">w</a>`)},
		{"angle URL with spaces", "[f](<my file.pdf>)", p(`<a href="my%20file.pdf">f</a>`)},
		{"nested brackets", "[a [b] c](u)", p(`<a href="u">a [b] c</a>`)},
		{"not a link", "[a] (b) [c", p("[a] (b) [c")},
		{"image", `![a *b*](p.png "T")`, p(`<img src="p.png" alt="a b" title="T">`)},
		{"autolinks", "<https://x.io/a?b=1&c> <me@site.in>", p(`<a href="https://x.io/a?b=1&amp;c">https://x.io/a?b=1&amp;c</a> <a href="mailto:me@site.in">me@site.in</a>`)},
		{"raw HTML is escaped", "<script>alert(1)</script> & \"q\"", p("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;")},
		{"hard breaks", "a  \nb\\\nc\nd", p("a<br>\nb<br>\nc\nd")},
		{"unicode", "नमस्ते *दुनिया* 😀", p("नमस्ते <em>दुनिया</em> 😀")},
	})
}

func TestUnsafeURLsAreRemoved(t *testing.T) {
	for _, in := range []string{
		"[x](javascript:alert(1))",
		"[x](JavaScript:alert(1))",
		"[x](java\tscript:alert(1))",
		"[x](vbscript:msgbox)",
		"[x](data:text/html;base64,PHNjcmlwdD4=)",
		"<javascript:alert(1)>",
		"![x](javascript:alert(1))",
	} {
		got := ToHTML(in)
		if strings.Contains(strings.ToLower(got), "href") || strings.Contains(got, "src=") {
			t.Errorf("%q rendered a link: %s", in, got)
		}
	}
	// Ordinary relative and absolute links are kept.
	for _, ok := range []string{"/docs", "page.html#x", "https://a.b", "mailto:x@y.z", "?q=1", "#top", "a:b/c"} {
		if _, safe := safeURL(ok); !safe && ok != "a:b/c" {
			t.Errorf("%q should be allowed", ok)
		}
	}
}

func TestHeadingIDsAndTOC(t *testing.T) {
	src := "# Guide\n[TOC]\n## Install\n### From source\n## Use it\n## Install\n### Notes & tips\n"
	doc := Parse(src)
	var ids []string
	for _, h := range doc.Headings {
		ids = append(ids, h.ID)
	}
	if got := strings.Join(ids, " "); got != "guide install from-source use-it install-1 notes--tips" {
		t.Fatalf("ids: %s", got)
	}
	html := Render(src, Options{TOC: true})
	want := `<nav class="toc">
<ul>
<li><a href="#install">Install</a>
<ul>
<li><a href="#from-source">From source</a></li>
</ul>
</li>
<li><a href="#use-it">Use it</a></li>
<li><a href="#install-1">Install</a>
<ul>
<li><a href="#notes--tips">Notes &amp; tips</a></li>
</ul>
</li>
</ul>
</nav>
`
	if !strings.Contains(html, "<h1 id=\"guide\">Guide</h1>\n"+want+"<h2 id=\"install\">") {
		t.Errorf("TOC not placed at [TOC]:\n%s", html)
	}
	if !strings.HasPrefix(Render("## A\ntext", Options{TOC: true}), "<nav class=\"toc\">") {
		t.Error("without [TOC] the contents should go at the top")
	}
}

func TestNestingLimit(t *testing.T) {
	got := ToHTML(strings.Repeat(">", 70) + " deep")
	if strings.Count(got, "<blockquote>") != maxDepth+1 || !strings.Contains(got, "<p>&gt;&gt;&gt;&gt;&gt; deep</p>") {
		t.Errorf("unexpected output:\n%s", got)
	}
}

func TestLineEndingsAndTabs(t *testing.T) {
	if got := ToHTML("# A\r\n\r\n-\tb\r\n"); got != "<h1 id=\"a\">A</h1>\n<ul>\n<li>b</li>\n</ul>\n" {
		t.Errorf("got %q", got)
	}
}

// Golden files: testdata/*.md is rendered and compared with the .html next
// to it. Run `go test -update` after an intended change to rewrite them.
func TestGolden(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.md")
	if len(files) == 0 {
		t.Fatal("no golden files")
	}
	for _, md := range files {
		src, err := os.ReadFile(md)
		if err != nil {
			t.Fatal(err)
		}
		got := Render(string(src), Options{TOC: true})
		htmlFile := strings.TrimSuffix(md, ".md") + ".html"
		if *update {
			if err := os.WriteFile(htmlFile, []byte(got), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(htmlFile)
		if err != nil {
			t.Fatal(err)
		}
		if got != string(want) {
			t.Errorf("%s: output differs from %s (run go test -update to accept)\n%s", md, htmlFile, got)
		}
	}
}

// FuzzRender throws random input at the renderer. Whatever comes in, it must
// not panic, and the output must never contain a raw tag from the input.
// `go test` runs the seeds below; `go test -fuzz=FuzzRender` keeps going.
func FuzzRender(f *testing.F) {
	for _, seed := range []string{
		"# h\n\n- a\n  - b\n\n> q\n", "*a **b** c*", "[x](y \"z\")", "```\ncode", "| a |\n|---|\n| b |",
		"<script>", "![i](javascript:1)", "\\", "`", "*_~[](<>)!", "1. a\n\n   b\n2. c", "\t- x\r\n",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, src string) {
		out := Render(src, Options{TOC: true})
		if strings.Contains(out, "<script") || strings.Contains(out, "<iframe") {
			t.Fatalf("raw HTML leaked through for %q:\n%s", src, out)
		}
	})
}

// Inputs that make naive Markdown parsers take quadratic or exponential time.
// Each must render in well under a second; the budget is generous so slow CI
// machines and the race detector don't cause false failures.
func TestNoBlowupOnPathologicalInput(t *testing.T) {
	for name, unit := range map[string]string{
		"unmatched stars":      "*a ",
		"mixed star runs":      "**a *b ",
		"underscores":          "_a_b ",
		"strikethrough":        "~~a ",
		"open brackets":        "[",
		"unfinished links":     "[a](",
		"backtick runs":        "`a ``",
		"deeply nested quotes": ">",
		"list item after item": "- a\n  ",
	} {
		src := strings.Repeat(unit, 20000)
		start := time.Now()
		ToHTML(src)
		if d := time.Since(start); d > 5*time.Second {
			t.Errorf("%s: %v for %d bytes", name, d, len(src))
		}
	}
}
