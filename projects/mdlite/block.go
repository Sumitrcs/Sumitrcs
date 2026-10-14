package mdlite

import (
	"regexp"
	"strconv"
	"strings"
)

// Markdown is parsed in two passes, like most real implementations:
//
//  1. Block pass (this file): split the document into lines and group them
//     into headings, paragraphs, lists, code blocks, quotes and tables.
//  2. Inline pass (inline.go): inside each paragraph, heading and table cell,
//     find *emphasis*, `code`, [links](...) and so on.
//
// Doing blocks first matters: a "*" at the start of a line is a list bullet,
// while the same "*" in the middle of a sentence starts emphasis.

// Kind says what sort of block a Block is.
type Kind int

const (
	Paragraph Kind = iota
	Heading
	CodeBlock
	Quote
	List
	ListItem
	Table
	Rule
)

// Block is one node of the document tree.
type Block struct {
	Kind     Kind
	Level    int      // heading level 1–6
	Text     string   // raw inline text (paragraph, heading) or code (code block)
	Lang     string   // code block language, from ```go
	Ordered  bool     // list: numbered?
	Start    int      // list: first number
	Tight    bool     // list: no blank lines between items, so no <p> inside
	Align    []string // table: "", "left", "center" or "right" per column
	Rows     [][]string
	Children []*Block // quote, list and list item contents
}

var (
	reHeading  = regexp.MustCompile(`^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$`)
	reFence    = regexp.MustCompile("^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*?)[ \t]*$")
	reRule     = regexp.MustCompile(`^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$`)
	reQuote    = regexp.MustCompile(`^ {0,3}> ?`)
	reBullet   = regexp.MustCompile(`^( {0,3})([-*+])( {1,4}|$)`)
	reOrdered  = regexp.MustCompile(`^( {0,3})(\d{1,9})([.)])( {1,4}|$)`)
	reSetext   = regexp.MustCompile(`^ {0,3}(=+|-+)[ \t]*$`)
	reTableSep = regexp.MustCompile(`^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$`)
)

// maxDepth limits how deeply quotes and lists may nest. Real documents never
// come close; the limit stops input like 20,000 ">" characters from making
// the parser do 20,000 passes over the text.
const maxDepth = 64

// parseBlocks turns lines into blocks. It calls itself for the insides of
// quotes and list items, which is how nesting works.
func parseBlocks(lines []string, depth int) []*Block {
	if depth > maxDepth {
		var text []string
		for _, l := range lines {
			text = append(text, strings.TrimSpace(l))
		}
		return []*Block{{Kind: Paragraph, Text: strings.Join(text, "\n")}}
	}
	var blocks []*Block
	for i := 0; i < len(lines); {
		line := lines[i]
		switch {
		case isBlank(line):
			i++

		case reFence.MatchString(line):
			var b *Block
			b, i = parseFence(lines, i)
			blocks = append(blocks, b)

		case reHeading.MatchString(line):
			m := reHeading.FindStringSubmatch(line)
			blocks = append(blocks, &Block{Kind: Heading, Level: len(m[1]), Text: strings.TrimSpace(m[2])})
			i++

		case reRule.MatchString(line):
			blocks = append(blocks, &Block{Kind: Rule})
			i++

		case reQuote.MatchString(line):
			var inner []string
			for i < len(lines) && reQuote.MatchString(lines[i]) {
				inner = append(inner, reQuote.ReplaceAllString(lines[i], ""))
				i++
			}
			blocks = append(blocks, &Block{Kind: Quote, Children: parseBlocks(inner, depth+1)})

		case listMarker(line) != nil:
			var b *Block
			b, i = parseList(lines, i, depth)
			blocks = append(blocks, b)

		case i+1 < len(lines) && strings.Contains(line, "|") && reTableSep.MatchString(lines[i+1]) &&
			len(splitRow(line)) == len(splitRow(lines[i+1])):
			var b *Block
			b, i = parseTable(lines, i)
			blocks = append(blocks, b)

		default:
			var b *Block
			b, i = parseParagraph(lines, i)
			blocks = append(blocks, b)
		}
	}
	return blocks
}

