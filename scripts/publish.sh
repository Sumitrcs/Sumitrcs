#!/usr/bin/env bash
# Publishes every folder in projects/ as its own public GitHub repository,
# adds topics, enables GitHub Pages for the web apps, and deploys the
# portfolio to https://<user>.github.io.
#
# Requirements: git and the GitHub CLI (https://cli.github.com), logged in:
#   gh auth login
# Usage (from the repository root, works in Git Bash on Windows too):
#   bash scripts/publish.sh            # publish everything
#   bash scripts/publish.sh rzip       # publish just one project
set -euo pipefail

OWNER="${OWNER:-$(gh api user --jq .login)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

publish_dir() { # <name> <source-dir> <description> <topics-csv> <pages?>
  local name="$1" src="$2" desc="$3" topics="$4" pages="$5"
  local homepage=""
  [[ -n "$pages" ]] && homepage="https://${OWNER,,}.github.io/$name/"

  if gh repo view "$OWNER/$name" >/dev/null 2>&1; then
    echo "• $name: repository exists — updating description/topics only"
  else
    echo "• $name: creating repository"
    gh repo create "$OWNER/$name" --public --description "$desc" ${homepage:+--homepage "$homepage"} >/dev/null
    local dir="$WORK/$name"
    mkdir -p "$dir"
    cp -R "$src"/. "$dir"/
    (
      cd "$dir"
      git init -q -b main
      git add -A
      git commit -q -m "Initial commit"
      git remote add origin "https://github.com/$OWNER/$name.git"
      git push -q -u origin main
    )
  fi

  gh repo edit "$OWNER/$name" --description "$desc" ${homepage:+--homepage "$homepage"} >/dev/null
  if [[ -n "$topics" ]]; then
    local args=()
    IFS=',' read -ra list <<<"$topics"
    for t in "${list[@]}"; do args+=(--add-topic "$t"); done
    gh repo edit "$OWNER/$name" "${args[@]}" >/dev/null
  fi
  if [[ -n "$pages" ]]; then
    gh api -X POST "repos/$OWNER/$name/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
      && echo "  Pages enabled: $homepage" || echo "  Pages already enabled"
  fi
}

only="${1:-}"
while IFS=$'\t' read -r name desc topics pages; do
  [[ -z "$name" || ( -n "$only" && "$name" != "$only" ) ]] && continue
  publish_dir "$name" "$ROOT/projects/$name" "$desc" "$topics" "$pages"
done <"$ROOT/projects/projects.tsv"

if [[ -z "$only" || "$only" == "portfolio" ]]; then
  site="$WORK/site"
  mkdir -p "$site"
  cp "$ROOT"/{index.html,styles.css,script.js,robots.txt,sitemap.xml} "$site"/
  publish_dir "${OWNER}.github.io" "$site" "Portfolio of Sumit (Sumitrcs) — full-stack & systems developer from Delhi, India" \
    "portfolio,developer-portfolio,sumitrcs,html,css,javascript" ""
  gh api -X POST "repos/$OWNER/${OWNER}.github.io/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true
  gh repo edit "$OWNER/${OWNER}.github.io" --homepage "https://${OWNER,,}.github.io" >/dev/null
  gh repo edit "$OWNER/$OWNER" --description "Sumit (Sumitrcs) — GitHub profile" \
    --homepage "https://${OWNER,,}.github.io" >/dev/null || true
  echo "• Portfolio: https://${OWNER,,}.github.io (first deploy takes a minute or two)"
fi

echo
echo "Done. Next: on your profile page click 'Customize your pins' and pin your favourite six projects."
