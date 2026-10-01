// Search algorithms written as generators: each `yield` reports one visited
// cell so the UI can animate the search, and the final return value carries
// the path. Run to completion with `solve()` when you only need the answer.

import { MinHeap } from "./heap.js";

function reconstruct(parent, end) {
  const path = [];
  for (let at = end; at !== -1 && at !== undefined; at = parent[at]) path.push(at);
  return path.reverse();
}

/** Breadth-first search: shortest path by number of steps (ignores weights). */
export function* bfs(grid) {
  const parent = new Int32Array(grid.cells.length).fill(-2);
  parent[grid.start] = -1;
  const queue = [grid.start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    yield cur;
    if (cur === grid.end) return reconstruct(parent, cur);
    for (const n of grid.neighbors(cur)) {
      if (parent[n] === -2) {
        parent[n] = cur;
        queue.push(n);
      }
    }
  }
  return [];
}

/** Depth-first search: finds *a* path, usually a long and winding one. */
export function* dfs(grid) {
  const parent = new Int32Array(grid.cells.length).fill(-2);
  const stack = [[grid.start, -1]];
  while (stack.length) {
    const [cur, from] = stack.pop();
    if (parent[cur] !== -2) continue;
    parent[cur] = from;
    yield cur;
    if (cur === grid.end) return reconstruct(parent, cur);
    // Reverse so the first neighbour is explored first.
    for (const n of grid.neighbors(cur).reverse()) {
      if (parent[n] === -2) stack.push([n, cur]);
    }
  }
  return [];
}

/**
 * Generic best-first search. `priority(g, node)` decides the algorithm:
 *   Dijkstra: g          A*: g + h          Greedy: h
 */
function* bestFirst(grid, priority) {
  const n = grid.cells.length;
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new MinHeap();
  dist[grid.start] = 0;
  open.push(grid.start, priority(0, grid.start));

  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue; // stale heap entry
    closed[cur] = 1;
    yield cur;
    if (cur === grid.end) return reconstruct(parent, cur);
    for (const nb of grid.neighbors(cur)) {
      if (closed[nb]) continue;
      const g = dist[cur] + grid.cost(nb);
      if (g < dist[nb]) {
        dist[nb] = g;
        parent[nb] = cur;
        open.push(nb, priority(g, nb));
      }
    }
  }
  return [];
}

/** Dijkstra: optimal on weighted grids, explores in all directions. */
export function dijkstra(grid) {
  return bestFirst(grid, (g) => g);
}

/**
 * A*: optimal with an admissible heuristic. Manhattan distance never
 * overestimates on a 4-connected grid where every step costs at least 1.
 * Ties on f are broken towards larger g (deeper nodes), which visits fewer cells.
 */
export function aStar(grid) {
  return bestFirst(grid, (g, i) => g + grid.manhattan(i, grid.end) - g * 1e-6);
}

/** Greedy best-first: fast, but not guaranteed to find the shortest path. */
export function greedy(grid) {
  return bestFirst(grid, (_g, i) => grid.manhattan(i, grid.end));
}

/** Bidirectional BFS: two frontiers meet in the middle (≈ half the area of BFS). */
export function* bidirectional(grid) {
  const n = grid.cells.length;
  const pa = new Int32Array(n).fill(-2);
  const pb = new Int32Array(n).fill(-2);
  pa[grid.start] = -1;
  pb[grid.end] = -1;
  let qa = [grid.start];
  let qb = [grid.end];

  const join = (meet) => {
    const left = reconstruct(pa, meet);
    const right = [];
    for (let at = pb[meet]; at !== -1; at = pb[at]) right.push(at);
    return left.concat(right);
  };

  if (grid.start === grid.end) return [grid.start];
  while (qa.length && qb.length) {
    // Expand the smaller frontier one full layer at a time.
    const forward = qa.length <= qb.length;
    const [q, mine, other] = forward ? [qa, pa, pb] : [qb, pb, pa];
    const next = [];
    for (const cur of q) {
      yield cur;
      for (const nb of grid.neighbors(cur)) {
        if (mine[nb] !== -2) continue;
        mine[nb] = cur;
        if (other[nb] !== -2) return join(nb);
        next.push(nb);
      }
    }
    if (forward) qa = next;
    else qb = next;
  }
  return [];
}

export const ALGORITHMS = {
  astar: { name: "A* search", run: aStar, weighted: true, optimal: true },
  dijkstra: { name: "Dijkstra", run: dijkstra, weighted: true, optimal: true },
  bfs: { name: "Breadth-first", run: bfs, weighted: false, optimal: true },
  bidirectional: { name: "Bidirectional BFS", run: bidirectional, weighted: false, optimal: true },
  greedy: { name: "Greedy best-first", run: greedy, weighted: true, optimal: false },
  dfs: { name: "Depth-first", run: dfs, weighted: false, optimal: false },
};

/** Runs a search to completion. */
export function solve(grid, algo) {
  const it = ALGORITHMS[algo].run(grid);
  const visited = [];
  for (;;) {
    const { value, done } = it.next();
    if (done) return { visited, path: value };
    visited.push(value);
  }
}
