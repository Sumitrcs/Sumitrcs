import { STATES, validateGstin } from "./gstin.js";
import { GST_RATES, computeInvoice, financialYear, nextInvoiceNumber } from "./invoice.js";
import { formatINR } from "./money.js";

const KEY = "gst-invoice-maker:v1";
const form = document.getElementById("form");
const itemsBox = document.getElementById("items");
const rowTemplate = document.getElementById("itemRow");
const paper = document.getElementById("paper");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inr = (p) => formatINR(p, { symbol: false });
const today = () => new Date().toISOString().slice(0, 10);

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage may be blocked; the app still works for this session */
  }
}

// ---------------------------------------------------------------------------
// Form <-> state

const placeSelect = form.elements.placeOfSupply;
for (const [code, name] of Object.entries(STATES)) placeSelect.add(new Option(`${code} – ${name}`, code));

function addItemRow(values = {}) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  const gst = row.querySelector('[data-k="gstRate"]');
  for (const r of GST_RATES) gst.add(new Option(`${r}%`, r));
  gst.value = values.gstRate ?? 18;
  for (const input of row.querySelectorAll("input")) {
    if (values[input.dataset.k] !== undefined) input.value = values[input.dataset.k];
  }
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    update();
  });
  itemsBox.append(row);
}

function readState() {
  const f = Object.fromEntries(new FormData(form));
  f.items = [...itemsBox.querySelectorAll(".item")].map((row) =>
    Object.fromEntries([...row.querySelectorAll("[data-k]")].map((el) => [el.dataset.k, el.value])),
  );
  return f;
}

function writeState(s) {
  for (const [k, v] of Object.entries(s)) {
    if (k !== "items" && form.elements[k]) form.elements[k].value = v;
  }
  itemsBox.replaceChildren();
  (s.items?.length ? s.items : [{}]).forEach(addItemRow);
}

// ---------------------------------------------------------------------------
// Rendering

function gstinHint(name) {
  const value = form.elements[name].value.trim();
  const hint = form.querySelector(`[data-hint="${name}"]`);
  if (!value) {
    hint.textContent = "";
    return null;
  }
  const r = validateGstin(value);
  hint.textContent = r.ok ? `✓ ${r.state}` : r.error;
  hint.classList.toggle("bad", !r.ok);
  return r.ok ? r : null;
}

