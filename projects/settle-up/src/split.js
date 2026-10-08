import { allocate } from "./money.js";

/**
 * An expense: { id, title, amount (paise), paidBy: {member: paise}, split: {mode, values} }
 *
 * Split modes:
 *   equal    — values: { member: true } for the participants
 *   exact    — values: { member: paise }, must add up to the amount
 *   percent  — values: { member: percent }, must add up to 100
 *   shares   — values: { member: shares } (e.g. 2 shares for a couple)
 */
export function shares(expense) {
  const { amount, split } = expense;
  const members = Object.keys(split.values).filter((m) => split.values[m]);
  if (!members.length) throw new Error(`"${expense.title}" has no participants`);

  switch (split.mode) {
    case "equal":
      return zip(members, allocate(amount, members.map(() => 1)));
    case "shares":
      return zip(members, allocate(amount, members.map((m) => Number(split.values[m]))));
    case "percent": {
      const total = members.reduce((s, m) => s + Number(split.values[m]), 0);
      if (Math.abs(total - 100) > 1e-9) throw new Error(`Percentages for "${expense.title}" add up to ${total}%, not 100%`);
      return zip(members, allocate(amount, members.map((m) => Number(split.values[m]))));
    }
    case "exact": {
      const parts = members.map((m) => Number(split.values[m]));
      const total = parts.reduce((a, b) => a + b, 0);
      if (total !== amount) throw new Error(`Exact amounts for "${expense.title}" add up to ${total / 100}, not ${amount / 100}`);
      return zip(members, parts);
    }
    default:
      throw new Error(`Unknown split mode ${split.mode}`);
  }
}

function zip(keys, values) {
  return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

/**
 * Net balance per member: positive = should receive, negative = owes.
 * Settlement payments ({from, to, amount}) are included so the balances
 * reflect money already paid back.
 */
export function balances(members, expenses, payments = []) {
  const bal = Object.fromEntries(members.map((m) => [m, 0]));
  const touch = (m, delta) => {
    if (!(m in bal)) throw new Error(`Unknown member ${m}`);
    bal[m] += delta;
  };
  for (const e of expenses) {
    const paid = Object.values(e.paidBy).reduce((a, b) => a + b, 0);
    if (paid !== e.amount) throw new Error(`"${e.title}": payers cover ${paid / 100}, expense is ${e.amount / 100}`);
    for (const [m, p] of Object.entries(e.paidBy)) touch(m, p);
    for (const [m, s] of Object.entries(shares(e))) touch(m, -s);
  }
  for (const p of payments) {
    touch(p.from, p.amount);
    touch(p.to, -p.amount);
  }
  return bal;
}
