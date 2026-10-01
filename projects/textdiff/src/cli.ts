#!/usr/bin/env node
/*
 * textdiff a.txt b.txt [-U n] [-w] [--words]   unified diff (coloured on a TTY)
 * textdiff --apply file.txt patch.diff           apply a patch, print result
 * textdiff --merge ours.txt base.txt theirs.txt  three-way merge
 */
import { readFileSync } from "node:fs";
import { applyPatch, diffWords, merge3, unifiedDiff } from "./index.ts";

const args = process.argv.slice(2);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const read = (p: string) => readFileSync(p, "utf8");

function main(): number {
  if (args[0] === "--apply" && args.length === 3) {
    process.stdout.write(applyPatch(read(args[1]), read(args[2])));
    return 0;
  }
  if (args[0] === "--merge" && args.length === 4) {
    const [ours, base, theirs] = args.slice(1);
    const r = merge3(read(base), read(ours), read(theirs), { ours, base, theirs });
    process.stdout.write(r.text);
    if (r.conflicts) process.stderr.write(`${r.conflicts} conflict(s)\n`);
    return r.conflicts ? 1 : 0;
  }
  const files = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-U");
  if (files.length !== 2) {
    process.stderr.write("usage: textdiff OLD NEW [-U n] [-w] [--words] | --apply FILE PATCH | --merge OURS BASE THEIRS\n");
    return 2;
  }
  const [oldFile, newFile] = files;
  const oldText = read(oldFile);
  const newText = read(newFile);

  if (args.includes("--words")) {
    for (const s of diffWords(oldText, newText)) {
      process.stdout.write(s.op === "equal" ? s.text : s.op === "insert" ? paint("32;4", s.text) : paint("31;9", s.text));
    }
    return oldText === newText ? 0 : 1;
  }

  const context = args.includes("-U") ? Number(args[args.indexOf("-U") + 1]) : 3;
  const out = unifiedDiff(oldText, newText, { context, oldName: oldFile, newName: newFile, ignoreWhitespace: args.includes("-w") });
  for (const line of out.split("\n").slice(0, -1)) {
    const c = line.startsWith("@@") ? "36" : line.startsWith("+++") || line.startsWith("---") ? "1" : line[0] === "+" ? "32" : line[0] === "-" ? "31" : "";
    process.stdout.write((c ? paint(c, line) : line) + "\n");
  }
  return out ? 1 : 0; // same convention as diff(1)
}

process.exitCode = main();
