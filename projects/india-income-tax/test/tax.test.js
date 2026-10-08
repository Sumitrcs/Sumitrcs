import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakEvenDeductions,
  compareRegimes,
  computeTax,
  hraExemption,
  NEW_REGIME,
  oldRegimeSlabs,
  slabTax,
} from "../src/tax.js";

test("new regime: ₹12.75L salary is fully tax-free (₹12L after std deduction)", () => {
  const r = computeTax({ salary: 12_75_000 }, "new");
  assert.equal(r.taxableIncome, 12_00_000);
  assert.equal(r.slabTax, 60_000);
  assert.equal(r.rebate, 60_000);
  assert.equal(r.totalTax, 0);
});

test("new regime: marginal relief just above the rebate limit", () => {
  const r = computeTax({ salary: 12_85_000 }, "new");
  assert.equal(r.taxableIncome, 12_10_000);
  // slab tax 61,500 but cannot exceed income above 12L (10,000)
  assert.equal(r.rebateMarginalRelief, 51_500);
  assert.equal(r.totalTax, 10_400);
});

test("new regime: relief stops once slab tax is lower than excess income", () => {
  const r = computeTax({ salary: 13_75_000 }, "new");
  assert.equal(r.taxableIncome, 13_00_000);
  assert.equal(r.slabTax, 75_000);
  assert.equal(r.rebateMarginalRelief, 0);
  assert.equal(r.totalTax, 78_000);
});

test("old regime with 80C", () => {
  const r = computeTax({ salary: 10_00_000, sec80C: 2_00_000 }, "old");
  assert.equal(r.taxableIncome, 8_00_000); // 80C capped at 1.5L
  assert.equal(r.slabTax, 72_500);
  assert.equal(r.totalTax, 75_400);
});

test("old regime: 87A rebate up to ₹5L taxable", () => {
  assert.equal(computeTax({ salary: 5_50_000 }, "old").totalTax, 0);
  assert.ok(computeTax({ salary: 5_60_000 }, "old").totalTax > 0);
});

test("old regime: senior citizen exemption limits", () => {
  assert.deepEqual(oldRegimeSlabs("senior")[0], [3_00_000, 0]);
  assert.deepEqual(oldRegimeSlabs("superSenior")[0], [5_00_000, 0]);
  assert.equal(oldRegimeSlabs("superSenior").length, 3); // no 5% slab
  const young = computeTax({ salary: 9_00_000 }, "old").totalTax;
  const senior = computeTax({ salary: 9_00_000, age: "senior" }, "old").totalTax;
  assert.equal(young - senior, 2_600); // 2,500 + 4% cess
});

test("surcharge marginal relief at ₹50L", () => {
  const r = computeTax({ salary: 0, otherIncome: 50_10_000 }, "new");
  assert.equal(r.surchargeRate, 10);
  assert.equal(r.surcharge, 7_000);
  assert.equal(r.totalTax, 11_33_600);
});

test("new regime surcharge is capped at 25%", () => {
  const r = computeTax({ salary: 0, otherIncome: 10_00_00_000 }, "new");
  assert.equal(r.surchargeRate, 25);
  const o = computeTax({ salary: 0, otherIncome: 10_00_00_000 }, "old");
  assert.equal(o.surchargeRate, 37);
});

test("slab breakdown sums to slab tax", () => {
  const { tax, breakdown } = slabTax(25_00_000, NEW_REGIME.slabs);
  assert.equal(breakdown.reduce((s, b) => s + b.tax, 0), tax);
  assert.equal(breakdown.at(-1).to, 25_00_000);
});

test("HRA exemption takes the least of three limits", () => {
  // actual 2.4L, rent - 10% basic = 3L - 0.6L = 2.4L, 50% basic = 3L
  assert.equal(hraExemption({ basic: 6_00_000, hraReceived: 2_40_000, rentPaid: 3_00_000, metro: true }), 2_40_000);
  // non-metro 40% of basic is the binding limit
  assert.equal(hraExemption({ basic: 5_00_000, hraReceived: 3_00_000, rentPaid: 4_00_000, metro: false }), 2_00_000);
  assert.equal(hraExemption({ basic: 5_00_000, hraReceived: 1_00_000, rentPaid: 40_000 }), 0);
});

test("comparison recommends the cheaper regime", () => {
  const plain = compareRegimes({ salary: 15_00_000 });
  assert.equal(plain.better, "new");
  const heavy = compareRegimes({
    salary: 15_00_000,
    sec80C: 1_50_000,
    sec80CCD1B: 50_000,
    sec80D: 75_000,
    homeLoanInterest: 2_00_000,
    hra: { basic: 6_00_000, hraReceived: 3_00_000, rentPaid: 4_20_000, metro: true },
  });
  assert.equal(heavy.better, "old");
  assert.equal(heavy.savings, heavy.new.totalTax - heavy.old.totalTax);
});

test("break-even deductions make both regimes equal", () => {
  const d = breakEvenDeductions(20_00_000);
  assert.ok(d > 0);
  const newTax = computeTax({ salary: 20_00_000 }, "new").totalTax;
  assert.ok(computeTax({ salary: 20_00_000, otherDeductions: d }, "old").totalTax <= newTax);
  assert.ok(computeTax({ salary: 20_00_000, otherDeductions: d - 1 }, "old").totalTax > newTax - 10);
  // At 7L both regimes can reach zero tax: old needs taxable income <= 5L
  const small = breakEvenDeductions(7_00_000);
  assert.ok(small > 1_49_990 && small <= 1_50_000, String(small));
});
