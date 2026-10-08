// Maze generators. Each returns the list of wall cells in the order they
// should be drawn, so the UI can animate the construction.

import { EMPTY, WALL } from "./grid.js";

/** Small seeded PRNG (mulberry32) so mazes can be reproduced from a seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Randomised depth-first "recursive backtracker". Produces a perfect maze
 * (exactly one path between any two open cells) with long corridors.
 * Works on odd coordinates: cells at (odd, odd) are rooms, the rest walls.
 */
export function backtracker(grid, rand = Math.random) {
  const { rows, cols } = grid;
  const walls = [];
  grid.cells.fill(WALL);
  const open = (r, c) => (grid.cells[grid.index(r, c)] = EMPTY);

  const startR = 1;
  const startC = 1;
  open(startR, startC);
  const stack = [[startR, startC]];
  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const options = [
      [-2, 0],
      [0, 2],
      [2, 0],
      [0, -2],
    ].filter(([dr, dc]) => {
      const nr = r + dr;
      const nc = c + dc;
      return nr > 0 && nc > 0 && nr < rows - 1 && nc < cols - 1 && grid.cells[grid.index(nr, nc)] === WALL;
    });
    if (!options.length) {
      stack.pop();
      continue;
    }
    const [dr, dc] = options[Math.floor(rand() * options.length)];
    open(r + dr / 2, c + dc / 2);
    open(r + dr, c + dc);
    stack.push([r + dr, c + dc]);
  }
  placeEndpoints(grid);
  for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i] === WALL) walls.push(i);
  return walls;
}

/**
 * Recursive division: start from an empty field and keep splitting
 * chambers with a wall that has one gap. Gives a "rooms and doors" feel.
 */
export function recursiveDivision(grid, rand = Math.random) {
  const { rows, cols } = grid;
  const walls = [];
  grid.cells.fill(EMPTY);
  const wall = (r, c) => {
    const i = grid.index(r, c);
    if (i === grid.start || i === grid.end || grid.cells[i] === WALL) return;
    grid.cells[i] = WALL;
    walls.push(i);
  };
  for (let c = 0; c < cols; c++) wall(0, c), wall(rows - 1, c);
  for (let r = 1; r < rows - 1; r++) wall(r, 0), wall(r, cols - 1);

  const divide = (r0, c0, r1, c1) => {
    const h = r1 - r0;
    const w = c1 - c0;
    if (h < 2 || w < 2) return;
    const horizontal = h > w || (h === w && rand() < 0.5);
    if (horizontal) {
      // wall on an even row, gap on an odd column
      const evens = [];
      for (let r = r0 + 1; r < r1; r++) if (r % 2 === 0) evens.push(r);
      if (!evens.length) return;
      const wr = evens[Math.floor(rand() * evens.length)];
      const odds = [];
      for (let c = c0; c <= c1; c++) if (c % 2 === 1) odds.push(c);
      const gap = odds[Math.floor(rand() * odds.length)];
      for (let c = c0; c <= c1; c++) if (c !== gap) wall(wr, c);
      divide(r0, c0, wr - 1, c1);
      divide(wr + 1, c0, r1, c1);
    } else {
      const evens = [];
      for (let c = c0 + 1; c < c1; c++) if (c % 2 === 0) evens.push(c);
      if (!evens.length) return;
      const wc = evens[Math.floor(rand() * evens.length)];
      const odds = [];
      for (let r = r0; r <= r1; r++) if (r % 2 === 1) odds.push(r);
      const gap = odds[Math.floor(rand() * odds.length)];
      for (let r = r0; r <= r1; r++) if (r !== gap) wall(r, wc);
      divide(r0, c0, r1, wc - 1);
      divide(r0, wc + 1, r1, c1);
    }
  };
  divide(1, 1, rows - 2, cols - 2);
  placeEndpoints(grid);
  return walls;
}

/** Random obstacles with a given density — the classic "scatter" pattern. */
export function scatter(grid, density = 0.28, rand = Math.random) {
  grid.clear(WALL);
  const walls = [];
  for (let i = 0; i < grid.cells.length; i++) {
    if (i !== grid.start && i !== grid.end && rand() < density) {
      grid.cells[i] = WALL;
      walls.push(i);
    }
  }
  return walls;
}

/** Moves start/end onto open "room" cells (odd coordinates) at the left and right edges. */
function placeEndpoints(grid) {
  const odd = (x) => (x % 2 === 1 ? x : x - 1);
  const r = odd(Math.floor(grid.rows / 2));
  grid.start = grid.index(r, 1);
  grid.end = grid.index(r, odd(grid.cols - 2));
  grid.cells[grid.start] = EMPTY;
  grid.cells[grid.end] = EMPTY;
}

export const MAZES = {
  backtracker: { name: "Recursive backtracker", run: backtracker },
  division: { name: "Recursive division", run: recursiveDivision },
  scatter: { name: "Random obstacles", run: scatter },
};
