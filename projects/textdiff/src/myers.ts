// Eugene Myers, "An O(ND) Difference Algorithm and Its Variations" (1986).
//
// Finds a shortest edit script between two sequences by exploring diagonals
// k = x - y in order of edit distance d. V[k] holds the furthest x reached on
// diagonal k; "snakes" follow runs of equal elements for free. The V arrays
// for each d are kept so the path can be traced back afterwards.

export type Op = "equal" | "insert" | "delete";

export interface Edit<T> {
  op: Op;
  items: T[];
  /** Start index in a (for equal/delete) — insert positions refer to b. */
  aIndex: number;
  bIndex: number;
}

export function diff<T>(a: readonly T[], b: readonly T[], equals: (x: T, y: T) => boolean = Object.is): Edit<T>[] {
  // Trim common prefix and suffix first: cheap and very effective on real files.
  let start = 0;
  while (start < a.length && start < b.length && equals(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && equals(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }

  const moves = shortestEditScript(a, b, start, endA, start, endB, equals);
  const edits: Edit<T>[] = [];
  const push = (op: Op, item: T, ai: number, bi: number) => {
    const last = edits.at(-1);
    if (last && last.op === op) last.items.push(item);
    else edits.push({ op, items: [item], aIndex: ai, bIndex: bi });
  };

  for (let i = 0; i < start; i++) push("equal", a[i], i, i);
  let x = start;
  let y = start;
  for (const m of moves) {
    if (m === 0) push("equal", a[x], x++, y++);
    else if (m === 1) push("delete", a[x], x++, y);
    else push("insert", b[y], x, y++);
  }
  for (let i = 0; i < a.length - endA; i++) push("equal", a[endA + i], endA + i, endB + i);
  return edits;
}

/** Returns moves: 0 = diagonal (equal), 1 = right (delete from a), 2 = down (insert from b). */
function shortestEditScript<T>(
  a: readonly T[], b: readonly T[], a0: number, a1: number, b0: number, b1: number, equals: (x: T, y: T) => boolean,
): number[] {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // Move down (insertion) if we're on the lower edge or the diagonal above got further.
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && equals(a[a0 + x], b[b0 + y])) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
  }

  // Backtrack from (n, m) through the saved V arrays.
  const moves: number[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      moves.push(0);
      x--;
      y--;
    }
    if (d > 0) moves.push(down ? 2 : 1);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    moves.push(0);
    x--;
    y--;
  }
  return moves.reverse();
}

/** Edit distance (number of inserted + deleted items). */
export function distance<T>(edits: Edit<T>[]): number {
  return edits.reduce((s, e) => s + (e.op === "equal" ? 0 : e.items.length), 0);
}
