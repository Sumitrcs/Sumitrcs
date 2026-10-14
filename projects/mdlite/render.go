package mdlite

import (
	"fmt"
	"strings"
	"unicode"
)

// Options change how a document is rendered.
type Options struct {
	// TOC adds a table of contents (from the level 2 and 3 headings) where
	// the document contains a line "[TOC]", or at the top if there is none.
	TOC bool
}

// HeadingInfo is one heading, for building a table of contents.
type HeadingInfo struct {
	Level int
	Text  string // plain text, markup removed
	ID    string // the id attribute, e.g. "getting-started"
}

// Document is a parsed Markdown file.
type Document struct {
	Blocks   []*Block
	Headings []HeadingInfo
}

// Parse runs the block pass and assigns every heading a unique id.
func Parse(src string) *Document {
	doc := &Document{Blocks: parseBlocks(normalize(src), 0)}
	used := map[string]int{}
	var walk func([]*Block)
	walk = func(blocks []*Block) {
		for _, b := range blocks {
			if b.Kind == Heading {
				text := plainText(b.Text)
				doc.Headings = append(doc.Headings, HeadingInfo{Level: b.Level, Text: text, ID: uniqueSlug(text, used)})
			}
			walk(b.Children)
		}
	}
	walk(doc.Blocks)
	return doc
}

// ToHTML converts Markdown to HTML with default options.
func ToHTML(src string) string { return Render(src, Options{}) }

// Render converts Markdown to an HTML fragment.
func Render(src string, opt Options) string {
	doc := Parse(src)
	r := &renderer{doc: doc}
	r.blocks(doc.Blocks, false)
	html := r.out.String()
	if opt.TOC {
		toc := doc.TOC()
		if strings.Contains(html, "<p>[TOC]</p>\n") {
			html = strings.Replace(html, "<p>[TOC]</p>\n", toc, 1)
		} else {
			html = toc + html
		}
	}
	return html
}

// TOC returns a nested list of links to the level 2 and 3 headings:
//
//	<li><a href="#install">Install</a>
//	<ul>
//	<li><a href="#from-source">From source</a></li>
//	</ul>
//	</li>
func (d *Document) TOC() string {
	var b strings.Builder
	b.WriteString("<nav class=\"toc\">\n<ul>\n")
	itemOpen, subOpen := false, false
	for _, h := range d.Headings {
		link := fmt.Sprintf("<a href=\"#%s\">%s</a>", h.ID, escapeHTML(h.Text))
		switch h.Level {
		case 2:
			if subOpen {
				b.WriteString("</ul>\n")
				subOpen = false
			}
			if itemOpen {
				b.WriteString("</li>\n")
			}
			b.WriteString("<li>" + link)
			itemOpen = true
		case 3:
			if !subOpen {
				if !itemOpen {
					b.WriteString("<li>")
					itemOpen = true
				}
				b.WriteString("\n<ul>\n")
				subOpen = true
			}
			b.WriteString("<li>" + link + "</li>\n")
		}
	}
	if subOpen {
		b.WriteString("</ul>\n")
	}
	if itemOpen {
		b.WriteString("</li>\n")
	}
	b.WriteString("</ul>\n</nav>\n")
	return b.String()
}

type renderer struct {
	doc     *Document
	heading int // index of the next heading in doc.Headings
	out     strings.Builder
}

// blocks writes a list of blocks. In a tight list, paragraphs are written
// without <p> tags so the items don't get extra spacing.
func (r *renderer) blocks(blocks []*Block, tight bool) {
	for _, b := range blocks {
		r.block(b, tight)
	}
}

func (r *renderer) block(b *Block, tight bool) {
	w := &r.out
	switch b.Kind {
	case Paragraph:
		if tight {
			w.WriteString(renderInline(b.Text) + "\n")
		} else {
			w.WriteString("<p>" + renderInline(b.Text) + "</p>\n")
		}
	case Heading:
		id := r.doc.Headings[r.heading].ID
		r.heading++
		fmt.Fprintf(w, "<h%d id=\"%s\">%s</h%d>\n", b.Level, id, renderInline(b.Text), b.Level)
	case CodeBlock:
		class := ""
		if b.Lang != "" {
			class = ` class="language-` + escapeHTML(b.Lang) + `"`
		}
		w.WriteString("<pre><code" + class + ">" + escapeHTML(b.Text) + "</code></pre>\n")
	case Quote:
		w.WriteString("<blockquote>\n")
		r.blocks(b.Children, false)
		w.WriteString("</blockquote>\n")
	case List:
		tag := "ul"
		start := ""
		if b.Ordered {
			tag = "ol"
			if b.Start != 1 {
				start = fmt.Sprintf(" start=\"%d\"", b.Start)
			}
		}
		w.WriteString("<" + tag + start + ">\n")
		for _, item := range b.Children {
			w.WriteString("<li>")
			r.listItem(item, b.Tight)
			w.WriteString("</li>\n")
		}
		w.WriteString("</" + tag + ">\n")
	case Table:
		r.table(b)
	case Rule:
		w.WriteString("<hr>\n")
	}
}

func (r *renderer) listItem(item *Block, tight bool) {
	// "<li>text</li>" for a simple tight item; otherwise put blocks on their own lines.
	if tight && len(item.Children) == 1 && item.Children[0].Kind == Paragraph {
		r.out.WriteString(renderInline(item.Children[0].Text))
		return
	}
	if len(item.Children) > 0 {
		r.out.WriteString("\n")
	}
	r.blocks(item.Children, tight)
}

func (r *renderer) table(t *Block) {
	w := &r.out
	cell := func(tag string, col int, text string) {
		align := ""
		if t.Align[col] != "" {
			align = ` style="text-align:` + t.Align[col] + `"`
		}
		fmt.Fprintf(w, "<%s%s>%s</%s>", tag, align, renderInline(text), tag)
	}
	w.WriteString("<table>\n<thead>\n<tr>")
	for col, text := range t.Rows[0] {
		cell("th", col, text)
	}
	w.WriteString("</tr>\n</thead>\n")
	if len(t.Rows) > 1 {
		w.WriteString("<tbody>\n")
		for _, row := range t.Rows[1:] {
			w.WriteString("<tr>")
			for col, text := range row {
				cell("td", col, text)
			}
			w.WriteString("</tr>\n")
		}
		w.WriteString("</tbody>\n")
	}
	w.WriteString("</table>\n")
}

// uniqueSlug makes a URL-friendly id from heading text, the way GitHub does:
// lower case, spaces to dashes, punctuation dropped, and -1, -2 ... added
// when the same heading appears again.
func uniqueSlug(text string, used map[string]int) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(text)) {
		switch {
		case r == ' ' || r == '-':
			b.WriteRune('-')
		case r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		}
	}
	slug := b.String()
	if slug == "" {
		slug = "section"
	}
	n := used[slug]
	used[slug] = n + 1
	if n > 0 {
		return fmt.Sprintf("%s-%d", slug, n)
	}
	return slug
}