func isBlank(s string) bool { return strings.TrimSpace(s) == "" }

// startsBlock reports whether a line would begin a new block, which ends a
// paragraph without needing a blank line in between.
func startsBlock(line string) bool {
	return reFence.MatchString(line) || reHeading.MatchString(line) || reRule.MatchString(line) ||
		reQuote.MatchString(line) || listMarker(line) != nil
}

func parseFence(lines []string, i int) (*Block, int) {
	m := reFence.FindStringSubmatch(lines[i])
	indent, fence := len(m[1]), m[2]
	lang, _, _ := strings.Cut(m[3], " ")
	var code []string
	for i++; i < len(lines); i++ {
		t := strings.TrimLeft(lines[i], " ")
		// The closing fence uses the same character and is at least as long.
		if len(lines[i])-len(t) <= 3 && strings.HasPrefix(t, fence) && strings.Trim(t, fence[:1]+" \t") == "" {
			i++
			break
		}
		// Remove up to the opening fence's indentation from each line.
		line := lines[i]
		for n := 0; n < indent && strings.HasPrefix(line, " "); n++ {
			line = line[1:]
		}
		code = append(code, line)
	}
	text := strings.Join(code, "\n")
	if len(code) > 0 {
		text += "\n"
	}
	return &Block{Kind: CodeBlock, Lang: lang, Text: text}, i
}

func parseParagraph(lines []string, i int) (*Block, int) {
	var text []string
	for ; i < len(lines); i++ {
		line := lines[i]
		if isBlank(line) {
			break
		}
		// "Title\n=====" or "Title\n-----" turns the paragraph into a heading.
		if len(text) > 0 && reSetext.MatchString(line) {
			level := 1
			if strings.TrimSpace(line)[0] == '-' {
				level = 2
			}
			return &Block{Kind: Heading, Level: level, Text: strings.Join(text, "\n")}, i + 1
		}
		if len(text) > 0 && startsBlock(line) {
			break
		}
		// Keep trailing spaces: two of them at a line end mean a hard line break.
		text = append(text, strings.TrimLeft(line, " "))
	}
	return &Block{Kind: Paragraph, Text: strings.Join(text, "\n")}, i
}

// marker describes the start of a list item: "- ", "* ", "3. ", "1) ".
type marker struct {
	ordered bool
	symbol  string // "-", "*", "+", "." or ")"
	number  int
	content int // column where the item's text starts
}

func listMarker(line string) *marker {
	if m := reBullet.FindStringSubmatch(line); m != nil {
		if reRule.MatchString(line) {
			return nil // "* * *" is a horizontal rule, not a list
		}
		return &marker{symbol: m[2], content: markerWidth(len(m[0]), m[3])}
	}
	if m := reOrdered.FindStringSubmatch(line); m != nil {
		n, _ := strconv.Atoi(m[2])
		return &marker{ordered: true, symbol: m[3], number: n, content: markerWidth(len(m[0]), m[4])}
	}
	return nil
}

// markerWidth is the column where an item's text starts: just after the
// marker and its spaces. An item with nothing after the marker ("-" alone)
// counts as if one space followed it.
func markerWidth(matched int, spaces string) int {
	if spaces == "" {
		return matched + 1
	}
	return matched
}

func (m *marker) sameList(o *marker) bool { return m.ordered == o.ordered && m.symbol == o.symbol }

