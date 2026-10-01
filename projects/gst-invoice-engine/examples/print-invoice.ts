import { computeInvoice, formatINR, InvoiceNumberer } from "../src/index.ts";

const numberer = new InvoiceNumberer("RCS/");
const invoice = computeInvoice({
  supplierState: "07",
  placeOfSupply: "09",
  lines: [
    { description: "Website development", hsn: "998314", quantity: 1, rate: 45000, gstRate: 18 },
    { description: "Domain + hosting (1 yr)", hsn: "998315", quantity: 1, rate: 4999, gstRate: 18 },
    { description: "Printed brochures", hsn: "4911", quantity: 500, rate: 7.5, gstRate: 12, discount: { percent: 10 } },
  ],
});

console.log(`Invoice ${numberer.next(new Date("2026-10-01"))}  (${invoice.supplyKind})\n`);
for (const l of invoice.lines) {
  console.log(
    `${l.index}. ${l.description.padEnd(26)} ${l.hsn.padEnd(7)} ${String(l.quantity).padStart(4)} x ${formatINR(l.rate).padStart(11)}  taxable ${formatINR(l.taxable).padStart(12)}`,
  );
}
const t = invoice.totals;
console.log(`\nTaxable value   ${formatINR(t.taxable)}`);
console.log(`IGST            ${formatINR(t.igst)}`);
console.log(`Round off       ${formatINR(t.roundOff)}`);
console.log(`Grand total     ${formatINR(t.grandTotal)}`);
console.log(invoice.amountInWords);
