import { fail, normalize, type ValidationResult } from "./types.ts";

// Verhoeff dihedral group D5 tables.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function digits(s: string): number[] {
  if (!/^[0-9]+$/.test(s)) throw new RangeError("Verhoeff input must contain digits only");
  return [...s].reverse().map(Number);
}

/** Returns the digit that must be appended to `payload` to make it Verhoeff-valid. */
export function verhoeffCheckDigit(payload: string): number {
  let c = 0;
  digits(payload).forEach((d, i) => {
    c = D[c][P[(i + 1) % 8][d]];
  });
  return INV[c];
}

export function verhoeffValidate(numberWithCheck: string): boolean {
  let c = 0;
  digits(numberWithCheck).forEach((d, i) => {
    c = D[c][P[i % 8][d]];
  });
  return c === 0;
}

export function validateAadhaar(input: unknown): ValidationResult {
  const uid = normalize(input);
  if (!/^[0-9]{12}$/.test(uid)) return fail(uid, "Aadhaar must be exactly 12 digits");
  if (/^[01]/.test(uid)) return fail(uid, "Aadhaar cannot start with 0 or 1");
  if (!verhoeffValidate(uid)) return fail(uid, "Aadhaar checksum (Verhoeff) failed");
  return { valid: true, value: uid, info: undefined };
}
