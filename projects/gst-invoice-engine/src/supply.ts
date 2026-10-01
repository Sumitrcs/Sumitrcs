/** Union territories without a legislature levy UTGST instead of SGST. */
const UT_WITHOUT_LEGISLATURE = new Set(["04", "26", "31", "35", "38"]);

export type SupplyKind = "intra-state" | "inter-state" | "export" | "sez";

export interface SupplyContext {
  supplierState: string;
  /** Place of supply state code. Use "96" for exports (outside India). */
  placeOfSupply: string;
  recipientIsSez?: boolean;
}

export function classifySupply(ctx: SupplyContext): SupplyKind {
  if (ctx.placeOfSupply === "96") return "export";
  if (ctx.recipientIsSez) return "sez"; // Always inter-state under IGST Act s.7(5)(b)
  return ctx.supplierState === ctx.placeOfSupply ? "intra-state" : "inter-state";
}

export function stateTaxLabel(stateCode: string): "SGST" | "UTGST" {
  return UT_WITHOUT_LEGISLATURE.has(stateCode) ? "UTGST" : "SGST";
}

/** Indian financial year label for a date, e.g. 2026-10-01 -> "2026-27". */
export function financialYear(date: Date): string {
  const y = date.getFullYear();
  const start = date.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
