# sitecrawler

A fast, **polite**, concurrent website crawler in Go. Point it at a site and
get every page's status, broken links with the page that links to them, the
slowest pages, and a ready-to-submit `sitemap.xml` — handy for SEO audits and
for checking a site before launch.

```
$ sitecrawler -sitemap sitemap.xml https://rcs-demo.local/
200  d=0     4ms  https://rcs-demo.local/
BLK  d=1      0s  https://rcs-demo.local/admin/login
200  d=1     3ms  https://rcs-demo.local/blog
200  d=1     3ms  https://rcs-demo.local/services
404  d=2     2ms  https://rcs-demo.local/blog/old-post
200  d=2     3ms  https://rcs-demo.local/services/gst
...

Crawled 9 URLs in 142ms
  2xx     7
  4xx     1
  robots  1

Broken links (1):
  https://rcs-demo.local/blog/old-post  [404]
      linked from https://rcs-demo.local/blog

sitemap written to sitemap.xml
```

The exit code is `1` when broken links were found, so it works as a CI check.

## Install

```bash
go install github.com/Sumitrcs/sitecrawler@latest
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `-depth` | 3 | maximum link depth from the start page |
| `-max` | 500 | stop after this many URLs (0 = unlimited) |
| `-c` | 8 | concurrent requests |
| `-delay` | 250ms | minimum gap between requests **to the same host** |
| `-timeout` | 15s | per-request timeout |
| `-external` | false | also follow links to other hosts |
| `-ignore-robots` | false | skip robots.txt (only for sites you own) |
| `-jsonl FILE` | | one JSON object per page, for further analysis |
| `-sitemap FILE` | | write a sitemaps.org XML file of indexable pages |
| `-q` | false | don't print each page |

## Being a good citizen

- **robots.txt** per RFC 9309: user-agent groups (longest match wins), `Allow` /
  `Disallow` with `*` and `$` wildcards (longest rule wins, `Allow` on ties),
  `Crawl-delay`, and "5xx on robots.txt means disallow everything"
- **Per-host rate limiting** that holds even with many workers: each request
  reserves the next free time slot for its host under a lock, then sleeps until it
- `rel="nofollow"` links and `<meta name="robots" content="nofollow">` are not followed;
  `noindex` pages are left out of the sitemap
- Identifies itself with a descriptive User-Agent

## Design

```
            ┌──────────── coordinator goroutine ────────────┐
 start ───▶ │ frontier queue · seen set · depth/page limits │
            └───────┬──────────────────────────▲────────────┘
              tasks │ (unbuffered)              │ results
            ┌───────▼───────┐            ┌──────┴──────┐
            │ worker × N    │ ── fetch ─▶│ parse links │
            │ robots cache  │            │ (streaming  │
            │ host limiter  │            │  tokenizer) │
            └───────────────┘            └─────────────┘
```

- A single **coordinator** owns the frontier and the seen-set, so they need
  no locks; workers only fetch and parse. The loop ends when the queue is
  empty and nothing is in flight, when the page budget is spent, or on
  Ctrl+C (partial results are still reported).
- **URL normalisation** (case, default ports, fragments, credentials, `<base href>`)
  prevents fetching the same page twice.
- HTML is parsed with `golang.org/x/net/html`'s **streaming tokenizer** — no DOM is
  built, and bodies are capped at 5 MB.
- robots.txt is fetched **once per host** using `sync.Once`.

## Tests

```bash
go test -race ./...
```

Integration tests run against an `httptest` site with redirects, a 404, a PDF,
robots rules, `<base href>`, nofollow links and a noindex page. Others check
that 8 concurrent workers never hit one host faster than the configured delay,
that a 5xx robots.txt blocks crawling, that cancellation stops an infinite
site within milliseconds, and URL normalisation edge cases.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
