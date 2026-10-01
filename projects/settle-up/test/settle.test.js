import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, formatINR, toPaise } from "../src/money.js";
import { balances, shares } from "../src/split.js";
import { greedy, maxZeroSumGroups, settle } from "../src/settle.js";

function apply(bal, payments) {
  const b = { ...bal };
  for (const p of payments) {
    assert.ok(p.amount > 0, "payments must be positive");
    b[p.from] += p.amount;
    b[p.to] -= p.amount;
  }
  return b;
}

const allZero = (b) => Object.values(b).every((v) => v === 0);

test("money helpers", () => {
  assert.equal(toPaise("1,234.56"), 123456);
  assert.equal(toPaise(0.1 + 0.2), 30);
  assert.equal(formatINR(12345678), "₹1,23,456.78");
  assert.equal(formatINR(-5000), "−₹50");
  assert.throws(() => toPaise("abc"));
});

test("allocate always sums exactly and is fair", () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocate(100, [1, 2]), [33, 67]);
  for (let total = 0; total < 500; total += 7) {
    const parts = allocate(total, [3, 1, 4, 1, 5]);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
  }
});

test("split modes", () => {
  const base = { id: 1, title: "Dinner", amount: 100000, paidBy: { A: 100000 } };
  assert.deepEqual(shares({ ...base, split: { mode: "equal", values: { A: true, B: true, C: true } } }), { A: 33334, B: 33333, C: 33333 });
  assert.deepEqual(shares({ ...base, split: { mode: "shares", values: { A: 2, B: 1, C: 1 } } }), { A: 50000, B: 25000, C: 25000 });
  assert.deepEqual(shares({ ...base, split: { mode: "percent", values: { A: 50, B: 30, C: 20 } } }), { A: 50000, B: 30000, C: 20000 });
  assert.deepEqual(shares({ ...base, split: { mode: "exact", values: { A: 10000, B: 90000 } } }), { A: 10000, B: 90000 });
  assert.throws(() => shares({ ...base, split: { mode: "percent", values: { A: 50, B: 40 } } }), /add up to 90%/);
  assert.throws(() => shares({ ...base, split: { mode: "exact", values: { A: 1 } } }), /not 1000/);
  assert.throws(() => shares({ ...base, split: { mode: "equal", values: {} } }), /no participants/);
});

test("balances include multiple payers and recorded settlements", () => {
  const bal = balances(["A", "B", "C"], [
    { title: "Hotel", amount: 900000, paidBy: { A: 600000, B: 300000 }, split: { mode: "equal", values: { A: true, B: true, C: true } } },
    { title: "Cab", amount: 60000, paidBy: { C: 60000 }, split: { mode: "equal", values: { A: true, B: true } } },
  ], [{ from: "C", to: "A", amount: 100000 }]);
  assert.deepEqual(bal, { A: 170000, B: -30000, C: -140000 });
  assert.equal(Object.values(bal).reduce((a, b) => a + b, 0), 0);
  assert.throws(() => balances(["A"], [{ title: "x", amount: 5, paidBy: { A: 4 }, split: { mode: "equal", values: { A: true } } }]), /payers cover/);
});

test("settle finds fewer payments than greedy when sub-groups cancel out", () => {
  // Two independent pairs hidden in one group: optimal = 2 payments.
  const bal = { A: 500, B: -500, C: 300, D: -300, E: 700, F: -400, G: -300 };
  const g = greedy(Object.entries(bal));
  const best = settle(bal);
  assert.ok(allZero(apply(bal, best)));
  assert.ok(allZero(apply(bal, g)));
  assert.equal(best.length, 4); // 7 people, 3 zero-sum groups
  assert.ok(best.length <= g.length);
});

test("a case where greedy is strictly worse", () => {
  // {A, C, D} and {B, E, F} each cancel out, so 2 + 2 payments suffice.
  // Greedy matches F (−12) with E (+7) first and needs 5.
  const bal = { A: -3, B: 5, C: 6, D: -3, E: 7, F: -12 };
  assert.equal(greedy(Object.entries(bal)).length, 5);
  const best = settle(bal);
  assert.ok(allZero(apply(bal, best)));
  assert.equal(best.length, 4);
});

test("max zero-sum groups on random balances", () => {
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let trial = 0; trial < 200; trial++) {
    const n = 2 + Math.floor(rand() * 9);
    const values = Array.from({ length: n - 1 }, () => Math.floor(rand() * 21) - 10 || 1);
    values.push(-values.reduce((a, b) => a + b, 0) || 0);
    if (values.at(-1) === 0) continue;
    const groups = maxZeroSumGroups(values);
    assert.equal(groups.flat().length, n);
    for (const g of groups) assert.equal(g.reduce((s, i) => s + values[i], 0), 0);
    const bal = Object.fromEntries(values.map((v, i) => [`P${i}`, v]));
    const pays = settle(bal);
    assert.ok(allZero(apply(bal, pays)));
    assert.equal(pays.length, n - groups.length);
  }
});

test("settle edge cases", () => {
  assert.deepEqual(settle({ A: 0, B: 0 }), []);
  assert.deepEqual(settle({ A: 100, B: -100 }), [{ from: "B", to: "A", amount: 100 }]);
  assert.throws(() => settle({ A: 1, B: 0 }), /sum to zero/);
});
