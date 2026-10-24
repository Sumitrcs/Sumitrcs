<h1 align="center">Hi, I'm Sumit 👋 <sub>(@Sumitrcs)</sub></h1>

<p align="center">
  <b>Full-stack & systems developer from Delhi, India</b><br/>
  I build software for Indian businesses — GST, accounting, Tally and GeM tools — and I like building the hard parts from scratch.
</p>

<p align="center">
  <a href="https://sumitrcs.github.io"><img src="https://img.shields.io/badge/Portfolio-sumitrcs.github.io-6c5ce7?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Portfolio"/></a>
  <a href="https://github.com/Sumitrcs?tab=repositories"><img src="https://img.shields.io/badge/Open%20source-37%20projects-0f9d76?style=for-the-badge&logo=github" alt="37 projects"/></a>
</p>

---

### 🧑‍💻 About me

- 🇮🇳 Based in **Delhi, India**
- 🧾 Domain: **GST & Indian tax rules, accounting, Tally Prime, GeM procurement, SEO**
- ⚙️ Engineering: **databases, networking, compression, compilers, algorithms**
- ✅ Every project here is **tested, documented and CI-checked** — most have **zero runtime dependencies**
- 💼 Open to **freelance projects and full-time roles**

### 🛠️ Tech stack

<p>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript"/>
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python"/>
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go"/>
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust"/>
  <img src="https://img.shields.io/badge/C-A8B9CC?style=flat-square&logo=c&logoColor=black" alt="C"/>
  <img src="https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite"/>
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white" alt="HTML5"/>
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white" alt="CSS3"/>
  <img src="https://img.shields.io/badge/GitHub%20Actions-2088FF?style=flat-square&logo=githubactions&logoColor=white" alt="GitHub Actions"/>
  <img src="https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux"/>
  <img src="https://img.shields.io/badge/Tally%20Prime-1F4E79?style=flat-square" alt="Tally Prime"/>
</p>

## 🚀 Projects

<!-- projects:start -->
### 🧾 FinTech, GST & accounting (India)

