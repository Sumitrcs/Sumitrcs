import type { Paise } from "./money.ts";

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? ONES[h] + " Hundred" : "", r ? belowHundred(r) : ""].filter(Boolean).join(" ");
}

/** Converts a whole number to words using the Indian system (thousand, lakh, crore). */
export function numberToWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Expected a non-negative integer");
  if (n === 0) return "Zero";

  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1e3);
  n %= 1e3;

  // Crores can themselves exceed 99 (e.g. 1,234 crore) — recurse.
  if (crore) parts.push(numberToWords(crore) + " Crore");
  if (lakh) parts.push(belowHundred(lakh) + " Lakh");
  if (thousand) parts.push(belowHundred(thousand) + " Thousand");
  if (n) parts.push(belowThousand(n));
  return parts.join(" ");
}

export function amountInWords(p: Paise): string {
  const rupees = Math.floor(Math.abs(p) / 100);
  const paise = Math.abs(p) % 100;
  let s = `Rupees ${numberToWords(rupees)}`;
  if (paise) s += ` and ${belowHundred(paise)} Paise`;
  return (p < 0 ? "Minus " : "") + s + " Only";
}
