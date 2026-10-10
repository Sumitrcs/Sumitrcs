const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n) {
  return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
}

/** Whole number to words in the Indian system: 1,05,00,011 -> "One Crore Five Lakh Eleven". */
export function numberToWords(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Expected a non-negative integer");
  if (n === 0) return "Zero";
  const parts = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const hundred = Math.floor((n % 1e3) / 100);
  const rest = n % 100;
  if (crore) parts.push(numberToWords(crore) + " Crore"); // crores can exceed 99, so recurse
  if (lakh) parts.push(twoDigits(lakh) + " Lakh");
  if (thousand) parts.push(twoDigits(thousand) + " Thousand");
  if (hundred) parts.push(ONES[hundred] + " Hundred");
  if (rest) parts.push(twoDigits(rest));
  return parts.join(" ");
}

export function amountInWords(paise) {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const p = Math.abs(paise) % 100;
  return `Rupees ${numberToWords(rupees)}${p ? ` and ${twoDigits(p)} Paise` : ""} Only`;
}
