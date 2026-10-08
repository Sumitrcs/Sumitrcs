import { percentOf, toPaise, type Paise } from "./money.ts";
import { classifySupply, stateTaxLabel, type SupplyContext, type SupplyKind } from "./supply.ts";
import { amountInWords } from "./words.ts";

export const GST_RATES = [0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28, 40] as const;

export interface LineInput {
  description: string;
  hsn: string;
  quantity: number;
  unit?: string;
  /** Unit price in rupees, exclusive of GST. */
  rate: number;
  gstRate: number;
  /** Compensation cess percentage, if any. */
  cessRate?: number;
  discount?: { percent: number } | { amount: number };
}

export interface InvoiceInput extends SupplyContext {
  lines: LineInput[];
  /** Export or SEZ supply under LUT/bond — zero-rated, no IGST charged. */
  underLut?: boolean;
  reverseCharge?: boolean;
  /** Round grand total to the nearest rupee (default true). */
  roundOff?: boolean;
}

export interface TaxSplit {
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
}

export interface ComputedLine extends TaxSplit {
  index: number;
  description: string;
  hsn: string;
  quantity: number;
  unit: string;
  rate: Paise;
  gross: Paise;
  discount: Paise;
  taxable: Paise;
  gstRate: number;
  cessRate: number;
  total: Paise;
}

export interface HsnSummaryRow extends TaxSplit {
  hsn: string;
  gstRate: number;
  quantity: number;
  taxable: Paise;
}

export interface ComputedInvoice {
  supplyKind: SupplyKind;
  stateTaxLabel: "SGST" | "UTGST";
  reverseCharge: boolean;
  lines: ComputedLine[];
  hsnSummary: HsnSummaryRow[];
  totals: TaxSplit & { taxable: Paise; tax: Paise; beforeRoundOff: Paise; roundOff: Paise; grandTotal: Paise };
  /** Amount the recipient pays the supplier (excludes tax under reverse charge). */
  payable: Paise;
  amountInWords: string;
}

export class InvoiceError extends Error {}

function validateLine(l: LineInput, i: number): void {
  const where = `line ${i + 1}`;
  if (!/^[0-9]{4,8}$/.test(l.hsn)) throw new InvoiceError(`${where}: HSN/SAC must be 4–8 digits`);
  if (!(l.quantity > 0)) throw new InvoiceError(`${where}: quantity must be positive`);
  if (!(l.rate >= 0)) throw new InvoiceError(`${where}: rate cannot be negative`);
  if (!(GST_RATES as readonly number[]).includes(l.gstRate)) {
    throw new InvoiceError(`${where}: ${l.gstRate}% is not a notified GST rate`);
  }
}

function splitTax(taxable: Paise, gstRate: number, cessRate: number, kind: SupplyKind, zeroRated: boolean): TaxSplit {
  const cess = zeroRated ? 0 : percentOf(taxable, cessRate);
  if (zeroRated) return { igst: 0, cgst: 0, sgst: 0, cess };
  if (kind === "intra-state") {
    // CGST and SGST are each computed on the taxable value at half the rate,
    // matching how the GST portal and most ERPs round per component.
    const half = gstRate / 2;
    return { igst: 0, cgst: percentOf(taxable, half), sgst: percentOf(taxable, half), cess };
  }
  return { igst: percentOf(taxable, gstRate), cgst: 0, sgst: 0, cess };
}

export function computeInvoice(input: InvoiceInput): ComputedInvoice {
  if (!input.lines.length) throw new InvoiceError("Invoice needs at least one line");
  input.lines.forEach(validateLine);

  const supplyKind = classifySupply(input);
  const zeroRated = !!input.underLut && (supplyKind === "export" || supplyKind === "sez");

  const lines: ComputedLine[] = input.lines.map((l, index) => {
    const rate = toPaise(l.rate);
    const gross = Math.round(rate * l.quantity);
    let discount = 0;
    if (l.discount && "percent" in l.discount) discount = percentOf(gross, l.discount.percent);
    else if (l.discount) discount = toPaise(l.discount.amount);
    if (discount > gross) throw new InvoiceError(`line ${index + 1}: discount exceeds line value`);

    const taxable = gross - discount;
    const cessRate = l.cessRate ?? 0;
    const tax = splitTax(taxable, l.gstRate, cessRate, supplyKind, zeroRated);
    return {
      index: index + 1,
      description: l.description,
      hsn: l.hsn,
      quantity: l.quantity,
      unit: l.unit ?? "NOS",
      rate,
      gross,
      discount,
      taxable,
      gstRate: l.gstRate,
      cessRate,
      ...tax,
      total: taxable + tax.igst + tax.cgst + tax.sgst + tax.cess,
    };
  });

  const sum = (k: keyof TaxSplit | "taxable") => lines.reduce((a, l) => a + l[k], 0);
  const taxable = sum("taxable");
  const igst = sum("igst"), cgst = sum("cgst"), sgst = sum("sgst"), cess = sum("cess");
  const tax = igst + cgst + sgst + cess;
  const beforeRoundOff = taxable + tax;
  const grandTotal = input.roundOff === false ? beforeRoundOff : Math.round(beforeRoundOff / 100) * 100;
  const reverseCharge = !!input.reverseCharge;
  const payable = reverseCharge ? grandTotal - tax : grandTotal;

  return {
    supplyKind,
    stateTaxLabel: stateTaxLabel(input.placeOfSupply),
    reverseCharge,
    lines,
    hsnSummary: summariseByHsn(lines),
    totals: { taxable, igst, cgst, sgst, cess, tax, beforeRoundOff, roundOff: grandTotal - beforeRoundOff, grandTotal },
    payable,
    amountInWords: amountInWords(grandTotal),
  };
}

function summariseByHsn(lines: ComputedLine[]): HsnSummaryRow[] {
  const map = new Map<string, HsnSummaryRow>();
  for (const l of lines) {
    const key = `${l.hsn}@${l.gstRate}`;
    const row = map.get(key) ?? { hsn: l.hsn, gstRate: l.gstRate, quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    row.quantity += l.quantity;
    row.taxable += l.taxable;
    row.igst += l.igst;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.cess += l.cess;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.gstRate - b.gstRate);
}
