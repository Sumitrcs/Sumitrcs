/**
 * All arithmetic is done in integer paise. Floating point rupees only exist
 * at the edges (input parsing and formatting), which keeps totals exact.
 */
export type Paise = number;

export function toPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError(`Invalid amount: ${rupees}`);
  return Math.round(rupees * 100);
}

/** Round half away from zero — the convention used on Indian tax invoices. */
export function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** percentage of an amount in paise, rounded to the nearest paisa. */
export function percentOf(amount: Paise, percent: number): Paise {
  // Scale to avoid binary drift on rates like 0.25 or 1.5
  return roundHalfUp((amount * Math.round(percent * 10000)) / 1_000_000);
}

export function formatINR(p: Paise): string {
  const negative = p < 0;
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100).toString();
  const paise = (abs % 100).toString().padStart(2, "0");
  // Indian grouping: last 3 digits, then groups of 2
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${negative ? "-" : ""}₹${grouped}.${paise}`;
}