func parseList(lines []string, i, depth int) (*Block, int) {
	first := listMarker(lines[i])
	list := &Block{Kind: List, Ordered: first.ordered, Start: first.number, Tight: true}
	blankBetween := false

	for i < len(lines) {
		m := listMarker(lines[i])
		if m == nil || !m.sameList(first) {
			break
		}
		if blankBetween {
			list.Tight = false
		}
		// The item's first line, without its marker.
		rest := ""
		if m.content < len(lines[i]) {
			rest = lines[i][m.content:]
		}
		item := []string{rest}
		i++

		// Following lines belong to the item if they are indented at least as
		// far as its text, or are a "lazy" continuation of its paragraph.
		blankBetween = false
		for i < len(lines) {
			line := lines[i]
			if isBlank(line) {
				item = append(item, "")
				i++
				continue
			}
			indent := len(line) - len(strings.TrimLeft(line, " "))
			prevBlank := isBlank(item[len(item)-1])
			if indent >= m.content {
				item = append(item, line[m.content:])
				i++
				continue
			}
			if !prevBlank && !startsBlock(line) {
				item = append(item, line) // lazy continuation
				i++
				continue
			}
			break
		}
		// Trailing blank lines separate this item from the next one.
		for len(item) > 1 && isBlank(item[len(item)-1]) {
			item = item[:len(item)-1]
			blankBetween = true
		}
		if hasInnerBlank(item) {
			list.Tight = false
		}
		list.Children = append(list.Children, &Block{Kind: ListItem, Children: parseBlocks(item, depth+1)})
	}
	return list, i
}

// hasInnerBlank reports a blank line between two blocks of one item, which
// makes the list "loose". Blank lines inside a fenced code block don't count.
func hasInnerBlank(item []string) bool {
	inFence := false
	for k, line := range item {
		if reFence.MatchString(line) {
			inFence = !inFence
		}
		if !inFence && k > 0 && isBlank(line) {
			return true
		}
	}
	return false
}

func parseTable(lines []string, i int) (*Block, int) {
	t := &Block{Kind: Table}
	for _, cell := range splitRow(lines[i+1]) {
		left, right := strings.HasPrefix(cell, ":"), strings.HasSuffix(cell, ":")
		switch {
		case left && right:
			t.Align = append(t.Align, "center")
		case right:
			t.Align = append(t.Align, "right")
		case left:
			t.Align = append(t.Align, "left")
		default:
			t.Align = append(t.Align, "")
		}
	}
	t.Rows = append(t.Rows, splitRow(lines[i]))
	// Like GitHub, the table runs until a blank line or the start of another block.
	for i += 2; i < len(lines) && !isBlank(lines[i]) && !startsBlock(lines[i]); i++ {
		row := splitRow(lines[i])
		// Every row gets exactly as many cells as the header.
		for len(row) < len(t.Align) {
			row = append(row, "")
		}
		t.Rows = append(t.Rows, row[:len(t.Align)])
	}
	return t, i
}

// splitRow splits "| a | b \| c |" into ["a", "b | c"]. A pipe inside
// `code` or escaped as \| does not split.
func splitRow(line string) []string {
	s := strings.TrimSpace(line)
	s = strings.TrimPrefix(s, "|")
	if strings.HasSuffix(s, "|") && !strings.HasSuffix(s, `\|`) {
		s = s[:len(s)-1]
	}
	var cells []string
	var cur strings.Builder
	inCode := false
	for k := 0; k < len(s); k++ {
		c := s[k]
		switch {
		case c == '\\' && k+1 < len(s) && s[k+1] == '|':
			cur.WriteByte('|')
			k++
		case c == '`':
			inCode = !inCode
			cur.WriteByte(c)
		case c == '|' && !inCode:
			cells = append(cells, strings.TrimSpace(cur.String()))
			cur.Reset()
		default:
			cur.WriteByte(c)
		}
	}
	return append(cells, strings.TrimSpace(cur.String()))
}

// normalize turns tabs into spaces (to a tab stop of 4) and \r\n into \n.
func normalize(src string) []string {
	src = strings.ReplaceAll(src, "\r\n", "\n")
	src = strings.ReplaceAll(src, "\r", "\n")
	lines := strings.Split(src, "\n")
	for k, line := range lines {
		if !strings.Contains(line, "\t") {
			continue
		}
		var b strings.Builder
		col := 0
		for _, r := range line {
			if r == '\t' {
				n := 4 - col%4
				b.WriteString(strings.Repeat(" ", n))
				col += n
				continue
			}
			b.WriteRune(r)
			col++
		}
		lines[k] = b.String()
	}
	return lines
}
