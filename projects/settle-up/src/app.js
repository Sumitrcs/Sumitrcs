import { formatINR, toPaise } from "./money.js";
import { settle } from "./settle.js";
import { balances, shares } from "./split.js";
import { emptyState, encodeShare, load, save, validate } from "./store.js";

const $ = (id) => document.getElementById(id);
let state = load();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}

function commit() {
  save(state);
  if (location.hash) history.replaceState(null, "", location.pathname);
  render();
}

// ---------------------------------------------------------------------------
// Rendering

function render() {
  $("groupName").value = state.name;
  renderMembers();
  renderSplitInputs();
  renderExpenses();
  renderBalances();
}

function renderMembers() {
  $("members").innerHTML = state.members.length
    ? state.members.map((m, i) => `<li>${esc(m)}<button data-remove="${i}" aria-label="Remove ${esc(m)}">×</button></li>`).join("")
    : `<li class="empty">Add the people sharing costs</li>`;
  const sel = $("paidBy");
  const prev = sel.value;
  sel.innerHTML = state.members.map((m) => `<option>${esc(m)}</option>`).join("");
  if (state.members.includes(prev)) sel.value = prev;
}

function renderSplitInputs() {
  const mode = $("mode").value;
  const box = $("splitInputs");
  const existing = Object.fromEntries([...box.querySelectorAll("[data-member]")].map((el) => [el.dataset.member, el]));
  box.innerHTML = state.members
    .map((m) => {
      const prev = existing[m];
      if (mode === "equal") {
        const checked = prev ? prev.checked : true;
        return `<label><input type="checkbox" data-member="${esc(m)}" ${checked ? "checked" : ""}/> ${esc(m)}</label>`;
      }
      const placeholder = { exact: "₹", percent: "%", shares: "shares" }[mode];
      const value = mode === "shares" && !prev?.value ? 1 : (prev?.type === "number" ? prev.value : "");
      return `<label>${esc(m)}<input type="number" min="0" step="any" data-member="${esc(m)}" placeholder="${placeholder}" value="${value}"/></label>`;
    })
    .join("");
}

function describeSplit(e) {
  const n = Object.values(e.split.values).filter(Boolean).length;
  const label = { equal: `split equally between ${n}`, exact: "exact amounts", percent: "by percentage", shares: "by shares" };
  return label[e.split.mode];
}

function renderExpenses() {
  const total = state.expenses.reduce((s, e) => s + e.amount, 0);
  $("total").textContent = state.expenses.length ? `· ${formatINR(total)} total` : "";
  const items = [
    ...state.expenses.map((e) => ({ kind: "expense", e })),
    ...state.payments.map((p, i) => ({ kind: "payment", p, i })),
  ];
  $("expenses").innerHTML = items.length
    ? items
        .map((it) =>
          it.kind === "expense"
            ? `<li><div><strong>${esc(it.e.title)}</strong><div class="meta">${esc(Object.keys(it.e.paidBy).join(", "))} paid · ${describeSplit(it.e)}</div></div>
               <div>${formatINR(it.e.amount)} <button data-del="${it.e.id}" aria-label="Delete">Delete</button></div></li>`
            : `<li><div>💸 <strong>${esc(it.p.from)}</strong> paid <strong>${esc(it.p.to)}</strong><div class="meta">settlement</div></div>
               <div>${formatINR(it.p.amount)} <button data-undo="${it.i}">Undo</button></div></li>`,
        )
        .join("")
    : `<li class="empty">No expenses yet</li>`;
}

function renderBalances() {
  let bal;
  try {
    bal = balances(state.members, state.expenses, state.payments);
  } catch (err) {
    $("balances").innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  const max = Math.max(1, ...Object.values(bal).map(Math.abs));
  $("balances").innerHTML = state.members.length
    ? state.members
        .map((m) => {
          const v = bal[m];
          const w = (Math.abs(v) / max) * 50;
          return `<div class="bal"><span class="name">${esc(m)}</span>
            <span class="track"><span class="bar ${v >= 0 ? "pos" : "neg"}" style="width:${w}%"></span></span>
            <span class="amt ${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${formatINR(v, { sign: true })}</span></div>`;
        })
        .join("")
    : `<p class="empty">Balances appear here</p>`;

  const plan = settle(bal);
  const owing = Object.values(bal).filter((v) => v !== 0).length;
  $("settleCount").textContent = plan.length ? `· ${plan.length} payment${plan.length > 1 ? "s" : ""}` : "";
  $("settlements").innerHTML = plan.length
    ? plan
        .map(
          (p, i) => `<li><span><strong>${esc(p.from)}</strong> → <strong>${esc(p.to)}</strong></span>
            <span>${formatINR(p.amount)} <button data-pay="${i}">Mark paid</button></span></li>`,
        )
        .join("")
    : `<li class="empty">${state.expenses.length ? "All settled up 🎉" : "Nothing to settle yet"}</li>`;
  $("settleNote").textContent =
    plan.length && owing - 1 > plan.length
      ? `Naive pairing would need ${owing - 1} payments — this plan saves ${owing - 1 - plan.length}.`
      : "";
  renderBalances.plan = plan;
}

// ---------------------------------------------------------------------------
// Events

$("groupName").addEventListener("change", (e) => {
  state.name = e.target.value.trim() || "Untitled group";
  commit();
});

$("memberForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("memberName").value.trim();
  if (!name) return;
  if (state.members.some((m) => m.toLowerCase() === name.toLowerCase())) return toast(`${name} is already in the group`);
  state.members.push(name);
  $("memberName").value = "";
  commit();
});

