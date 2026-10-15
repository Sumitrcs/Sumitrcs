/**
 * A QR code encoder written from scratch (ISO/IEC 18004, byte mode).
 *
 * Making a QR code takes five steps:
 *
 *   1. Turn the text into bits: a mode header, the length, the UTF-8 bytes.
 *   2. Add Reed–Solomon error-correction bytes, so the code still scans when
 *      part of it is dirty, torn or covered by a logo.
 *   3. Draw the fixed patterns: the three big corner squares, timing lines,
 *      alignment squares.
 *   4. Lay the bits into the remaining squares in a zig-zag, two columns at a time.
 *   5. XOR the data with one of 8 "mask" patterns, keeping whichever leaves the
 *      fewest confusing shapes for a camera.
 */

export type ErrorLevel = "L" | "M" | "Q" | "H";

/** How much damage each level survives, roughly: 7%, 15%, 25%, 30%. */
export const ERROR_LEVELS: Record<ErrorLevel, { index: number; formatBits: number }> = {
  L: { index: 0, formatBits: 1 },
  M: { index: 1, formatBits: 0 },
  Q: { index: 2, formatBits: 3 },
  H: { index: 3, formatBits: 2 },
};

// From the QR specification: error-correction bytes per block, and number of
// blocks, for each level (rows L, M, Q, H) and version 1–40 (index 0 unused).
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export interface QrOptions {
  level?: ErrorLevel;
  /** Force a version (size) from 1 to 40; by default the smallest that fits. */
  version?: number;
  /** Force a mask from 0 to 7; by default the one with the lowest penalty. */
  mask?: number;
}

export interface QrCode {
  version: number;
  level: ErrorLevel;
  mask: number;
  size: number;
  /** modules[y][x] is true for a dark square. */
  modules: boolean[][];
}

export class QrError extends Error {}

/** Encodes text (as UTF-8 bytes) into a QR code. */
export function encodeText(text: string, options: QrOptions = {}): QrCode {
  return encodeBytes(new TextEncoder().encode(text), options);
}

export function encodeBytes(data: Uint8Array, options: QrOptions = {}): QrCode {
  const level = options.level ?? "M";
  if (!(level in ERROR_LEVELS)) throw new QrError(`unknown error level ${level}`);
  const version = options.version ?? smallestVersion(data.length, level);
  if (!Number.isInteger(version) || version < 1 || version > 40) throw new QrError("version must be 1 to 40");
  const capacity = dataCodewords(version, level) * 8;
  const needed = 4 + countBits(version) + data.length * 8;
  if (needed > capacity) {
    throw new QrError(`too much data: ${data.length} bytes don't fit in version ${version}-${level}`);
  }

  const codewords = addErrorCorrection(dataToCodewords(data, version, level), version, level);
  const qr = new Builder(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(codewords);

  let mask = options.mask;
  if (mask === undefined) {
    // Try all eight masks and keep the one a scanner will find easiest.
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      qr.applyMask(m);
      qr.drawFormatBits(level, m);
      const penalty = qr.penalty();
      if (penalty < best) {
        best = penalty;
        mask = m;
      }
      qr.applyMask(m); // XOR again to undo
    }
  }
  if (!Number.isInteger(mask) || mask! < 0 || mask! > 7) throw new QrError("mask must be 0 to 7");
  qr.applyMask(mask!);
  qr.drawFormatBits(level, mask!);
  return { version, level, mask: mask!, size: qr.size, modules: qr.modules };
}

// ---------------------------------------------------------------------------
// Step 1: data bits

/** The character-count field is 8 bits for small codes and 16 for larger ones. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function smallestVersion(bytes: number, level: ErrorLevel): number {
  for (let v = 1; v <= 40; v++) {
    if (4 + countBits(v) + bytes * 8 <= dataCodewords(v, level) * 8) return v;
  }
  throw new QrError(`too much data: ${bytes} bytes is more than a QR code can hold at level ${level}`);
}

/** Squares available for data + error correction once the fixed patterns are drawn. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, level: ErrorLevel): number {
  const i = ERROR_LEVELS[level].index;
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[i][version] * BLOCKS[i][version];
}

class BitBuffer {
  bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function dataToCodewords(data: Uint8Array, version: number, level: ErrorLevel): number[] {
  const capacity = dataCodewords(version, level) * 8;
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // mode: byte
  bb.push(data.length, countBits(version));
  for (const b of data) bb.push(b, 8);
  bb.push(0, Math.min(4, capacity - bb.bits.length)); // terminator
  bb.push(0, (8 - (bb.bits.length % 8)) % 8); // round up to a whole byte
  // Fill the rest with the two pad bytes the standard asks for, alternately.
  for (let pad = 0xec; bb.bits.length < capacity; pad ^= 0xec ^ 0x11) bb.push(pad, 8);

  const bytes: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    bytes.push(byte);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Step 2: Reed–Solomon error correction over GF(256)

/** Multiplication in GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial (x − α⁰)(x − α¹)…(x − α^(degree−1)), leading 1 dropped. */
export function rsGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The remainder of data ÷ generator: these are the error-correction bytes. */
export function rsRemainder(data: number[], generator: number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    generator.forEach((g, i) => (result[i] ^= gfMultiply(g, factor)));
  }
  return result;
}

/**
 * Splits the data into blocks, adds each block's error-correction bytes, then
 * interleaves them: byte 0 of every block, then byte 1 of every block, ...
 * so that a smudge across the code damages a little of many blocks instead
 * of all of one.
 */
