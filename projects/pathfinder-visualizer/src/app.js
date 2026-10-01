import { ALGORITHMS, solve } from "./algorithms.js";
import { EMPTY, Grid, WALL, WEIGHT } from "./grid.js";
import { MAZES } from "./mazes.js";

const $ = (id) => document.getElementById(id);
const canvas = $("board");
const ctx = canvas.getContext("2d");

const INFO = {
  astar: "Best-first on g + h with the Manhattan heuristic. Optimal and focused.",
  dijkstra: "Expands by lowest total cost. Optimal on weighted grids, explores evenly.",
  bfs: "Expands layer by layer. Shortest in steps, but ignores mud.",
  bidirectional: "Two BFS frontiers meet in the middle — about half the work of BFS.",
  greedy: "Chases the heuristic only. Very fast, not always shortest.",
  dfs: "Dives as deep as possible. Finds a path, rarely a short one.",
};

const CELL = 24;
let grid;
let visitedAt = new Int32Array(0); // animation frame when each cell was visited, -1 = never
let pathAt = new Int32Array(0);
let animation = null;
let colors = {};

function readColors() {
  const s = getComputedStyle(document.documentElement);
  for (const k of ["panel", "line", "start", "end", "wall", "weight", "visited", "frontier", "path"]) {
    colors[k] = s.getPropertyValue(`--${k}`).trim();
  }
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Odd dimensions so maze generators have proper borders.
  let cols = Math.max(11, Math.floor(rect.width / CELL));
  let rows = Math.max(9, Math.floor(rect.height / CELL));
  if (cols % 2 === 0) cols--;
  if (rows % 2 === 0) rows--;
  if (!grid) {
    grid = new Grid(rows, cols);
    resetOverlay();
  } else if (grid.rows !== rows || grid.cols !== cols) {
    stopAnimation();
    grid = regrid(grid, rows, cols);
    resetOverlay();
  }
  draw();
}

/** Copies walls, mud and endpoints into a grid of a new size. */
function regrid(old, rows, cols) {
  const g = new Grid(rows, cols);
  for (let r = 0; r < Math.min(rows, old.rows); r++) {
    for (let c = 0; c < Math.min(cols, old.cols); c++) g.cells[g.index(r, c)] = old.cells[old.index(r, c)];
  }
  for (const key of ["start", "end"]) {
    const [r, c] = old.rc(old[key]);
    if (g.inBounds(r, c)) {
      g[key] = g.index(r, c);
      g.cells[g[key]] = EMPTY;
    }
  }
  return g;
}

function resetOverlay() {
  visitedAt = new Int32Array(grid.cells.length).fill(-1);
  pathAt = new Int32Array(grid.cells.length).fill(-1);
}

function geometry() {
  const rect = canvas.getBoundingClientRect();
  const size = Math.floor(Math.min(rect.width / grid.cols, rect.height / grid.rows));
  const ox = Math.floor((rect.width - size * grid.cols) / 2);
  const oy = Math.floor((rect.height - size * grid.rows) / 2);
  return { size, ox, oy };
}

