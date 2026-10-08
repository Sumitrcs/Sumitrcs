// Turning balances into the fewest possible payments.
//
// Greedy "largest debtor pays largest creditor" always works and needs at
// most n − 1 payments, but it is not always minimal. The true minimum is
//     n − (maximum number of disjoint groups whose balances sum to zero)
// because each zero-sum group of size k can settle internally with k − 1
// payments. Finding that maximum is NP-hard in general, so we solve it
// exactly with a bitmask DP for up to 16 people with non-zero balances and
// fall back to greedy beyond that.

const EXACT_LIMIT = 16;

/** Greedy settlement inside one set of members whose balances sum to zero. */
export function greedy(entries) {
  const creditors = entries.filter(([, v]) => v > 0).map(([m, v]) => ({ m, v }));
  const debtors = entries.filter(([, v]) => v < 0).map(([m, v]) => ({ m, v: -v }));
  const out = [];
  const byAmount = (a, b) => b.v - a.v || a.m.localeCompare(b.m);
  while (creditors.length && debtors.length) {
    creditors.sort(byAmount);
    debtors.sort(byAmount);
    const c = creditors[0];
    const d = debtors[0];
    const amt = Math.min(c.v, d.v);
    out.push({ from: d.m, to: c.m, amount: amt });
    c.v -= amt;
    d.v -= amt;
    if (!c.v) creditors.shift();
    if (!d.v) debtors.shift();
  }
  return out;
}

/**
 * Returns the maximum partition of `values` (all non-zero, summing to 0)
 * into zero-sum groups, as an array of index arrays.
 *
 * dp[mask] = max number of complete zero-sum groups among the people in `mask`.
 * Adding one person at a time, a new group is completed exactly when the
 * running sum of the mask returns to zero.
 */
export function maxZeroSumGroups(values) {
  const n = values.length;
  const full = (1 << n) - 1;
  const sum = new Float64Array(1 << n);
  const dp = new Int8Array(1 << n);
  const from = new Int32Array(1 << n).fill(-1);
  for (let mask = 1; mask <= full; mask++) {
    const low = mask & -mask;
    const bit = 31 - Math.clz32(low);
    sum[mask] = sum[mask ^ low] + values[bit];
    let best = -1;
    let arg = -1;
    for (let rest = mask; rest; rest &= rest - 1) {
      const b = rest & -rest;
      const prev = mask ^ b;
      if (dp[prev] > best) {
        best = dp[prev];
        arg = prev;
      }
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
    from[mask] = arg;
  }
  // Walk back along the chosen chain. People removed between two masks
  // whose sums are zero form one zero-sum group.
  const groups = [];
  let current = [];
  for (let mask = full; mask; ) {
    const prev = from[mask];
    current.push(31 - Math.clz32(mask ^ prev));
    if (sum[prev] === 0) {
      groups.push(current);
      current = [];
    }
    mask = prev;
  }
  return groups;
}

/**
 * Minimum list of payments that brings every balance to zero.
 * @param {Record<string, number>} balances  paise; must sum to zero
 */
export function settle(balances) {
  const entries = Object.entries(balances).filter(([, v]) => v !== 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total !== 0) throw new Error(`Balances must sum to zero (off by ${total})`);
  if (entries.length <= 2 || entries.length > EXACT_LIMIT) return greedy(entries);

  const groups = maxZeroSumGroups(entries.map(([, v]) => v));
  return groups.flatMap((g) => greedy(g.map((i) => entries[i])));
}
