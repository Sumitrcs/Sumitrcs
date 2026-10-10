import { percentOf, toPaise } from "./money.js";
import { amountInWords } from "./words.js";
import { UT_WITHOUT_LEGISLATURE } from "./gstin.js";

export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

/**
 * Computes a tax invoice.
 * @param {{supplierState: string, placeOfSupply: string,
 *          items: {description: string, hsn: string, qty: number|string, rate: number|string,
 *                  discountPct?: number|string, gstRate: number|string}[]}} inv
 */
export function computeInvoice(inv) {
  const intra = inv.supplierState === inv.placeOfSupply;
  const stateTaxName = UT_WITHOUT_LEGISLATURE.has(inv.placeOfSupply) ? "UTGST" : "SGST";
  const errors = [];

  const lines = inv.items.map((it, i) => {
    const qty = Number(it.qty);
    const rate = toPaise(it.rate);
    const gstRate = Number(it.gstRate);
    const discountPct = Number(it.discountPct || 0);
    const where = `Item ${i + 1}`;
    if (!String(it.description || "").trim()) errors.push(`${where}: description is empty`);
    if (!/^\d{4,8}$/.test(String(it.hsn || ""))) errors.push(`${where}: HSN/SAC should be 4–8 digits`);
    if (!(qty > 0)) errors.push(`${where}: quantity must be more than 0`);
    if (!(rate >= 0)) errors.push(`${where}: rate is not a valid amount`);
    if (!GST_RATES.includes(gstRate)) errors.push(`${where}: ${it.gstRate}% is not a GST rate`);
    if (!(discountPct >= 0 && discountPct <= 100)) errors.push(`${where}: discount must be 0–100%`);

    const gross = Math.round((rate || 0) * (qty || 0));
    const discount = percentOf(gross, discountPct || 0);
    const taxable = gross - discount;
    // CGST and SGST are each calculated at half the rate, as the GST portal does.
    const cgst = intra ? percentOf(taxable, gstRate / 2) : 0;
    const sgst = intra ? percentOf(taxable, gstRate / 2) : 0;
    const igst = intra ? 0 : percentOf(taxable, gstRate);
    return { ...it, qty, rate, gstRate, gross, discount, taxable, cgst, sgst, igst, total: taxable + cgst + sgst + igst };
  });

  const sum = (key) => lines.reduce((s, l) => s + l[key], 0);
  const taxable = sum("taxable");
  const cgst = sum("cgst");
  const sgst = sum("sgst");
  const igst = sum("igst");
  const exact = taxable + cgst + sgst + igst;
  const grandTotal = Math.round(exact / 100) * 100;

  const hsnMap = new Map();
  for (const l of lines) {
    const key = `${l.hsn}|${l.gstRate}`;
    const row = hsnMap.get(key) ?? { hsn: l.hsn, gstRate: l.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxable += l.taxable;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.igst += l.igst;
    hsnMap.set(key, row);
  }

  return {
    intra,
    stateTaxName,
    lines,
    errors,
    hsnSummary: [...hsnMap.values()],
    totals: { taxable, cgst, sgst, igst, tax: cgst + sgst + igst, roundOff: grandTotal - exact, grandTotal },
    words: amountInWords(grandTotal),
  };
}

/** Indian financial year for a date string "YYYY-MM-DD": April to March. */
export function financialYear(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Next invoice number like "INV/2026-27/0007" — the series restarts every financial year. */
export function nextInvoiceNumber(prefix, isoDate, lastNumbers = {}) {
  const fy = financialYear(isoDate);
  const n = (lastNumbers[fy] || 0) + 1;
  return { number: `${prefix}${fy}/${String(n).padStart(4, "0")}`, fy, n };
}
