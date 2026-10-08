#!/usr/bin/env python3
"""Regenerates everything derived from projects/projects.json:

  projects/projects.tsv        used by the publish scripts
  README.md                    project tables + count badge
  index.html                   project cards + counts
  sitemap.xml                  portfolio + live demos

Run after adding or editing a project:  python3 scripts/sync_profile.py
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://sumitrcs.github.io"
CATEGORIES = [
    ("fintech", "🧾 FinTech, GST & accounting (India)"),
    ("systems", "⚙️ Systems & computer science from scratch"),
    ("tools", "🛠️ Developer tools & backend"),
    ("web", "🌐 Web apps"),
]
COLORS = {"fintech": ("#0f9d76", "#00cec9"), "systems": ("#6c5ce7", "#a29bfe"), "tools": ("#0984e3", "#74b9ff"), "web": ("#e17055", "#fdcb6e")}


def replace_between(text: str, start: str, end: str, body: str) -> str:
    i, j = text.index(start) + len(start), text.index(end)
    return text[:i] + body + text[j:]


def sub_count(pattern: str, repl: str, text: str) -> str:
    new, n = re.subn(pattern, repl, text)
    if n == 0:
        raise SystemExit(f"pattern not found: {pattern}")
    return new


def main() -> None:
    projects = json.loads((ROOT / "projects/projects.json").read_text())
    names = [p["repo"] for p in projects]
    if len(set(names)) != len(names):
        raise SystemExit("duplicate project names in projects.json")
    for p in projects:
        if not (ROOT / "projects" / p["repo"]).is_dir():
            raise SystemExit(f"projects/{p['repo']} does not exist")
        if p["cat"] not in COLORS:
            raise SystemExit(f"{p['repo']}: unknown category {p['cat']}")
    n = len(projects)
    langs = len({p["lang"] for p in projects})

    (ROOT / "projects/projects.tsv").write_text(
        "".join("\t".join([p["repo"], p["desc"], ",".join(p["topics"]), "pages" if p.get("pages") else ""]) + "\n" for p in projects)
    )

    # README tables
    sections = []
    for key, title in CATEGORIES:
        rows = ["| Project | What it does | Stack |", "|---|---|---|"]
        for p in (x for x in projects if x["cat"] == key):
            live = f" · [**live demo**]({SITE}/{p['repo']}/)" if p.get("pages") else ""
            rows.append(f"| {p['emoji']} [**{p['repo']}**](https://github.com/Sumitrcs/{p['repo']}){live} | {p['desc']} | `{p['lang']}` |")
        sections.append(f"### {title}\n\n" + "\n".join(rows) + "\n")
    readme = (ROOT / "README.md").read_text()
    readme = replace_between(readme, "<!-- projects:start -->\n", "<!-- projects:end -->", "\n".join(sections))
    readme = sub_count(r"Open%20source-\d+%20projects", f"Open%20source-{n}%20projects", readme)
    readme = sub_count(r'alt="\d+ projects"', f'alt="{n} projects"', readme)
    (ROOT / "README.md").write_text(readme)

    # Portfolio cards
    cards = []
    for p in projects:
        c1, c2 = COLORS[p["cat"]]
        tags = "".join(f"<span>{html.escape(t)}</span>" for t in p["tags"])
        live = f'<a href="{SITE}/{p["repo"]}/" target="_blank" rel="noopener">Live demo →</a>' if p.get("pages") else ""
        cards.append(f'''          <article class="project reveal" data-category="{p["cat"]}">
            <div class="project-thumb" style="--c1:{c1};--c2:{c2}" aria-hidden="true">{p["emoji"]}</div>
            <div class="project-body">
              <h3>{html.escape(p["title"])}</h3>
              <p>{html.escape(p["desc"])}</p>
              <div class="project-tags">{tags}</div>
              <div class="project-links"><a href="https://github.com/Sumitrcs/{p["repo"]}" target="_blank" rel="noopener">Source code</a>{live}</div>
            </div>
          </article>
''')
    page = (ROOT / "index.html").read_text()
    page = replace_between(page, "<!-- cards:start -->\n", "<!-- cards:end -->", "".join(cards))
    page = sub_count(r"\d+ open-source projects", f"{n} open-source projects", page)
    page = sub_count(r"See \d+ projects", f"See {n} projects", page)
    page = sub_count(r'data-target="\d+">0</h3><p>Open-source projects', f'data-target="{n}">0</h3><p>Open-source projects', page)
    page = sub_count(r'data-target="\d+">0</h3><p>Programming languages', f'data-target="{langs}">0</h3><p>Programming languages', page)
    page = sub_count(r'data-target="\d+">0</h3><p>CI-tested repositories', f'data-target="{n}">0</h3><p>CI-tested repositories', page)
    page = sub_count(r'<h2>\d+ <span class="gradient-text">Projects', f'<h2>{n} <span class="gradient-text">Projects', page)
    (ROOT / "index.html").write_text(page)

    # Sitemap
    urls = [f"  <url>\n    <loc>{SITE}/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>"]
    urls += [f"  <url>\n    <loc>{SITE}/{p['repo']}/</loc>\n    <changefreq>monthly</changefreq>\n  </url>" for p in projects if p.get("pages")]
    (ROOT / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(urls) + "\n</urlset>\n")
    print(f"synced {n} projects ({langs} languages)")


if __name__ == "__main__":
    main()
