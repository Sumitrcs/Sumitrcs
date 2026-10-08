// Income tax computation for resident individuals, FY 2025-26 (AY 2026-27).
// Pure functions, no DOM — shared by the web UI and the test-suite.

/** @typedef {"new" | "old"} Regime */
/** @typedef {"below60" | "senior" | "superSenior"} AgeGroup */
/** @typedef {[number, number][]} Slabs  [upper limit, rate %] — last limit is Infinity */

export const NEW_REGIME = Object.freeze({
  standardDeduction: 75_000,
  slabs: /** @type {Slabs} */ ([
    [4_00_000, 0],
    [8_00_000, 5],
    [12_00_000, 10],
    [16_00_000, 15],
    [20_00_000, 20],
    [24_00_000, 25],
    [Infinity, 30],
  ]),
  rebateLimit: 12_00_000,
  maxRebate: 60_000,
  surcharge: /** @type {[number, number][]} */ ([
    [50_00_000, 10],
    [1_00_00_000, 15],
    [2_00_00_000, 25], // capped at 25% under s.115BAC
  ]),
});

export const OLD_REGIME = Object.freeze({
  standardDeduction: 50_000,
  exemption: { below60: 2_50_000, senior: 3_00_000, superSenior: 5_00_000 },
  rebateLimit: 5_00_000,
  maxRebate: 12_500,
  surcharge: /** @type {[number, number][]} */ ([
    [50_00_000, 10],
    [1_00_00_000, 15],
    [2_00_00_000, 25],
    [5_00_00_000, 37],
  ]),
});

export const LIMITS = Object.freeze({
  sec80C: 1_50_000,
  sec80CCD1B: 50_000,
  homeLoanInterest: 2_00_000,
  sec80D: { self: 25_000, selfSenior: 50_000, parents: 25_000, parentsSenior: 50_000 },
});

const CESS_RATE = 4;

/** Section 288A/288B: round to the nearest multiple of ten. */
export const roundTo10 = (x) => Math.round(x / 10) * 10;

/** @param {AgeGroup} age */
export function oldRegimeSlabs(age) {
  const free = OLD_REGIME.exemption[age];
  /** @type {Slabs} */
  const slabs = [[free, 0]];
  if (free < 5_00_000) slabs.push([5_00_000, 5]);
  slabs.push([10_00_000, 20], [Infinity, 30]);
  return slabs;
}

/**
 * Applies progressive slabs and returns the tax plus a per-slab breakdown.
 * @param {number} income
 * @param {Slabs} slabs
 */
export function slabTax(income, slabs) {
  let lower = 0;
  let tax = 0;
  const breakdown = [];
  for (const [upper, rate] of slabs) {
    if (income <= lower) break;
    const portion = Math.min(income, upper) - lower;
    const t = (portion * rate) / 100;
    breakdown.push({ from: lower, to: Math.min(income, upper), rate, tax: t });
    tax += t;
    lower = upper;
  }
  return { tax, breakdown };
}

/**
 * Surcharge with marginal relief: the extra tax caused by crossing a
 * threshold can never exceed the income that crossed it.
 * @param {number} income
 * @param {number} tax  tax after rebate, before surcharge
 * @param {[number, number][]} bands
 * @param {(income: number) => number} taxAt  tax function used to evaluate at the threshold
 */
export function surchargeWithRelief(income, tax, bands, taxAt) {
  let idx = -1;
  for (let i = 0; i < bands.length; i++) if (income > bands[i][0]) idx = i;
  if (idx < 0) return { surcharge: 0, rate: 0, relief: 0 };

  const [threshold, rate] = bands[idx];
  const prevRate = idx > 0 ? bands[idx - 1][1] : 0;
  const surcharge = (tax * rate) / 100;

  const taxAtThreshold = taxAt(threshold);
  const maxTotal = taxAtThreshold * (1 + prevRate / 100) + (income - threshold);
  const relief = Math.max(0, tax + surcharge - maxTotal);
  return { surcharge: surcharge - relief, rate, relief };
}

/**
 * HRA exemption u/s 10(13A): least of actual HRA, rent − 10% of basic,
 * and 50% (metro) / 40% (non-metro) of basic + DA.
 */
export function hraExemption({ basic = 0, hraReceived = 0, rentPaid = 0, metro = false }) {
  if (!hraReceived || !rentPaid) return 0;
  return Math.max(0, Math.min(hraReceived, rentPaid - 0.1 * basic, (metro ? 0.5 : 0.4) * basic));
}