| Project | What it does | Stack |
|---|---|---|
| 🧾 [**gst-invoice-engine**](https://github.com/Sumitrcs/gst-invoice-engine) | Paise-exact GST invoices: CGST/SGST/UTGST/IGST by place of supply, SEZ & exports, cess, HSN summary, round-off and amount in words. | `TypeScript` |
| 🪪 [**india-kyc-validators**](https://github.com/Sumitrcs/india-kyc-validators) | Zero-dependency validators for GSTIN (mod-36 checksum), PAN, TAN, IFSC, Aadhaar (Verhoeff), UPI, PIN code and vehicle numbers. | `TypeScript` |
| 💰 [**india-income-tax**](https://github.com/Sumitrcs/india-income-tax) · [**live demo**](https://sumitrcs.github.io/india-income-tax/) | Old vs new regime for FY 2025-26 with 87A marginal relief, surcharge relief, HRA and break-even deductions. Live web app. | `JavaScript` |
| 🏦 [**bank-recon**](https://github.com/Sumitrcs/bank-recon) | Five-pass matching (UTR/cheque, date window, fuzzy narration, split deposits) that produces a ready Bank Reconciliation Statement. | `Python` |
| 🔁 [**tally-xml-bridge**](https://github.com/Sumitrcs/tally-xml-bridge) | Spreadsheets to Tally Prime import XML (vouchers, GST sales, ledger masters) and Tally exports back to CSV, with validation. | `Python` |
| 🏛️ [**gem-bid-analyzer**](https://github.com/Sumitrcs/gem-bid-analyzer) | Eligibility go/no-go with document checklist, L1 ranking with MSE & Make-in-India preference, and price advice from past awards. | `Python` |
| 📒 [**ledger-cli**](https://github.com/Sumitrcs/ledger-cli) | Plain-text double-entry accounting: balance assertions, trial balance, P&L and balance sheet with Indian number formatting. | `Go` |
| 🧾 [**gst-invoice-maker**](https://github.com/Sumitrcs/gst-invoice-maker) · [**live demo**](https://sumitrcs.github.io/gst-invoice-maker/) | Browser-only GST tax invoice generator: GSTIN check-digit validation, auto CGST/SGST or IGST, HSN summary, amount in words, A4 PDF. | `JavaScript` |
| 🏠 [**emi-planner**](https://github.com/Sumitrcs/emi-planner) | Loan EMI planner: amortization schedule, prepayment (cut tenure vs cut EMI), flat-to-reducing rate truth, real APR with fees, FY-wise totals. | `Python` |
| 🧮 [**itc-recon**](https://github.com/Sumitrcs/itc-recon) | GST input tax credit reconciliation: purchase register vs GSTR-2B (portal JSON or CSV). Exact + fuzzy invoice matching, claimable vs at-risk ITC, supplier follow-up list. | `Go` |
| 📈 [**matchbook**](https://github.com/Sumitrcs/matchbook) | Stock exchange matching engine: limit order book with price-time priority, limit/market/IOC/FOK/post-only orders, cancel and modify. Millions of orders per second, tested against a reference engine. | `Rust` |

### ⚙️ Systems & computer science from scratch

| Project | What it does | Stack |
|---|---|---|
| 🗄️ [**lsm-kv**](https://github.com/Sumitrcs/lsm-kv) | Crash-safe storage engine: write-ahead log, skip-list memtable, SSTables with sparse index and Bloom filters, compaction, manifest. | `Go` |
| 🦀 [**rhttp**](https://github.com/Sumitrcs/rhttp) | HTTP server from scratch with std only: thread pool, keep-alive and pipelining, router with params, static files with ETags. | `Rust` |
| 🗜️ [**rzip**](https://github.com/Sumitrcs/rzip) | LZ77 with hash chains + canonical length-limited Huffman coding and CRC-32. Matches gzip's compression ratio. | `Rust` |
| 🧩 [**dlx-solver**](https://github.com/Sumitrcs/dlx-solver) | Knuth's Algorithm X with Dancing Links in C11: generic exact cover, Sudoku up to 25×25 and N-Queens. Sanitizer-clean. | `C` |
| 🔤 [**tinylang**](https://github.com/Sumitrcs/tinylang) | A small programming language: hand-written lexer, Pratt parser, closures, maps, ranges, string interpolation and a REPL. | `TypeScript` |
| 🔎 [**csvql**](https://github.com/Sumitrcs/csvql) | A query engine for CSV files: joins (hash + nested loop), GROUP BY, HAVING, CASE, LIKE and three-valued NULL logic. | `Python` |
| 🌱 [**minigit**](https://github.com/Sumitrcs/minigit) | A small, readable Git in Python that writes Git's real object, tree, commit and index formats — the real git opens its repositories. | `Python` |
| 🧠 [**tinyredis**](https://github.com/Sumitrcs/tinyredis) | A small Redis server that real redis-cli talks to: RESP protocol, strings, lists, hashes, TTL expiry, pipelining and AOF persistence. | `Go` |
| 🧱 [**tinymalloc**](https://github.com/Sumitrcs/tinymalloc) | malloc/free/realloc from scratch in C: boundary tags, explicit free list, split & coalesce, first vs best fit, heap checker and ASCII heap map. | `C` |
| 🔍 [**dupfind**](https://github.com/Sumitrcs/dupfind) | Find duplicate files fast: size → 4 KiB prefix → full SHA-256 (written from scratch), hashed on all cores. Reads 1.7% of a 2 GiB tree. sha256sum-compatible. | `Rust` |
| 🐚 [**tinysh**](https://github.com/Sumitrcs/tinysh) | A Unix shell in C: lexer, recursive-descent parser, fork/exec, pipes, redirections, && || ;, $VARS, quotes, globbing, builtins and Ctrl-C. Tested against /bin/sh. | `C` |
| 🗄️ [**snapvault**](https://github.com/Sumitrcs/snapvault) | Deduplicating, incremental backups like restic and borg: content-defined chunking (FastCDC gear hash), SHA-256 content-addressed storage, snapshots, restore, diff, check and prune. | `Python` |

### 🛠️ Developer tools & backend

| Project | What it does | Stack |
|---|---|---|
| 🚦 [**ratelimit-go**](https://github.com/Sumitrcs/ratelimit-go) | Token bucket, fixed & sliding window and GCRA behind one API, with 64-shard locking and net/http middleware. | `Go` |
| ⚙️ [**taskq**](https://github.com/Sumitrcs/taskq) | Durable background jobs on SQLite: atomic claims, leases with heartbeats, backoff with jitter, dead-letter queue, asyncio workers. | `Python` |
| ⏰ [**cronkit**](https://github.com/Sumitrcs/cronkit) | Cron parser and scheduler with seconds, L, nth weekday, IANA time zones and correct DST handling, plus plain-English descriptions. | `TypeScript` |
| 📝 [**textdiff**](https://github.com/Sumitrcs/textdiff) | Myers O(ND) diff, git-compatible unified diffs, offset-tolerant patching, diff3 three-way merge and word-level diffs. | `TypeScript` |
| 🕷️ [**sitecrawler**](https://github.com/Sumitrcs/sitecrawler) | Polite concurrent crawler: robots.txt (RFC 9309), per-host rate limits, broken-link report and sitemap.xml generation. | `Go` |
| 🔎 [**tinyregex**](https://github.com/Sumitrcs/tinyregex) | Regex engine from scratch: recursive-descent parser, Thompson NFA compiler and Pike VM. Linear time, captures, named groups, plus a grep CLI. | `Rust` |
| 📝 [**mdlite**](https://github.com/Sumitrcs/mdlite) | Markdown to HTML from scratch in Go: two-pass parser, CommonMark delimiter stack, GFM tables, TOC, XSS-safe output, fuzzed and blowup-proof. | `Go` |
| 🧠 [**recall**](https://github.com/Sumitrcs/recall) | Spaced-repetition flashcards in the terminal: the SM-2 algorithm, SQLite storage, CSV import/export, study sessions, streaks and retention stats. Stdlib only. | `Python` |
| 📝 [**tinyed**](https://github.com/Sumitrcs/tinyed) | A terminal text editor in 1,500 lines of C with no libraries: raw mode, syntax highlighting for 5 languages, search, undo/redo, auto-indent and crash-safe saving. Tested through a pseudo-terminal. | `C` |

### 🌐 Web apps

| Project | What it does | Stack |
|---|---|---|
| 🧭 [**pathfinder-visualizer**](https://github.com/Sumitrcs/pathfinder-visualizer) · [**live demo**](https://sumitrcs.github.io/pathfinder-visualizer/) | Watch A*, Dijkstra, BFS, bidirectional BFS, greedy and DFS search a weighted grid; animated maze generation. Live demo. | `JavaScript` |
| 🤝 [**settle-up**](https://github.com/Sumitrcs/settle-up) · [**live demo**](https://sumitrcs.github.io/settle-up/) | Split group expenses four ways and settle with the provably minimum number of payments (bitmask DP). Offline, shareable by link. | `JavaScript` |
| 📲 [**upi-qr**](https://github.com/Sumitrcs/upi-qr) · [**live demo**](https://sumitrcs.github.io/upi-qr/) | Scan & Pay UPI QR codes for shops, with a QR encoder written from scratch: Reed–Solomon over GF(256), masks and penalty scoring. Verified by a real decoder. | `TypeScript` |
| 🔍 [**json-lens**](https://github.com/Sumitrcs/json-lens) · [**live demo**](https://sumitrcs.github.io/json-lens/) | JSON validator and explorer with a hand-written parser: errors that point to the exact line and explain the fix, tree view with copyable paths, TypeScript types and CSV export. | `TypeScript` |
| 📡 [**upwatch**](https://github.com/Sumitrcs/upwatch) | Self-hosted uptime monitor and status page: concurrent HTTP checks, debounced Slack/Discord webhook alerts, incidents, 24-hour uptime bars and latency percentiles. One Go binary. | `Go` |
<!-- projects:end -->

## 📊 GitHub stats

<p>
  <img height="165" src="https://github-readme-stats.vercel.app/api?username=Sumitrcs&show_icons=true&hide_border=true&count_private=true" alt="Sumitrcs GitHub stats"/>
  <img height="165" src="https://github-readme-stats.vercel.app/api/top-langs/?username=Sumitrcs&layout=compact&hide_border=true&langs_count=8" alt="Sumitrcs top languages"/>
</p>

## 🤝 Let's connect

- 🌐 Portfolio: **[sumitrcs.github.io](https://sumitrcs.github.io)**
- 🐙 GitHub: **[@Sumitrcs](https://github.com/Sumitrcs)**
