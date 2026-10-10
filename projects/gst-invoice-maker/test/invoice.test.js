import { test } from "node:test";
import assert from "node:assert/strict";
import { checkChar, validateGstin } from "../src/gstin.js";
import { computeInvoice, financialYear, nextInvoiceNumber } from "../src/invoice.js";
import { formatINR, percentOf, toPaise } from "../src/money.js";
import { amountInWords, numberToWords } from "../src/words.js";

const item = (o = {}) => ({ description: "Website design", hsn: "998314", qty: 1, rate: 10000, gstRate: 18, ...o });

test("GSTIN validation with checksum", () => {
  assert.equal(validateGstin("27AAPFU0939F1ZV").ok, true);
  assert.equal(validateGstin(" 27aapfu0939f1zv ").state, "Maharashtra");
  assert.match(validateGstin("27AAPFU0939F1ZW").error, /Check digit should be V/);
  assert.match(validateGstin("27AAPFU0939").error, /15 characters/);
  assert.match(validateGstin("99AAPFU0939F1Z" + checkChar("99AAPFU0939F1Z")).error, /Unknown state/);
});

test("intra-state invoice uses CGST + SGST", () => {
  const inv = computeInvoice({ supplierState: "07", placeOfSupply: "07", items: [item()] });
  assert.equal(inv.intra, true);
  assert.deepEqual([inv.totals.cgst, inv.totals.sgst, inv.totals.igst], [90000, 90000, 0]);
  assert.equal(inv.totals.grandTotal, 1180000);
  assert.equal(inv.words, "Rupees Eleven Thousand Eight Hundred Only");
});

test("inter-state invoice uses IGST; UT uses UTGST name", () => {
  const inv = computeInvoice({ supplierState: "07", placeOfSupply: "27", items: [item()] });
  assert.equal(inv.totals.igst, 180000);
  assert.equal(inv.totals.cgst + inv.totals.sgst, 0);
  assert.equal(computeInvoice({ supplierState: "04", placeOfSupply: "04", items: [item()] }).stateTaxName, "UTGST");
});

test("discounts, fractional quantities and round-off", () => {
  const inv = computeInvoice({
    supplierState: "07",
    placeOfSupply: "07",
    items: [item({ qty: "2.5", rate: "99.99", discountPct: "10", gstRate: "12" })],
  });
  const [l] = inv.lines;
  assert.equal(l.gross, 24998); // 2.5 × 9999 paise, rounded
  assert.equal(l.discount, 2500);
  assert.equal(l.taxable, 22498);
  assert.equal(l.cgst, 1350); // 6% of 224.98 = 13.4988
  // taxable 224.98 + CGST 13.50 + SGST 13.50 = ₹251.98
  assert.equal(inv.totals.grandTotal, 25200); // rounded to ₹252
  assert.equal(inv.totals.roundOff, 2);
});

test("HSN summary groups by HSN and rate", () => {
  const inv = computeInvoice({
    supplierState: "07",
    placeOfSupply: "09",
    items: [item(), item({ qty: 2 }), item({ hsn: "4911", gstRate: 12, rate: 500 })],
  });
  assert.equal(inv.hsnSummary.length, 2);
  assert.equal(inv.hsnSummary.find((r) => r.hsn === "998314").taxable, 3000000);
});

test("validation errors are collected per item", () => {
  const inv = computeInvoice({
    supplierState: "07",
    placeOfSupply: "07",
    items: [item({ description: "", hsn: "12", qty: 0, gstRate: 15, discountPct: 120 })],
  });
  assert.equal(inv.errors.length, 5);
  assert.match(inv.errors.join("\n"), /HSN\/SAC should be 4–8 digits/);
});

test("money helpers", () => {
  assert.equal(toPaise("1,234.50"), 123450);
  assert.ok(Number.isNaN(toPaise("abc")));
  assert.equal(percentOf(100000, 0.25), 250);
  assert.equal(formatINR(1234567890), "₹1,23,45,678.90");
  assert.equal(formatINR(5, { symbol: false }), "0.05");
});

test("amount in words, Indian system", () => {
  assert.equal(numberToWords(0), "Zero");
  assert.equal(numberToWords(1_05_00_011), "One Crore Five Lakh Eleven");
  assert.equal(numberToWords(999), "Nine Hundred Ninety Nine");
  assert.equal(amountInWords(12345678), "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only");
});

test("financial-year invoice numbering", () => {
  assert.equal(financialYear("2026-03-31"), "2025-26");
  assert.equal(financialYear("2026-04-01"), "2026-27");
  assert.equal(nextInvoiceNumber("INV/", "2026-10-10", { "2026-27": 6 }).number, "INV/2026-27/0007");
  assert.equal(nextInvoiceNumber("INV/", "2027-04-01", { "2026-27": 6 }).number, "INV/2027-28/0001");
});
