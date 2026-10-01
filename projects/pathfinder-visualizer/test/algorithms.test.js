import { test } from "node:test";
import assert from "node:assert/strict";
import { ALGORITHMS, solve } from "../src/algorithms.js";
import { Grid, WALL } from "../src/grid.js";
import { MinHeap } from "../src/heap.js";
import { backtracker, recursiveDivision, rng, scatter } from "../src/mazes.js";

const OPEN = Grid.fromStrings([
  "S.........",
  "..........",
  "..........",
  ".........E",
]);

const WALLED = Grid.fromStrings([
  "S.#......",
  "..#.###..",
  "..#...#..",
  "....#.#.E",
]);

// The direct route crosses expensive mud; detouring is cheaper.
const MUD = Grid.fromStrings([
  "S~~~E",
  ".....",
]);

const BLOCKED = Grid.fromStrings([
  "S.#..",
  "..#.E",
]);

function isValidPath(grid, path) {
  if (path[0] !== grid.start || path.at(-1) !== grid.end) return false;
  return path.every((cell, i) => i === 0 || grid.neighbors(path[i - 1]).includes(cell));
}

test("every algorithm finds a valid path", () => {
  for (const [key] of Object.entries(ALGORITHMS)) {
    for (const g of [OPEN, WALLED, MUD]) {
      const { path, visited } = solve(g, key);
      assert.ok(isValidPath(g, path), `${key} produced an invalid path`);
      assert.ok(visited.length > 0);
    }
  }
});

test("optimal algorithms agree on shortest step count", () => {
  for (const g of [OPEN, WALLED]) {
    const lengths = ["bfs", "bidirectional", "dijkstra", "astar"].map((k) => solve(g, k).path.length);
    assert.equal(new Set(lengths).size, 1, `lengths differ: ${lengths}`);
  }
  assert.equal(solve(OPEN, "bfs").path.length, 13); // 3 down + 9 right + start
});

test("weighted algorithms avoid mud, unweighted ones don't", () => {
  const dij = solve(MUD, "dijkstra").path;
  const astar = solve(MUD, "astar").path;
  const bfsPath = solve(MUD, "bfs").path;
  assert.equal(MUD.pathCost(dij), 6);
  assert.equal(MUD.pathCost(astar), 6);
  assert.equal(MUD.pathCost(bfsPath), 16); // 3 mud cells × 5 + 1
});

test("A* visits fewer cells than Dijkstra on an open grid", () => {
  const g = new Grid(30, 60);
  assert.ok(solve(g, "astar").visited.length < solve(g, "dijkstra").visited.length / 3);
});

test("no path returns an empty array", () => {
  for (const key of Object.keys(ALGORITHMS)) {
    assert.deepEqual(solve(BLOCKED, key).path, [], key);
  }
});

test("min-heap pops in priority order and breaks ties FIFO", () => {
  const h = new MinHeap();
  [[5, "e"], [1, "a"], [3, "c1"], [3, "c2"], [2, "b"]].forEach(([p, v]) => h.push(v, p));
  const out = [];
  while (h.size) out.push(h.pop());
  assert.deepEqual(out, ["a", "b", "c1", "c2", "e"]);
});

test("backtracker builds a perfect maze: every room reachable, start to end solvable", () => {
  const g = new Grid(21, 41);
  backtracker(g, rng(7));
  let rooms = 0;
  for (let r = 1; r < g.rows; r += 2) for (let c = 1; c < g.cols; c += 2) if (!g.isWall(g.index(r, c))) rooms++;
  assert.equal(rooms, 10 * 20);
  const { path, visited } = solve(g, "bfs");
  assert.ok(isValidPath(g, path));
  // Perfect maze: open cells = rooms + (rooms - 1) passages, a spanning tree.
  const open = g.cells.length - [...g.cells].filter((x) => x === WALL).length;
  assert.equal(open, 2 * rooms - 1);
  assert.ok(visited.length <= open);
});

test("recursive division keeps start and end connected", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const g = new Grid(25, 51);
    recursiveDivision(g, rng(seed));
    assert.ok(isValidPath(g, solve(g, "astar").path), `seed ${seed}`);
  }
});

test("seeded generators are reproducible", () => {
  const a = new Grid(15, 31);
  const b = new Grid(15, 31);
  scatter(a, 0.3, rng(42));
  scatter(b, 0.3, rng(42));
  assert.deepEqual(a.cells, b.cells);
});
