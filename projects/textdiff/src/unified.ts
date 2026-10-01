import { diff } from "./myers.ts";
import { splitLines } from "./lines.ts";

export interface Hunk {
  oldStart: number; // 1-based, as printed in "@@ -start,count"
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Prefixed with " ", "-" or "+"; "\ No newline at end of file" follows the affected line. */
  lines: string[];
}

export interface UnifiedOptions {
  context?: number;
  oldName?: string;
  newName?: string;
  ignoreWhitespace?: boolean;
}

const NO_EOL = "\\ No newline at end of file";
// A missing final newline is part of the last line's identity: "x" and "x\n"
// must compare as different lines. Tag such lines internally with a sentinel.
const SENTINEL = "\u0000no-eol";

function toLines(text: string): string[] {
  const { lines, finalNewline } = splitLines(text);
  if (!finalNewline && lines.length) lines[lines.length - 1] += SENTINEL;
  return lines;
}

function fromLines(lines: string[]): string {
  if (!lines.length) return "";
  const last = lines[lines.length - 1];
  if (last.endsWith(SENTINEL)) return [...lines.slice(0, -1), last.slice(0, -SENTINEL.length)].join("\n");
  return lines.join("\n") + "\n";
}

function emit(tag: string, line: string, out: string[]) {
  if (line.endsWith(SENTINEL)) out.push(tag + line.slice(0, -SENTINEL.length), NO_EOL);
  else out.push(tag + line);
}

/** Builds hunks the way `diff -u` / `git diff` do, merging hunks whose context overlaps. */
export function hunks(oldText: string, newText: string, opts: UnifiedOptions = {}): Hunk[] {
  const context = opts.context ?? 3;
  const a = toLines(oldText);
  const b = toLines(newText);
  const norm = (s: string) => (opts.ignoreWhitespace ? s.replace(/\s+/g, " ").trim() : s);
  const edits = diff(a, b, (x, y) => norm(x) === norm(y));

  type Row = { tag: " " | "-" | "+"; text: string; oldNo: number; newNo: number };
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const e of edits) {
    for (const item of e.items) {
      if (e.op === "equal") rows.push({ tag: " ", text: a[oldNo], oldNo: oldNo++, newNo: newNo++ });
      else if (e.op === "delete") rows.push({ tag: "-", text: item, oldNo: oldNo++, newNo });
      else rows.push({ tag: "+", text: item, oldNo, newNo: newNo++ });
    }
  }

  const changed = rows.flatMap((r, i) => (r.tag !== " " ? [i] : []));
  const out: Hunk[] = [];
  for (let i = 0; i < changed.length; i++) {
    const from = Math.max(0, changed[i] - context);
    let to = Math.min(rows.length - 1, changed[i] + context);
    while (i + 1 < changed.length && changed[i + 1] - context <= to + 1) {
      i++;
      to = Math.min(rows.length - 1, changed[i] + context);
    }
    const slice = rows.slice(from, to + 1);
    const oldLines = slice.filter((r) => r.tag !== "+").length;
    const newLines = slice.filter((r) => r.tag !== "-").length;
    const lines: string[] = [];
    for (const r of slice) emit(r.tag, r.text, lines);
    out.push({
      // An empty range is printed as the line *before* it (e.g. "-0,0" for an empty file).
      oldStart: oldLines ? slice[0].oldNo + 1 : slice[0].oldNo,
      oldLines,
      newStart: newLines ? slice[0].newNo + 1 : slice[0].newNo,
      newLines,
      lines,
    });
  }
  return out;
}

export function unifiedDiff(oldText: string, newText: string, opts: UnifiedOptions = {}): string {
  const hs = hunks(oldText, newText, opts);
  if (!hs.length) return "";
  const out = [`--- ${opts.oldName ?? "a"}`, `+++ ${opts.newName ?? "b"}`];
  const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);
  for (const h of hs) out.push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`, ...h.lines);
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

export class PatchError extends Error {}

export function parsePatch(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      out.push(cur);
    } else if (cur && (line[0] === " " || line[0] === "-" || line[0] === "+" || line.startsWith("\\"))) {
      if (!line.startsWith("--- ") && !line.startsWith("+++ ")) cur.lines.push(line);
    } else if (line.startsWith("--- ") || line.startsWith("diff ")) {
      cur = null;
    }
  }
  for (const h of out) {
    const old = h.lines.filter((l) => l[0] === " " || l[0] === "-").length;
    const neu = h.lines.filter((l) => l[0] === " " || l[0] === "+").length;
    if (old !== h.oldLines || neu !== h.newLines) {
      throw new PatchError(`Malformed hunk @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ (has ${old}/${neu} lines)`);
    }
  }
  return out;
}

/**
 * Applies a unified diff. Each hunk is tried at its stated position first,
 * then at increasing offsets above and below (like GNU patch), so a patch
 * still applies after unrelated lines were added elsewhere in the file.
 */
export function applyPatch(text: string, patch: string, maxOffset = 200): string {
  const result = toLines(text);
  let shift = 0;
  for (const h of parsePatch(patch)) {
    const before: string[] = [];
    const after: string[] = [];
    h.lines.forEach((l, i) => {
      if (l.startsWith("\\")) return;
      const eol = h.lines[i + 1]?.startsWith("\\") ? SENTINEL : "";
      if (l[0] !== "+") before.push(l.slice(1) + eol);
      if (l[0] !== "-") after.push(l.slice(1) + eol);
    });
    const expected = (h.oldLines ? h.oldStart - 1 : h.oldStart) + shift;
    const at = locate(result, before, expected, maxOffset);
    if (at < 0) throw new PatchError(`Hunk @@ -${h.oldStart},${h.oldLines} @@ does not apply`);
    result.splice(at, before.length, ...after);
    shift = at - (h.oldLines ? h.oldStart - 1 : h.oldStart) + after.length - before.length;
  }
  return fromLines(result);
}

function locate(lines: string[], needle: string[], expected: number, maxOffset: number): number {
  const fits = (pos: number) => pos >= 0 && pos + needle.length <= lines.length && needle.every((l, i) => lines[pos + i] === l);
  for (let off = 0; off <= maxOffset; off++) {
    if (fits(expected - off)) return expected - off;
    if (fits(expected + off)) return expected + off;
  }
  return -1;
}
