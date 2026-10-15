import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QrError, alignmentPositions, encodeBytes, encodeText, formatInfo, gfMultiply, rsGenerator, rsRemainder, toSvg,
} from "../src/qr.ts";

test("GF(256) multiplication", () => {
  assert.equal(gfMultiply(0, 0x53), 0);
  assert.equal(gfMultiply(1, 0x53), 0x53);
  assert.equal(gfMultiply(2, 0x80), 0x1d); // overflow wraps through the polynomial 0x11d
  // Every non-zero element has an inverse.
  for (let a = 1; a < 256; a++) {
    let found = false;
    for (let b = 1; b < 256 && !found; b++) found = gfMultiply(a, b) === 1;
    assert.ok(found, `no inverse for ${a}`);
  }
});

test("Reed–Solomon matches the worked example for HELLO WORLD (1-M)", () => {
  // Data and error-correction codewords from the well-known QR tutorial example.
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsGenerator(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("alignment pattern positions match the standard's table", () => {
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test("format information strings", () => {
  const bits = (level: "L" | "M" | "Q" | "H", mask: number) => formatInfo(level, mask).toString(2).padStart(15, "0");
  assert.equal(bits("L", 0), "111011111000100");
  assert.equal(bits("M", 0), "101010000010010");
  assert.equal(bits("Q", 7), "010101111101101");
  assert.equal(bits("H", 4), "000011101100010");
  assert.equal(bits("H", 1), "001001110111110");
});

test("a complete version 1 code, module by module", () => {
  // Cross-checked against an independent encoder and decoded by a real scanner library.
  const want = [
    "#######..###..#######", "#.....#.#.##..#.....#", "#.###.#...#...#.###.#", "#.###.#...##..#.###.#",
    "#.###.#.#.#.#.#.###.#", "#.....#..##.#.#.....#", "#######.#.#.#.#######", ".........#.##........",
    "#.#.#.#..#.#....#..#.", "#.#.#....##...#....#.", ".....##..##.#...#####", "#.#.##.#.##...#....#.",
    ".##..###.##.#.#.#.#..", "........#.##.#.#..##.", "#######....#.###..###", "#.....#...####.##....",
    "#.###.#.#.##.###..###", "#.###.#..#....##..##.", "#.###.#.#.#.#...#.#.#", "#.....#..##...#.#..#.",
    "#######.#.#.#.##..###",
  ];
  const qr = encodeText("HELLO", { level: "M", version: 1, mask: 0 });
  assert.deepEqual(qr.modules.map((row) => row.map((m) => (m ? "#" : ".")).join("")), want);
});

test("picks the smallest version that fits", () => {
  assert.equal(encodeText("x".repeat(17), { level: "L" }).version, 1); // 1-L holds 17 bytes
  assert.equal(encodeText("x".repeat(18), { level: "L" }).version, 2);
  assert.equal(encodeText("x".repeat(7), { level: "H" }).version, 1); // 1-H holds 7
  assert.equal(encodeText("x".repeat(8), { level: "H" }).version, 2);
  const big = encodeBytes(new Uint8Array(2953), { level: "L" }); // the largest QR code there is
  assert.equal(big.version, 40);
  assert.equal(big.size, 177);
  assert.throws(() => encodeBytes(new Uint8Array(2954), { level: "L" }), QrError);
  assert.throws(() => encodeText("x".repeat(8), { level: "H", version: 1 }), /don't fit in version 1-H/);
});

test("every code has the fixed patterns where scanners expect them", () => {
  for (const version of [1, 6, 7, 21, 40]) {
    const qr = encodeBytes(new Uint8Array(10), { version, level: "Q" });
    const n = qr.size;
    assert.equal(n, version * 4 + 17);
    // Finder corners are dark, the separator next to them is light.
    for (const [x, y] of [[0, 0], [n - 1, 0], [0, n - 1]]) assert.ok(qr.modules[y][x]);
    assert.equal(qr.modules[7][7], false);
    // Timing pattern alternates.
    for (let i = 8; i < n - 8; i++) assert.equal(qr.modules[6][i], i % 2 === 0);
    // The dark module.
    assert.ok(qr.modules[n - 8][8]);
  }
});

test("UTF-8 text and the automatic mask", () => {
  const qr = encodeText("नमस्ते UPI ₹ 😀");
  assert.ok(qr.mask >= 0 && qr.mask <= 7);
  assert.equal(qr.level, "M");
  // 31 UTF-8 bytes (Devanagari letters take 3 each, the emoji 4): more than
  // version 2-M's 26, so version 3.
  assert.equal(new TextEncoder().encode("नमस्ते UPI ₹ 😀").length, 31);
  assert.equal(qr.version, 3);
});

test("bad options are rejected", () => {
  assert.throws(() => encodeText("a", { version: 41 }), /version must be 1 to 40/);
  assert.throws(() => encodeText("a", { mask: 8 }), /mask must be 0 to 7/);
  assert.throws(() => encodeText("a", { level: "X" as "L" }), /unknown error level/);
});

test("SVG output", () => {
  const svg = toSvg(encodeText("hi", { version: 1 }), { border: 2 });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 25 25"/);
  assert.match(svg, /<path d="M2,2h1v1h-1z/); // top-left finder corner, shifted by the border
});
