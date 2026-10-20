// Random JSON documents for the differential tests. Seeded, so a failure
// can be reproduced by its seed.

export function rng(seed: number): () => number {
  // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pieces = ["a", "Z", "7", " ", "é", "न", "😀", "\\n", "\\t", "\\\"", "\\\\", "\\/", "\\u00e9", "\\u0000", "\\ud83d\\ude00", "\\b", "\\f", "\\r", "'", "{", "]", ","];
const numbers = ["0", "-0", "7", "-12", "3.25", "1e3", "1E-7", "-0.5e+2", "123456789", "9007199254740993", "2.50", "1e400"];
const keys = ["id", "name", "a b", "", "__proto__", "1", "x", "ключ", "\\u0041"];
const spaces = ["", "", " ", "\n", "\t", "\r\n  "];

export function randomJson(r: () => number, depth = 0): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const ws = () => pick(spaces);
  const str = () => "\"" + Array.from({ length: Math.floor(r() * 6) }, () => pick(pieces)).join("") + "\"";
  const roll = r();
  if (depth < 4 && roll < 0.2) {
    const n = Math.floor(r() * 4);
    return "[" + ws() + Array.from({ length: n }, () => randomJson(r, depth + 1)).join(ws() + "," + ws()) + ws() + "]";
  }
  if (depth < 4 && roll < 0.4) {
    const n = Math.floor(r() * 4);
    return "{" + ws() + Array.from({ length: n }, () => "\"" + pick(keys) + "\"" + ws() + ":" + ws() + randomJson(r, depth + 1)).join(ws() + "," + ws()) + ws() + "}";
  }
  if (roll < 0.6) return str();
  if (roll < 0.85) return pick(numbers);
  return pick(["true", "false", "null"]);
}

// Breaks a document in a small random way: delete, insert or duplicate a character.
const noise = "{}[]:,\"'\\ 0123456789.-+eEtrufalsn/\n\t\u0001aZé";
export function mutate(r: () => number, text: string): string {
  const i = Math.floor(r() * (text.length + 1));
  const op = r();
  if (op < 0.4 && text.length > 0) return text.slice(0, i) + text.slice(i + 1);
  if (op < 0.8) return text.slice(0, i) + noise[Math.floor(r() * noise.length)] + text.slice(i);
  return text.slice(0, i) + text.slice(i, i + 1) + text.slice(i);
}
