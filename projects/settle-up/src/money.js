// Money is handled as integer paise. Rupee floats only exist in the UI.

export function toPaise(value) {
  const n = typeof value === "string" ? Number(value.replace(/[,₹\s]/g, "")) : value;
  if (!Number.isFinite(n)) throw new RangeError(`Invalid amount: ${value}`);
  return Math.round(n * 100);
}

export function formatINR(paise, { sign = false } = {}) {
  const abs = Math.abs(paise);
  const s = (abs / 100).toLocaleString("en-IN", { minimumFractionDigits: abs % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const prefix = paise < 0 ? "−" : sign && paise > 0 ? "+" : "";
  return `${prefix}₹${s}`;
}

/**
 * Splits `total` paise in proportion to `weights` so the parts always add up
 * exactly to the total (largest-remainder / Hamilton method). Ties for the
 * leftover paise go to earlier entries, which keeps results deterministic.
 */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new RangeError("Weights must add up to more than zero");
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k][1]]++;
  return parts;
}
