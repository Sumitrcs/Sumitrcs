import { diff } from "./myers.ts";
import { joinLines, splitLines } from "./lines.ts";

export interface MergeResult {
  text: string;
  conflicts: number;
}

/** For each base line, the index of the matching line in `other` (or -1). */
function matches(base: string[], other: string[]): Int32Array {
  const map = new Int32Array(base.length).fill(-1);
  for (const e of diff(base, other)) {
    if (e.op === "equal") e.items.forEach((_, i) => (map[e.aIndex + i] = e.bIndex + i));
  }
  return map;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * Three-way merge (diff3). Lines unchanged in both versions are "stable";
 * between stable regions, a chunk changed on one side only takes that side,
 * a chunk changed identically on both sides is taken once, and anything else
 * becomes a conflict with git-style markers.
 */
export function merge3(base: string, ours: string, theirs: string, labels = { ours: "ours", base: "base", theirs: "theirs" }): MergeResult {
  const O = splitLines(base).lines;
  const A = splitLines(ours).lines;
  const B = splitLines(theirs).lines;
  const mA = matches(O, A);
  const mB = matches(O, B);
  const out: string[] = [];
  let conflicts = 0;
  let o = 0;
  let a = 0;
  let b = 0;

  while (o < O.length || a < A.length || b < B.length) {
    // Stable line: present in both versions right where we are.
    if (o < O.length && mA[o] === a && mB[o] === b) {
      out.push(O[o]);
      o++;
      a++;
      b++;
      continue;
    }
    // Find the next base line that both sides kept — the end of this unstable chunk.
    let next = o;
    while (next < O.length && (mA[next] < a || mB[next] < b)) next++;
    const endA = next < O.length ? mA[next] : A.length;
    const endB = next < O.length ? mB[next] : B.length;
    const oc = O.slice(o, next);
    const ac = A.slice(a, endA);
    const bc = B.slice(b, endB);

    if (same(ac, oc)) out.push(...bc); // only theirs changed
    else if (same(bc, oc)) out.push(...ac); // only ours changed
    else if (same(ac, bc)) out.push(...ac); // both made the same change
    else {
      conflicts++;
      out.push(`<<<<<<< ${labels.ours}`, ...ac, `||||||| ${labels.base}`, ...oc, "=======", ...bc, `>>>>>>> ${labels.theirs}`);
    }
    o = next;
    a = endA;
    b = endB;
  }
  const finalNewline = splitLines(ours).finalNewline || splitLines(theirs).finalNewline;
  return { text: joinLines(out, finalNewline), conflicts };
}