function draw(frame = Infinity) {
  const { size, ox, oy } = geometry();
  const rect = canvas.getBoundingClientRect();
  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, rect.width, rect.height);

  for (let i = 0; i < grid.cells.length; i++) {
    const [r, c] = grid.rc(i);
    const x = ox + c * size;
    const y = oy + r * size;
    let fill = null;
    if (grid.cells[i] === WALL) fill = colors.wall;
    else if (pathAt[i] >= 0 && pathAt[i] <= frame) fill = colors.path;
    else if (visitedAt[i] >= 0 && visitedAt[i] <= frame) fill = frame - visitedAt[i] < 6 ? colors.frontier : colors.visited;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, size, size);
    }
    if (grid.cells[i] === WEIGHT) {
      ctx.fillStyle = colors.weight;
      const pad = Math.max(2, size * 0.18);
      ctx.beginPath();
      ctx.roundRect(x + pad, y + pad, size - 2 * pad, size - 2 * pad, 3);
      ctx.fill();
    }
  }

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= grid.cols; c++) {
    ctx.moveTo(ox + c * size + 0.5, oy);
    ctx.lineTo(ox + c * size + 0.5, oy + grid.rows * size);
  }
  for (let r = 0; r <= grid.rows; r++) {
    ctx.moveTo(ox, oy + r * size + 0.5);
    ctx.lineTo(ox + grid.cols * size, oy + r * size + 0.5);
  }
  ctx.stroke();

  for (const [i, color] of [[grid.start, colors.start], [grid.end, colors.end]]) {
    const [r, c] = grid.rc(i);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ox + c * size + size / 2, oy + r * size + size / 2, size * 0.38, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Running searches

function setRunning(running) {
  for (const id of ["run", "compare", "clearAll", "maze", "algo"]) $(id).disabled = running;
}

function stopAnimation() {
  if (animation) cancelAnimationFrame(animation);
  animation = null;
  setRunning(false);
}

function showStats(key, result, ms) {
  $("algoName").textContent = ALGORITHMS[key].name;
  $("algoInfo").textContent = INFO[key];
  $("visited").textContent = result ? result.visited.length.toLocaleString() : "–";
  $("length").textContent = result ? (result.path.length ? result.path.length - 1 : "no path") : "–";
  $("cost").textContent = result && result.path.length ? grid.pathCost(result.path) : "–";
  $("time").textContent = ms === undefined ? "–" : `${ms.toFixed(2)} ms`;
}

function visualise() {
  stopAnimation();
  resetOverlay();
  const key = $("algo").value;
  const t0 = performance.now();
  const result = solve(grid, key);
  const ms = performance.now() - t0;

  result.visited.forEach((cell, step) => (visitedAt[cell] = step));
  const pathStart = result.visited.length;
  result.path.forEach((cell, step) => (pathAt[cell] = pathStart + step * 2));
  const totalFrames = pathStart + result.path.length * 2 + 6;

  const speed = Number($("speed").value);
  const perFrame = Math.max(1, Math.round(Math.pow(1.07, speed) / 4));
  let frame = 0;
  setRunning(true);
  const tick = () => {
    frame += frame < pathStart ? perFrame : 1;
    draw(frame);
    if (frame < totalFrames) animation = requestAnimationFrame(tick);
    else stopAnimation();
  };
  animation = requestAnimationFrame(tick);
  showStats(key, result, ms);
}

function compareAll() {
  stopAnimation();
  const rows = Object.keys(ALGORITHMS).map((key) => {
    const t0 = performance.now();
    const r = solve(grid, key);
    return { key, visited: r.visited.length, cost: r.path.length ? grid.pathCost(r.path) : Infinity, ms: performance.now() - t0 };
  });
  const bestCost = Math.min(...rows.map((r) => r.cost));
  const table = $("compareTable");
  table.innerHTML =
    "<tr><th>Algorithm</th><th>Visited</th><th>Cost</th></tr>" +
    rows
      .map(
        (r) =>
          `<tr class="${r.cost === bestCost && r.cost !== Infinity ? "best" : ""}"><td>${ALGORITHMS[r.key].name}</td>` +
          `<td>${r.visited}</td><td>${r.cost === Infinity ? "—" : r.cost}</td></tr>`,
      )
      .join("");
  $("compareBox").hidden = false;
}

function generateMaze(key) {
  stopAnimation();
  resetOverlay();
  grid.clear();
  const walls = MAZES[key].run(grid);
  // Animate walls appearing in generation order.
  const order = new Int32Array(grid.cells.length).fill(-1);
  walls.forEach((w, n) => (order[w] = n));
  const saved = grid.cells.slice();
  grid.cells.fill(EMPTY);
  let shown = 0;
  const step = Math.max(4, Math.ceil(walls.length / 90));
  setRunning(true);
  const tick = () => {
    for (let k = 0; k < step && shown < walls.length; k++, shown++) grid.cells[walls[shown]] = WALL;
    draw();
    if (shown < walls.length) animation = requestAnimationFrame(tick);
    else {
      grid.cells.set(saved);
      draw();
      stopAnimation();
    }
  };
  animation = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Pointer input: paint with the brush, or drag the start / end markers.

let dragging = null; // "start" | "end" | "paint"
let lastCell = -1;

function cellAt(evt) {
  const rect = canvas.getBoundingClientRect();
  const { size, ox, oy } = geometry();
  const c = Math.floor((evt.clientX - rect.left - ox) / size);
  const r = Math.floor((evt.clientY - rect.top - oy) / size);
  return grid.inBounds(r, c) ? grid.index(r, c) : -1;
}

function paint(i) {
  if (i < 0 || i === grid.start || i === grid.end) return;
  const brush = $("brush").value;
  grid.set(i, brush === "wall" ? WALL : brush === "weight" ? WEIGHT : EMPTY);
}

canvas.addEventListener("pointerdown", (e) => {
  if (animation) return;
  const i = cellAt(e);
  if (i < 0) return;
  canvas.setPointerCapture(e.pointerId);
  resetOverlay();
  dragging = i === grid.start ? "start" : i === grid.end ? "end" : "paint";
  if (dragging === "paint") paint(i);
  lastCell = i;
  draw();
});

canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const i = cellAt(e);
  if (i < 0 || i === lastCell) return;
  lastCell = i;
  if (dragging === "paint") paint(i);
  else if (!grid.isWall(i) && i !== grid.start && i !== grid.end) grid[dragging] = i;
  draw();
});

canvas.addEventListener("pointerup", () => (dragging = null));

// ---------------------------------------------------------------------------

for (const [key, a] of Object.entries(ALGORITHMS)) $("algo").add(new Option(a.name, key));
for (const [key, m] of Object.entries(MAZES)) $("maze").add(new Option(m.name, key));

$("algo").addEventListener("change", () => showStats($("algo").value));
$("maze").addEventListener("change", (e) => {
  if (e.target.value) generateMaze(e.target.value);
  e.target.value = "";
});
$("run").addEventListener("click", visualise);
$("compare").addEventListener("click", compareAll);
$("clearPath").addEventListener("click", () => {
  stopAnimation();
  resetOverlay();
  draw();
});
$("clearAll").addEventListener("click", () => {
  stopAnimation();
  grid.clear();
  resetOverlay();
  $("compareBox").hidden = true;
  draw();
});

matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  readColors();
  draw();
});
new ResizeObserver(resize).observe(canvas);
readColors();
showStats("astar");
resize();
