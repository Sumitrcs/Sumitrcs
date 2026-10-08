import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountInWords,
  computeInvoice,
  financialYear,
  formatINR,
  InvoiceError,
  InvoiceNumberer,
  numberToWords,
  percentOf,
} from "../src/index.ts";

const item = { description: "Laptop", hsn: "8471", quantity: 1, rate: 50000, gstRate: 18 };

test("intra-state supply splits into CGST + SGST", () => {
  const inv = computeInvoice({ supplierState: "07", placeOfSupply: "07", lines: [item] });
  assert.equal(inv.supplyKind, "intra-state");
  assert.equal(inv.totals.cgst, 450000);
  assert.equal(inv.totals.sgst, 450000);
  assert.equal(inv.totals.igst, 0);
  assert.equal(inv.totals.grandTotal, 5900000);
});

test("inter-state supply charges IGST", () => {
  const inv = computeInvoice({ supplierState: "07", placeOfSupply: "27", lines: [item] });
  assert.equal(inv.supplyKind, "inter-state");
  assert.equal(inv.totals.igst, 900000);
  assert.equal(inv.totals.cgst + inv.totals.sgst, 0);
});

test("SEZ supply is inter-state even within the same state", () => {
  const inv = computeInvoice({ supplierState: "29", placeOfSupply: "29", recipientIsSez: true, lines: [item] });
  assert.equal(inv.supplyKind, "sez");
  assert.equal(inv.totals.igst, 900000);
});

test("export under LUT is zero-rated", () => {
  const inv = computeInvoice({ supplierState: "07", placeOfSupply: "96", underLut: true, lines: [item] });
  assert.equal(inv.supplyKind, "export");
  assert.equal(inv.totals.tax, 0);
});

test("UT without legislature uses UTGST label", () => {
  const inv = computeInvoice({ supplierState: "04", placeOfSupply: "04", lines: [item] });
  assert.equal(inv.stateTaxLabel, "UTGST");
});

test("discounts, cess and fractional quantities", () => {
  const inv = computeInvoice({
    supplierState: "07",
    placeOfSupply: "06",
    lines: [
      { description: "Aerated drink", hsn: "2202", quantity: 24, rate: 33.33, gstRate: 28, cessRate: 12 },
      { description: "Rice", hsn: "1006", quantity: 2.5, rate: 64.4, gstRate: 5, discount: { amount: 1 } },
    ],
  });
  const [cola, rice] = inv.lines;
  assert.equal(cola.taxable, 79992); // 24 * 3333 paise
  assert.equal(cola.igst, 22398); // 28% of 799.92 = 223.9776
  assert.equal(cola.cess, 9599); // 12% of 799.92 = 95.9904
  assert.equal(rice.gross, 16100);
  assert.equal(rice.taxable, 16000);
  assert.equal(rice.igst, 800);
});

test("round-off brings grand total to whole rupees", () => {
  const inv = computeInvoice({
    supplierState: "07",
    placeOfSupply: "07",
    lines: [{ description: "Pen", hsn: "9608", quantity: 3, rate: 10.33, gstRate: 18 }],
  });
  // 30.99 taxable + 2.79 + 2.79 = 36.57 -> 37.00
  assert.equal(inv.totals.beforeRoundOff, 3657);
  assert.equal(inv.totals.roundOff, 43);
  assert.equal(inv.totals.grandTotal, 3700);
});

test("reverse charge: recipient pays only taxable value", () => {
  const inv = computeInvoice({ supplierState: "07", placeOfSupply: "07", reverseCharge: true, lines: [item] });
  assert.equal(inv.payable, 5000000);
});

test("HSN summary groups by HSN and rate", () => {
  const inv = computeInvoice({
    supplierState: "07",
    placeOfSupply: "07",
    lines: [item, { ...item, quantity: 2 }, { ...item, hsn: "8443", gstRate: 18 }],
  });
  assert.equal(inv.hsnSummary.length, 2);
  const laptops = inv.hsnSummary.find((r) => r.hsn === "8471")!;
  assert.equal(laptops.quantity, 3);
  assert.equal(laptops.taxable, 15000000);
});

test("validation errors", () => {
  assert.throws(() => computeInvoice({ supplierState: "07", placeOfSupply: "07", lines: [] }), InvoiceError);
  assert.throws(
    () => computeInvoice({ supplierState: "07", placeOfSupply: "07", lines: [{ ...item, gstRate: 15 }] }),
    /not a notified GST rate/,
  );
  assert.throws(
    () => computeInvoice({ supplierState: "07", placeOfSupply: "07", lines: [{ ...item, hsn: "12" }] }),
    /HSN/,
  );
  assert.throws(
    () => computeInvoice({ supplierState: "07", placeOfSupply: "07", lines: [{ ...item, discount: { amount: 60000 } }] }),
    /discount exceeds/,
  );
});

test("percentOf handles fractional rates without float drift", () => {
  assert.equal(percentOf(100000, 0.25), 250);
  assert.equal(percentOf(333, 1.5), 5);
  assert.equal(percentOf(1, 50), 1); // half paisa rounds up
});

test("Indian number formatting and words", () => {
  assert.equal(formatINR(123456789), "₹12,34,567.89");
  assert.equal(formatINR(99), "₹0.99");
  assert.equal(numberToWords(0), "Zero");
  assert.equal(numberToWords(1_05_00_011), "One Crore Five Lakh Eleven");
  assert.equal(numberToWords(12_34_56_78_901), "One Thousand Two Hundred Thirty Four Crore Fifty Six Lakh Seventy Eight Thousand Nine Hundred One");
  assert.equal(amountInWords(5900050), "Rupees Fifty Nine Thousand and Fifty Paise Only");
});

test("financial year and invoice numbering", () => {
  assert.equal(financialYear(new Date("2026-03-31")), "2025-26");
  assert.equal(financialYear(new Date("2026-04-01")), "2026-27");
  const n = new InvoiceNumberer("RCS/");
  assert.equal(n.next(new Date("2026-05-01")), "RCS/2026-27/0001");
  assert.equal(n.next(new Date("2026-05-02")), "RCS/2026-27/0002");
  assert.equal(n.next(new Date("2027-04-01")), "RCS/2027-28/0001");
  assert.throws(() => new InvoiceNumberer("TOOLONGPREFIX/").next(), /exceeds 16/);
});