$("members").addEventListener("click", (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  const m = state.members[i];
  const used =
    state.expenses.some((x) => m in x.paidBy || x.split.values[m]) || state.payments.some((p) => p.from === m || p.to === m);
  if (used) return toast(`${m} is part of expenses — delete those first`);
  state.members.splice(i, 1);
  commit();
});

$("mode").addEventListener("change", renderSplitInputs);

$("expenseForm").addEventListener("submit", (e) => {
  e.preventDefault();
  $("formError").textContent = "";
  try {
    if (state.members.length < 2) throw new Error("Add at least two people first");
    const mode = $("mode").value;
    const amount = toPaise($("amount").value);
    if (amount <= 0) throw new Error("Amount must be positive");
    const values = {};
    for (const el of $("splitInputs").querySelectorAll("[data-member]")) {
      const m = el.dataset.member;
      if (mode === "equal") values[m] = el.checked;
      else if (el.value !== "" && Number(el.value) > 0) values[m] = mode === "exact" ? toPaise(el.value) : Number(el.value);
    }
    const expense = {
      id: state.nextId++,
      title: $("title").value.trim(),
      amount,
      paidBy: { [$("paidBy").value]: amount },
      split: { mode, values },
    };
    shares(expense); // validates the split
    state.expenses.push(expense);
    $("title").value = "";
    $("amount").value = "";
    commit();
    toast(`Added ${expense.title}`);
  } catch (err) {
    $("formError").textContent = err.message;
  }
});

$("expenses").addEventListener("click", (e) => {
  if (e.target.dataset.del) {
    state.expenses = state.expenses.filter((x) => x.id !== Number(e.target.dataset.del));
    commit();
  } else if (e.target.dataset.undo !== undefined) {
    state.payments.splice(Number(e.target.dataset.undo), 1);
    commit();
  }
});

$("settlements").addEventListener("click", (e) => {
  const i = e.target.dataset.pay;
  if (i === undefined) return;
  const p = renderBalances.plan[i];
  state.payments.push({ ...p });
  commit();
  toast(`Recorded ${p.from} → ${p.to} ${formatINR(p.amount)}`);
});

$("share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#${encodeShare(state)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied — anyone with it sees this group");
  } catch {
    prompt("Copy this link", url);
  }
});

$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `${state.name.replace(/[^\w-]+/g, "-").toLowerCase() || "group"}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

$("import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state = validate(JSON.parse(await file.text()));
    commit();
    toast(`Imported ${state.name}`);
  } catch (err) {
    toast(err.message);
  }
  e.target.value = "";
});

$("reset").addEventListener("click", () => {
  if (confirm("Delete this group and all its expenses?")) {
    state = emptyState();
    state.name = "New group";
    commit();
  }
});

$("demo").addEventListener("click", () => {
  const eq = (...names) => ({ mode: "equal", values: Object.fromEntries(names.map((n) => [n, true])) });
  const people = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Sana"];
  state = {
    name: "Goa trip 🌴",
    members: people,
    nextId: 6,
    payments: [],
    expenses: [
      { id: 1, title: "Villa (3 nights)", amount: 3600000, paidBy: { Aarav: 3600000 }, split: eq(...people) },
      { id: 2, title: "Flights", amount: 2700000, paidBy: { Diya: 1800000, Kabir: 900000 }, split: eq(...people) },
      { id: 3, title: "Seafood dinner", amount: 840000, paidBy: { Meera: 840000 }, split: { mode: "shares", values: { Aarav: 1, Diya: 1, Kabir: 2, Meera: 1, Rohan: 1, Sana: 1 } } },
      { id: 4, title: "Scooter rentals", amount: 360000, paidBy: { Rohan: 360000 }, split: eq("Aarav", "Kabir", "Rohan", "Sana") },
      { id: 5, title: "Parasailing", amount: 450000, paidBy: { Sana: 450000 }, split: { mode: "exact", values: { Diya: 150000, Meera: 150000, Sana: 150000 } } },
    ],
  };
  commit();
});

render();
