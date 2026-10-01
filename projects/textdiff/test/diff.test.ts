import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, diff, diffWords, distance, merge3, PatchError, parsePatch, unifiedDiff } from "../src/index.ts";

function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

let seed = 12345;
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
const randomLines = (n: number, alphabet = 5) => Array.from({ length: n }, () => "line " + "abcdefgh"[rand(alphabet)]);

function mutate(lines: string[]): string[] {
  const out = [...lines];
  for (let k = rand(6); k >= 0; k--) {
    const pos = rand(out.length + 1);
    const r = rand(3);
    if (r === 0 && out.length) out.splice(pos, 1);
    else if (r === 1) out.splice(pos, 0, "new " + rand(1000));
    else if (out.length) out[Math.min(pos, out.length - 1)] = "changed " + rand(1000);
  }
  return out;
}

test("diff produces a minimal edit script (checked against LCS)", () => {
  for (let t = 0; t < 300; t++) {
    const a = randomLines(rand(25));
    const b = rand(2) ? mutate(a) : randomLines(rand(25));
    const edits = diff(a, b);
    assert.equal(distance(edits), a.length + b.length - 2 * lcsLength(a, b));
    // Rebuild both sides from the script
    const fromA = edits.filter((e) => e.op !== "insert").flatMap((e) => e.items);
    const fromB = edits.filter((e) => e.op !== "delete").flatMap((e) => e.items);
    assert.deepEqual(fromA, a);
    assert.deepEqual(fromB, b);
  }
});

test("classic example: ABCABBA -> CBABAC has distance 5", () => {
  assert.equal(distance(diff([..."ABCABBA"], [..."CBABAC"])), 5);
});

test("unified diff format", () => {
  const a = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
  const b = "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n";
  assert.equal(
    unifiedDiff(a, b, { oldName: "a/n.txt", newName: "b/n.txt" }),
    ["--- a/n.txt", "+++ b/n.txt", "@@ -1,5 +1,5 @@", " one", "-two", "+TWO", " three", " four", " five",
     "@@ -8,3 +8,4 @@", " eight", " nine", " ten", "+eleven", ""].join("\n"),
  );
  assert.equal(unifiedDiff(a, a), "");
  assert.equal(unifiedDiff("", "x\n"), "--- a\n+++ b\n@@ -0,0 +1 @@\n+x\n");
});

test("missing newline at end of file is a change", () => {
  const out = unifiedDiff("a\nb\n", "a\nb");
  assert.match(out, /-b\n\+b\n\\ No newline at end of file\n$/);
  assert.equal(applyPatch("a\nb\n", out), "a\nb");
  assert.equal(applyPatch("a\nb", unifiedDiff("a\nb", "a\nb\n")), "a\nb\n");
});

test("patches round-trip on random files, including contexts 0..3", () => {
  for (let t = 0; t < 200; t++) {
    const a = randomLines(rand(40)).join("\n") + (rand(4) ? "\n" : "");
    const b = mutate(a.split("\n").filter(Boolean)).join("\n") + (rand(4) ? "\n" : "");
    const patch = unifiedDiff(a, b, { context: rand(4) });
    assert.equal(applyPatch(a, patch), b);
  }
});

test("patch applies with offset after unrelated edits", () => {
  const a = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") + "\n";
  const b = a.replace("row 20", "ROW TWENTY");
  const patch = unifiedDiff(a, b);
  const drifted = "header 1\nheader 2\nheader 3\n" + a;
  assert.equal(applyPatch(drifted, patch), "header 1\nheader 2\nheader 3\n" + b);
  assert.throws(() => applyPatch(a.replace("row 19", "row nineteen"), patch), PatchError);
  assert.throws(() => parsePatch("@@ -1,3 +1,1 @@\n-x\n"), /Malformed hunk/);
});

test("interoperates with GNU diff and patch", (t) => {
  try {
    execFileSync("diff", ["--version"]);
    execFileSync("patch", ["--version"]);
  } catch {
    t.skip("diff/patch not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "textdiff-"));
  for (let k = 0; k < 40; k++) {
    const a = randomLines(30, 8).join("\n") + "\n";
    const b = mutate(a.trimEnd().split("\n")).join("\n") + "\n";
    const fa = join(dir, "a.txt");
    const fb = join(dir, "b.txt");
    writeFileSync(fa, a);
    writeFileSync(fb, b);
    // Their patch, our applier
    let gnu = "";
    try {
      execFileSync("diff", ["-u", fa, fb]);
    } catch (e) {
      gnu = String((e as { stdout: Buffer }).stdout);
    }
    assert.equal(applyPatch(a, gnu), b);
    // Our patch, their applier
    writeFileSync(join(dir, "p.diff"), unifiedDiff(a, b));
    execFileSync("patch", ["-s", fa, join(dir, "p.diff")]);
    assert.equal(execFileSync("cat", [fa]).toString(), b);
  }
});

test("three-way merge", () => {
  const base = "title\nalpha\nbeta\ngamma\nend\n";
  const ours = "title\nALPHA\nbeta\ngamma\nend\n";
  const theirs = "title\nalpha\nbeta\nGAMMA\nend\nfooter\n";
  assert.deepEqual(merge3(base, ours, theirs), { text: "title\nALPHA\nbeta\nGAMMA\nend\nfooter\n", conflicts: 0 });
  // Same change on both sides is not a conflict
  assert.equal(merge3(base, ours, ours).conflicts, 0);
  const conflict = merge3(base, "title\nalpha\nbeta (ours)\ngamma\nend\n", "title\nalpha\nbeta (theirs)\ngamma\nend\n");
  assert.equal(conflict.conflicts, 1);
  assert.equal(
    conflict.text,
    "title\nalpha\n<<<<<<< ours\nbeta (ours)\n||||||| base\nbeta\n=======\nbeta (theirs)\n>>>>>>> theirs\ngamma\nend\n",
  );
  // Deleting on one side while the other is untouched
  assert.equal(merge3(base, "title\nbeta\ngamma\nend\n", base).text, "title\nbeta\ngamma\nend\n");
});

test("word-level inline diff", () => {
  const segs = diffWords("The quick brown fox", "The quick red fox!");
  assert.deepEqual(segs, [
    { op: "equal", text: "The quick " },
    { op: "delete", text: "brown" },
    { op: "insert", text: "red" },
    { op: "equal", text: " fox" },
    { op: "insert", text: "!" },
  ]);
});

test("large inputs are fast thanks to prefix/suffix trimming", () => {
  const a = Array.from({ length: 50_000 }, (_, i) => `l${i}`);
  const b = [...a];
  b[25_000] = "changed";
  const t0 = performance.now();
  assert.equal(distance(diff(a, b)), 2);
  assert.ok(performance.now() - t0 < 500);
});