function addErrorCorrection(data: number[], version: number, level: ErrorLevel): number[] {
  const i = ERROR_LEVELS[level].index;
  const numBlocks = BLOCKS[i][version];
  const eccLen = ECC_PER_BLOCK[i][version];
  const raw = Math.floor(rawDataModules(version) / 8);
  // Some blocks may be one data byte shorter than the others.
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks); // block length including ECC
  const generator = rsGenerator(eccLen);

  const blocks: number[][] = [];
  for (let b = 0, k = 0; b < numBlocks; b++) {
    const dat = data.slice(k, k + shortLen - eccLen + (b < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, generator);
    if (b < shortBlocks) dat.push(0); // placeholder so all blocks line up
    blocks.push([...dat, ...ecc]);
  }

  const out: number[] = [];
  for (let k = 0; k < blocks[0].length; k++) {
    blocks.forEach((block, b) => {
      // Skip the placeholders.
      if (k !== shortLen - eccLen || b >= shortBlocks) out.push(block[k]);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Steps 3–5: drawing

class Builder {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[][];
  private readonly reserved: boolean[][]; // squares the data must not use

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }

  drawFunctionPatterns(): void {
    // Timing patterns: alternating dark/light lines between the finders.
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    // The three finder squares (with their light separator rings).
    this.finder(3, 3);
    this.finder(this.size - 4, 3);
    this.finder(3, this.size - 4);
    // Alignment squares, except where they would overlap a finder.
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormatBits("M", 0); // reserve the format area; real bits come later
    this.drawVersionBits();
  }

  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }

  /** 15 bits: level + mask, protected by a BCH code, written twice. */
  drawFormatBits(level: ErrorLevel, mask: number): void {
    const bits = formatInfo(level, mask);
    const bit = (i: number) => ((bits >>> i) & 1) === 1;

    // Copy 1, around the top-left finder.
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    // Copy 2, split between the other two finders.
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true); // the "dark module", always dark
  }

  /** Versions 7+ also store the version number (18 bits, BCH-protected), twice. */
  private drawVersionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /** Data goes up and down in two-column strips, from the bottom-right corner,
   *  skipping every reserved square and the vertical timing line. */
  drawCodewords(codewords: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < this.size; step++) {
        const y = upward ? this.size - 1 - step : step;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (this.reserved[y][x] || i >= codewords.length * 8) continue;
          this.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  /** XOR every data square with mask pattern m. Doing it twice undoes it. */
  applyMask(m: number): void {
    const patterns = [
      (x: number, y: number) => (x + y) % 2 === 0,
      (_x: number, y: number) => y % 2 === 0,
      (x: number) => x % 3 === 0,
      (x: number, y: number) => (x + y) % 3 === 0,
      (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const invert = patterns[m];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.reserved[y][x] && invert(x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** The four penalty rules from the standard. Lower is easier to scan. */
  penalty(): number {
    const n = this.size;
    const at = (x: number, y: number) => this.modules[y][x];
    let total = 0;

    // Rule 1: five or more same-coloured squares in a row or column.
    // Rule 3: anything that looks like a finder square (1:1:3:1:1 with a light gap).
    for (let horizontal = 0; horizontal < 2; horizontal++) {
      for (let a = 0; a < n; a++) {
        const line: boolean[] = [];
        for (let b = 0; b < n; b++) line.push(horizontal ? at(b, a) : at(a, b));
        let run = 1;
        for (let b = 1; b <= n; b++) {
          if (b < n && line[b] === line[b - 1]) {
            run++;
          } else {
            if (run >= 5) total += 3 + (run - 5);
            run = 1;
          }
        }
        total += 40 * finderLikeCount(line);
      }
    }
    // Rule 2: 2×2 blocks of one colour.
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) total += 3;
      }
    }
    // Rule 4: the further from 50% dark, the worse (10 points per 5% step).
    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const k = Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1;
    return total + k * 10;
  }
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

/** Counts dark-light-dark-dark-dark-light-dark runs with 4 light squares on
 *  either side. Outside the code counts as light (it's the quiet zone). */
function finderLikeCount(line: boolean[]): number {
  const n = line.length;
  const get = (i: number) => (i >= 0 && i < n ? line[i] : false);
  let count = 0;
  for (let i = -4; i + 7 <= n + 4; i++) {
    if (!FINDER_LIKE.every((v, k) => get(i + k) === v)) continue;
    const lightBefore = [1, 2, 3, 4].every((d) => !get(i - d));
    const lightAfter = [0, 1, 2, 3].every((d) => !get(i + 7 + d));
    if (lightBefore) count++;
    if (lightAfter) count++;
  }
  return count;
}

/**
 * The 15-bit format information: 2 bits of error level and 3 bits of mask,
 * then 10 check bits from a BCH code (the remainder of dividing by the
 * polynomial 0x537), XORed with 0x5412 so it is never all zeros.
 */
export function formatInfo(level: ErrorLevel, mask: number): number {
  const data = (ERROR_LEVELS[level].formatBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** Centre coordinates of the alignment squares for a version. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------------------
// Output

/** An SVG image: one <path> of 1×1 squares, plus a light quiet-zone border. */
export function toSvg(qr: QrCode, { border = 4, dark = "#000", light = "#fff" } = {}): string {
  const dim = qr.size + border * 2;
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    });
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="${light}"/>` +
    `<path d="${parts.join("")}" fill="${dark}"/></svg>`
  );
}
