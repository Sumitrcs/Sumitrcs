// Command mdlite converts Markdown to HTML.
//
//	mdlite README.md > readme.html        HTML fragment
//	mdlite -page -toc notes.md > notes.html   full page with styles and a contents list
//	cat post.md | mdlite                  reads standard input
package main

import (
	"flag"
	"fmt"
	"html"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Sumitrcs/mdlite"
)

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s</title>
<style>
:root { color-scheme: light dark; --fg: #1f2328; --bg: #fff; --muted: #59636e; --line: #d1d9e0; --code: #f6f8fa; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --bg: #0d1117; --muted: #9198a1; --line: #3d444d; --code: #151b23; --link: #4493f8; } }
body { margin: 0 auto; max-width: 46rem; padding: 2rem 1rem; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
a { color: var(--link); }
h1, h2 { border-bottom: 1px solid var(--line); padding-bottom: .3em; }
code, pre { font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border-radius: 6px; }
code { padding: .15em .35em; }
pre { padding: 1rem; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote { margin: 0; padding: 0 1em; color: var(--muted); border-left: .25em solid var(--line); }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: .4em .8em; }
img { max-width: 100%%; }
hr { border: 0; border-top: 2px solid var(--line); }
.toc { background: var(--code); border-radius: 6px; padding: .5rem 1rem; }
</style>
</head>
<body>
%s</body>
</html>
`

func main() {
	toc := flag.Bool("toc", false, "add a table of contents (at a [TOC] line, or at the top)")
	full := flag.Bool("page", false, "write a complete HTML page with styles, not just a fragment")
	title := flag.String("title", "", "page title (default: the first heading)")
	out := flag.String("o", "", "write to this file instead of standard output")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: mdlite [-toc] [-page] [-title T] [-o out.html] [file.md]\n\n")
		flag.PrintDefaults()
	}
	// Go's flag package stops at the first file name; keep going so that
	// "mdlite notes.md -o notes.html" works as well as the other order.
	flag.Parse()
	var files []string
	for flag.NArg() > 0 {
		files = append(files, flag.Arg(0))
		if err := flag.CommandLine.Parse(flag.Args()[1:]); err != nil {
			os.Exit(2)
		}
	}

	src, name, err := readInput(files)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mdlite:", err)
		os.Exit(1)
	}
	result := mdlite.Render(src, mdlite.Options{TOC: *toc})
	if *full {
		t := *title
		if t == "" {
			t = firstHeading(src, name)
		}
		result = fmt.Sprintf(page, html.EscapeString(t), result)
	}

	w := os.Stdout
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fmt.Fprintln(os.Stderr, "mdlite:", err)
			os.Exit(1)
		}
		defer f.Close()
		w = f
	}
	if _, err := io.WriteString(w, result); err != nil {
		fmt.Fprintln(os.Stderr, "mdlite:", err)
		os.Exit(1)
	}
}

func readInput(args []string) (src, name string, err error) {
	if len(args) > 1 {
		return "", "", fmt.Errorf("give one file (or none to read standard input)")
	}
	if len(args) == 0 || args[0] == "-" {
		b, err := io.ReadAll(os.Stdin)
		return string(b), "", err
	}
	b, err := os.ReadFile(args[0])
	return string(b), args[0], err
}

func firstHeading(src, name string) string {
	if hs := mdlite.Parse(src).Headings; len(hs) > 0 {
		return hs[0].Text
	}
	if name != "" {
		return strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
	}
	return "Document"
}