function render(s) {
  const seller = gstinHint("sellerGstin");
  const buyer = gstinHint("buyerGstin");
  // Supplier state comes from the GSTIN; place of supply defaults to the buyer's state.
  const supplierState = seller?.stateCode ?? s.placeOfSupply;
  const inv = computeInvoice({ supplierState, placeOfSupply: s.placeOfSupply, items: s.items });

  const problems = [...inv.errors];
  if (!seller) problems.unshift("Enter a valid GSTIN for your business");
  document.getElementById("errors").innerHTML = problems.map((e) => `<li>${esc(e)}</li>`).join("");

  const taxHead = inv.intra
    ? `<th class="n">CGST</th><th class="n">${inv.stateTaxName}</th>`
    : `<th class="n">IGST</th>`;
  const taxCells = (l) =>
    inv.intra
      ? `<td class="n">${inr(l.cgst)}<br><span class="muted">${l.gstRate / 2}%</span></td><td class="n">${inr(l.sgst)}<br><span class="muted">${l.gstRate / 2}%</span></td>`
      : `<td class="n">${inr(l.igst)}<br><span class="muted">${l.gstRate}%</span></td>`;

  paper.innerHTML = `
    <div class="head">
      <div>
        <h2>TAX INVOICE</h2>
        <div class="muted">Original for recipient</div>
      </div>
      <div style="text-align:right">
        <div><strong>Invoice no.</strong> ${esc(s.number)}</div>
        <div><strong>Date</strong> ${esc(s.date ? new Date(s.date + "T00:00").toLocaleDateString("en-IN") : "")}</div>
        <div><strong>Place of supply</strong> ${esc(STATES[s.placeOfSupply] ?? "")} (${esc(s.placeOfSupply)})</div>
      </div>
    </div>
    <div class="parties">
      <div><div class="muted">From</div><strong>${esc(s.sellerName)}</strong><div style="white-space:pre-wrap">${esc(s.sellerAddress)}</div>
        <div>GSTIN: ${esc(seller?.gstin ?? s.sellerGstin)}</div></div>
      <div><div class="muted">Bill to</div><strong>${esc(s.buyerName)}</strong><div style="white-space:pre-wrap">${esc(s.buyerAddress)}</div>
        ${buyer ? `<div>GSTIN: ${esc(buyer.gstin)}</div>` : `<div class="muted">Unregistered (B2C)</div>`}</div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Taxable</th>${taxHead}<th class="n">Total</th></tr></thead>
      <tbody>${inv.lines
        .map(
          (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}${l.discount ? `<br><span class="muted">less ${esc(l.discountPct)}% discount</span>` : ""}</td>
          <td>${esc(l.hsn)}</td><td class="n">${l.qty || ""}</td><td class="n">${Number.isNaN(l.rate) ? "" : inr(l.rate)}</td>
          <td class="n">${inr(l.taxable)}</td>${taxCells(l)}<td class="n">${inr(l.total)}</td></tr>`,
        )
        .join("")}</tbody>
    </table>
    <table class="totals">
      <tr><td>Taxable value</td><td class="n">${inr(inv.totals.taxable)}</td></tr>
      ${inv.intra
        ? `<tr><td>CGST</td><td class="n">${inr(inv.totals.cgst)}</td></tr><tr><td>${inv.stateTaxName}</td><td class="n">${inr(inv.totals.sgst)}</td></tr>`
        : `<tr><td>IGST</td><td class="n">${inr(inv.totals.igst)}</td></tr>`}
      <tr><td>Round off</td><td class="n">${inr(inv.totals.roundOff)}</td></tr>
      <tr class="grand"><td>Total</td><td class="n">₹${inr(inv.totals.grandTotal)}</td></tr>
    </table>
    <div class="words">${esc(inv.words)}</div>
    <table>
      <thead><tr><th>HSN/SAC</th><th class="n">Rate</th><th class="n">Taxable</th><th class="n">Tax</th></tr></thead>
      <tbody>${inv.hsnSummary
        .map((h) => `<tr><td>${esc(h.hsn)}</td><td class="n">${h.gstRate}%</td><td class="n">${inr(h.taxable)}</td><td class="n">${inr(h.cgst + h.sgst + h.igst)}</td></tr>`)
        .join("")}</tbody>
    </table>
    <div class="foot">
      <div><strong>Bank details</strong><br>${esc(s.bank)}</div>
      <div><strong>Terms</strong><br>${esc(s.terms)}</div>
    </div>
    <div class="sign">For <strong>${esc(s.sellerName)}</strong><br><br><br>Authorised signatory</div>`;
  return inv;
}

// ---------------------------------------------------------------------------

let saved = loadSaved();

function update() {
  const s = readState();
  render(s);
  saved = { ...saved, current: s };
  save(saved);
}

function startNewInvoice(base = {}) {
  const date = today();
  const { number } = nextInvoiceNumber(base.prefix || "INV/", date, saved.counters);
  writeState({ ...base, number, date, items: [{}] });
  update();
}

form.addEventListener("input", (e) => {
  // Suggest the buyer's state as place of supply when their GSTIN becomes valid.
  if (e.target.name === "buyerGstin") {
    const r = validateGstin(e.target.value);
    if (r.ok) placeSelect.value = r.stateCode;
  }
  update();
});
document.getElementById("addItem").addEventListener("click", () => {
  addItemRow();
  update();
});
document.getElementById("print").addEventListener("click", () => {
  const s = readState();
  const fy = s.date ? financialYear(s.date) : null;
  const n = Number(String(s.number).split("/").pop());
  if (fy && Number.isInteger(n)) {
    saved.counters = { ...saved.counters, [fy]: Math.max(saved.counters?.[fy] || 0, n) };
    save(saved);
  }
  window.print();
});
document.getElementById("newInvoice").addEventListener("click", () => {
  const s = readState();
  // Keep your own business details, clear the customer and items.
  startNewInvoice({ sellerName: s.sellerName, sellerAddress: s.sellerAddress, sellerGstin: s.sellerGstin, bank: s.bank, terms: s.terms, prefix: s.prefix, placeOfSupply: s.placeOfSupply });
});
document.getElementById("demo").addEventListener("click", () => {
  writeState({
    sellerName: "RCS Informatic",
    sellerAddress: "12, Nehru Place\nNew Delhi 110019",
    sellerGstin: "07AAACR5055K1Z9",
    buyerName: "Acme Traders",
    buyerAddress: "Plot 4, MIDC Andheri East\nMumbai 400093",
    buyerGstin: "27AAPFU0939F1ZV",
    placeOfSupply: "27",
    prefix: "RCS/",
    number: nextInvoiceNumber("RCS/", today(), saved.counters).number,
    date: today(),
    bank: "HDFC Bank · A/c 50200012345678 · IFSC HDFC0000123",
    terms: "Payment due within 15 days.",
    items: [
      { description: "Website design and development", hsn: "998314", qty: 1, rate: 45000, gstRate: 18 },
      { description: "Domain + hosting (1 year)", hsn: "998315", qty: 1, rate: 4999, gstRate: 18 },
      { description: "Printed brochures", hsn: "4911", qty: 500, rate: 7.5, discountPct: 10, gstRate: 12 },
    ],
  });
  update();
});

if (saved.current) {
  writeState(saved.current);
  update();
} else {
  startNewInvoice({ placeOfSupply: "07" });
}