/**
 * @typedef {object} TaxInput
 * @property {number} salary          gross salary (incl. HRA)
 * @property {number} [otherIncome]   interest, freelance, rent etc. (taxed at slab rates)
 * @property {AgeGroup} [age]
 * @property {{basic:number, hraReceived:number, rentPaid:number, metro:boolean}} [hra]
 * @property {number} [sec80C]
 * @property {number} [sec80D]
 * @property {number} [sec80CCD1B]
 * @property {number} [sec80CCD2]     employer NPS — allowed in both regimes
 * @property {number} [homeLoanInterest]
 * @property {number} [otherDeductions] any other Chapter VI-A deductions (old regime only)
 */

/** @param {TaxInput} input @param {Regime} regime */
export function computeTax(input, regime) {
  const salary = Math.max(0, input.salary || 0);
  const other = Math.max(0, input.otherIncome || 0);
  const age = input.age || "below60";
  const isNew = regime === "new";
  const rules = isNew ? NEW_REGIME : OLD_REGIME;
  const slabs = isNew ? NEW_REGIME.slabs : oldRegimeSlabs(age);

  const deductions = [];
  const add = (label, amount) => amount > 0 && deductions.push({ label, amount });

  add("Standard deduction", Math.min(salary, rules.standardDeduction));
  add("Employer NPS 80CCD(2)", input.sec80CCD2 || 0);
  if (!isNew) {
    add("HRA exemption", input.hra ? hraExemption(input.hra) : 0);
    add("Section 80C", Math.min(input.sec80C || 0, LIMITS.sec80C));
    add("Section 80CCD(1B)", Math.min(input.sec80CCD1B || 0, LIMITS.sec80CCD1B));
    add("Section 80D", Math.min(input.sec80D || 0, LIMITS.sec80D.selfSenior + LIMITS.sec80D.parentsSenior));
    add("Home loan interest 24(b)", Math.min(input.homeLoanInterest || 0, LIMITS.homeLoanInterest));
    add("Other deductions", input.otherDeductions || 0);
  }

  const grossIncome = salary + other;
  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);
  const taxableIncome = roundTo10(Math.max(0, grossIncome - totalDeductions));

  const baseTax = (inc) => {
    const t = slabTax(inc, slabs).tax;
    if (inc <= rules.rebateLimit) return Math.max(0, t - Math.min(t, rules.maxRebate));
    // Marginal relief on the 87A rebate (new regime): tax can't exceed the
    // income above the rebate limit.
    if (isNew) return Math.min(t, inc - rules.rebateLimit);
    return t;
  };

  const { tax: slabTotal, breakdown } = slabTax(taxableIncome, slabs);
  const taxAfterRebate = baseTax(taxableIncome);
  const rebate = taxableIncome <= rules.rebateLimit ? slabTotal - taxAfterRebate : 0;
  const rebateMarginalRelief = taxableIncome > rules.rebateLimit ? slabTotal - taxAfterRebate : 0;

  const sc = surchargeWithRelief(taxableIncome, taxAfterRebate, rules.surcharge, baseTax);
  const cess = ((taxAfterRebate + sc.surcharge) * CESS_RATE) / 100;
  const totalTax = roundTo10(taxAfterRebate + sc.surcharge + cess);

  return {
    regime,
    grossIncome,
    deductions,
    totalDeductions,
    taxableIncome,
    breakdown,
    slabTax: slabTotal,
    rebate,
    rebateMarginalRelief,
    surcharge: sc.surcharge,
    surchargeRate: sc.rate,
    surchargeRelief: sc.relief,
    cess,
    totalTax,
    effectiveRate: grossIncome ? (totalTax / grossIncome) * 100 : 0,
    monthlyTds: Math.round(totalTax / 12),
  };
}

/** Compares both regimes and recommends the cheaper one. */
export function compareRegimes(input) {
  const oldR = computeTax(input, "old");
  const newR = computeTax(input, "new");
  const better = newR.totalTax <= oldR.totalTax ? "new" : "old";
  return { old: oldR, new: newR, better, savings: Math.abs(oldR.totalTax - newR.totalTax) };
}

/**
 * Total old-regime deductions (beyond the standard deduction) at which the
 * old regime starts to cost the same or less than the new one. Tax is
 * monotonic in deductions, so a binary search is enough.
 * Returns null when no amount of deductions can make the old regime cheaper.
 */
export function breakEvenDeductions(salary, otherIncome = 0, age = "below60") {
  const newTax = computeTax({ salary, otherIncome, age }, "new").totalTax;
  const oldTax = (d) => computeTax({ salary, otherIncome, age, otherDeductions: d }, "old").totalTax;
  if (oldTax(0) <= newTax) return 0;
  let lo = 0;
  let hi = salary + otherIncome;
  if (oldTax(hi) > newTax) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (oldTax(mid) <= newTax) hi = mid;
    else lo = mid;
  }
  return hi;
}
