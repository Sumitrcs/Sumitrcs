// Money is kept in integer paise so totals never drift (0.1 + 0.2 problems).

export function toPaise(value) {
  const n = typeof value === "string" ? Number(value.replace(/[,₹\s]/g, "")) : value;
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/** `percent` of `amount` paise, rounded half away from zero to a whole paisa. */
export function percentOf(amount, percent) {
  const exact = (amount * Math.round(percent * 10000)) / 1_000_000; // scaled so 0.25% stays exact
  return Math.sign(exact) * Math.round(Math.abs(exact));
}

/** 123456789 -> "1,23,45,678.90" — Indian digit grouping (lakh, crore). */
export function formatINR(paise, { symbol = true } = {}) {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${neg ? "-" : ""}${symbol ? "₹" : ""}${grouped}.${String(abs % 100).padStart(2, "0")}`;
}
