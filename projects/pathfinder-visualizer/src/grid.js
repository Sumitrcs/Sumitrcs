// Grid model shared by the algorithms, maze generators and the UI.
// Cells are addressed by a single index: i = row * cols + col.

export const EMPTY = 0;
export const WALL = 1;
export const WEIGHT = 2; // "mud": costs WEIGHT_COST to enter

export const WEIGHT_COST = 5;

export class Grid {
  constructor(rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.cells = new Uint8Array(rows * cols);
    this.start = this.index(Math.floor(rows / 2), Math.floor(cols / 4));
    this.end = this.index(Math.floor(rows / 2), Math.floor((cols * 3) / 4));
  }

  index(r, c) {
    return r * this.cols + c;
  }

  rc(i) {
    return [Math.floor(i / this.cols), i % this.cols];
  }

  inBounds(r, c) {
    return r >= 0 && c >= 0 && r < this.rows && c < this.cols;
  }

  isWall(i) {
    return this.cells[i] === WALL;
  }

  /** Cost of stepping onto cell i. */
  cost(i) {
    return this.cells[i] === WEIGHT ? WEIGHT_COST : 1;
  }

  /** 4-connected neighbours that aren't walls, in a fixed order (up, right, down, left). */
  neighbors(i) {
    const [r, c] = this.rc(i);
    const out = [];
    if (r > 0 && !this.isWall(i - this.cols)) out.push(i - this.cols);
    if (c < this.cols - 1 && !this.isWall(i + 1)) out.push(i + 1);
    if (r < this.rows - 1 && !this.isWall(i + this.cols)) out.push(i + this.cols);
    if (c > 0 && !this.isWall(i - 1)) out.push(i - 1);
    return out;
  }

  manhattan(a, b) {
    const [ar, ac] = this.rc(a);
    const [br, bc] = this.rc(b);
    return Math.abs(ar - br) + Math.abs(ac - bc);
  }

  set(i, type) {
    if (i === this.start || i === this.end) return;
    this.cells[i] = type;
  }

  clear(type) {
    for (let i = 0; i < this.cells.length; i++) {
      if (type === undefined || this.cells[i] === type) this.cells[i] = EMPTY;
    }
  }

  /** Total cost of a path (excluding the start cell). */
  pathCost(path) {
    return path.slice(1).reduce((sum, i) => sum + this.cost(i), 0);
  }

  static fromStrings(lines) {
    // Test helper: '#' wall, '~' weight, 'S' start, 'E' end, '.' empty
    const g = new Grid(lines.length, lines[0].length);
    lines.forEach((line, r) =>
      [...line].forEach((ch, c) => {
        const i = g.index(r, c);
        if (ch === "#") g.cells[i] = WALL;
        else if (ch === "~") g.cells[i] = WEIGHT;
        else if (ch === "S") g.start = i;
        else if (ch === "E") g.end = i;
      }),
    );
    return g;
  }
}
