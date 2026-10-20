import { JsonError, parse, pathPart, stats, type Node, type Parsed } from "./parse.ts";
import { byteSize, format, humanSize } from "./format.ts";
import { toTypeScript } from "./types.ts";
import { CsvError, toCsv } from "./csv.ts";

const STORAGE_KEY = "json-lens:v1";
const PAGE = 200; // children shown per tree node before "show more"
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const input = $<HTMLTextAreaElement>("input");
const status = $<HTMLParagraphElement>("status");
const problem = $<HTMLElement>("problem");
const warnings = $<HTMLUListElement>("warnings");
const tree = $<HTMLDivElement>("tree");
const output = $<HTMLPreElement>("output");
const pathBar = $<HTMLElement>("path");
const indentSel = $<HTMLSelectElement>("indent");
const sortBox = $<HTMLInputElement>("sort");
const tabs = document.querySelectorAll<HTMLButtonElement>("[data-view]");

let parsed: Parsed | null = null;
let view = "tree";

const EXAMPLE = `{
  "id": 1042,
  "name": "Asha Verma",
  "email": "asha@example.com",
  "verified": true,
  "address": { "city": "Pune", "pin": "411001" },
  "tags": ["admin", "beta"],
  "orders": [
    { "id": "A-17", "total": 499.50, "items": 3, "coupon": "DIWALI10" },
    { "id": "A-18", "total": 120, "items": 1, "coupon": null }
  ],
  "accountNumber": 12345678901234567890
}`;

function load(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function save(text: string): void {
  try {
    if (text.length < 500_000) localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // Storage blocked or full: the page still works, it just won't remember.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ---- checking the input -------------------------------------------------

function update(): void {
  const text = input.value;
  save(text);
  problem.hidden = true;
  warnings.replaceChildren();
  if (!text.trim()) {
    parsed = null;
    status.className = "status";
    status.textContent = "Paste JSON on the left, open a file, or try the example.";
    render();
    return;
  }
  try {
    parsed = parse(text);
  } catch (e) {
    parsed = null;
    if (!(e instanceof JsonError)) throw e;
    showError(text, e);
    render();
    return;
  }
  const s = stats(parsed.root);
  status.className = "status ok";
  status.textContent = `✓ Valid JSON · ${humanSize(byteSize(text))} · ${s.values.toLocaleString()} values · ${s.keys.toLocaleString()} keys · depth ${s.maxDepth}`;
  for (const w of parsed.warnings) {
    const li = el("li", "", `Line ${w.line}: ${w.message}`);
    li.addEventListener("click", () => select(w.offset, w.offset + 1));
    warnings.append(li);
  }
  render();
}

function showError(text: string, e: JsonError): void {
  status.className = "status bad";
  status.textContent = "✗ Not valid JSON";
  const lineText = text.split("\n")[e.line - 1] ?? "";
  // Long lines (minified JSON) are cut to a window around the error.
  const from = Math.max(0, e.col - 40);
  const shown = (from > 0 ? "…" : "") + lineText.slice(from, from + 80).replace(/\t/g, " ");
  const caret = " ".repeat(e.col - 1 - from + (from > 0 ? 1 : 0)) + "^";
  $("problemMessage").textContent = e.message;
  $("problemHint").textContent = e.hint;
  $("problemSnippet").textContent = `${String(e.line).padStart(4)} | ${shown}\n     | ${caret}`;
  $<HTMLButtonElement>("goto").onclick = () => select(e.offset, e.offset + 1);
  problem.hidden = false;
}

function select(from: number, to: number): void {
  input.focus();
  input.setSelectionRange(from, Math.min(to, input.value.length));
  // Scroll the textarea so the selection is visible.
  const line = input.value.slice(0, from).split("\n").length;
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
  input.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

// ---- output views -------------------------------------------------------

function currentText(): string {
  if (!parsed) return "";
  const root = parsed.root;
  if (view === "text" || view === "tree") {
    const indent = indentSel.value === "tab" ? "tab" : Number(indentSel.value);
    return format(root, { indent, sortKeys: sortBox.checked });
  }
  if (view === "types") return toTypeScript(root);
  if (view === "csv") return toCsv(root);
  return "";
}

function render(): void {
  for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.view === view));
  document.body.dataset.view = view;
  tree.replaceChildren();
  output.textContent = "";
  output.classList.remove("note");
  tree.classList.remove("note");
  if (!parsed) {
    const box = view === "tree" ? tree : output;
    box.textContent = input.value.trim() ? "Fix the error to see the result here." : "Nothing to show yet.";
    box.classList.add("note");
    return;
  }
  if (view === "tree") {
    tree.append(nodeElement(parsed.root, null, "$", 0));
    return;
  }
  try {
    output.textContent = currentText();
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    output.textContent = e.message;
    output.classList.add("note");
  }
}

function preview(n: Node): string {
  switch (n.kind) {
    case "null": return "null";
    case "boolean": return String(n.value);
    case "number": return n.raw;
    case "string": return JSON.stringify(n.value);
    case "array": return `[${n.items.length}]`;
    case "object": return `{${n.entries.length}}`;
  }
}

// One row of the tree. Objects and arrays are <details> elements whose
// children are only built when first opened, so huge files stay fast.
function nodeElement(n: Node, key: string | number | null, path: string, depth: number): HTMLElement {
  const label = el("span", "key", key === null ? "root" : typeof key === "number" ? String(key) : key);
  label.title = path;
  label.tabIndex = 0;
  label.addEventListener("click", (ev) => {
    ev.preventDefault(); // don't toggle the <details>
    showPath(path);
  });
  label.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      showPath(path);
    }
  });
  const value = el("span", `v ${n.kind}`, preview(n));

  if (n.kind !== "array" && n.kind !== "object") {
    const row = el("div", "leaf");
    row.append(label, el("span", "colon", ": "), value);
    return row;
  }
  const details = el("details");
  const summary = el("summary");
  summary.append(label, el("span", "colon", " "), value);
  details.append(summary);
  const children = el("div", "children");
  details.append(children);

  const count = n.kind === "array" ? n.items.length : n.entries.length;
  let shown = 0;
  const more = (): void => {
    const end = Math.min(count, shown + PAGE);
    for (let i = shown; i < end; i++) {
      children.append(n.kind === "array"
        ? nodeElement(n.items[i], i, path + pathPart(i), depth + 1)
        : nodeElement(n.entries[i].value, n.entries[i].key, path + pathPart(n.entries[i].key), depth + 1));
    }
    shown = end;
    if (shown < count) {
      const btn = el("button", "more", `Show ${Math.min(PAGE, count - shown)} more of ${count - shown}`);
      btn.type = "button";
      btn.addEventListener("click", () => {
        btn.remove();
        more();
      });
      children.append(btn);
    }
  };
  details.addEventListener("toggle", () => {
    if (details.open && shown === 0) more();
  });
  if (depth < 2) {
    details.open = true;
    more();
  }
  return details;
}

function showPath(path: string): void {
  pathBar.textContent = path;
  pathBar.classList.remove("copied");
  navigator.clipboard?.writeText(path).then(() => {
    pathBar.classList.add("copied");
  }).catch(() => {});
}

// ---- buttons ------------------------------------------------------------

function rewriteInput(indent: number | "tab"): void {
  if (!parsed) {
    input.focus();
    return;
  }
  input.value = format(parsed.root, { indent, sortKeys: sortBox.checked });
  update();
}

function download(): void {
  const text = currentText() || input.value;
  const ext = view === "types" ? "ts" : view === "csv" ? "csv" : "json";
  const type = ext === "csv" ? "text/csv" : ext === "ts" ? "text/plain" : "application/json";
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = ext === "ts" ? "types.ts" : `data.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function flash(btn: HTMLButtonElement, text: string): void {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

let timer = 0;
input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = window.setTimeout(update, 150);
});
$("format").addEventListener("click", () => rewriteInput(indentSel.value === "tab" ? "tab" : Number(indentSel.value)));
$("minify").addEventListener("click", () => rewriteInput(0));
$("example").addEventListener("click", () => {
  input.value = EXAMPLE;
  update();
});
$("clear").addEventListener("click", () => {
  input.value = "";
  update();
  input.focus();
});
$<HTMLInputElement>("file").addEventListener("change", async (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  input.value = await f.text();
  update();
});
$<HTMLButtonElement>("copy").addEventListener("click", (ev) => {
  const btn = ev.currentTarget as HTMLButtonElement;
  const text = view === "tree" ? currentText() : output.textContent ?? "";
  navigator.clipboard?.writeText(text).then(() => flash(btn, "Copied"), () => flash(btn, "Copy failed"));
});
$("download").addEventListener("click", download);
indentSel.addEventListener("change", render);
sortBox.addEventListener("change", render);
for (const t of tabs) {
  t.addEventListener("click", () => {
    view = t.dataset.view ?? "tree";
    render();
  });
}
// Dropping a file anywhere on the editor loads it.
input.addEventListener("dragover", (ev) => ev.preventDefault());
input.addEventListener("drop", async (ev) => {
  const f = ev.dataTransfer?.files[0];
  if (!f) return;
  ev.preventDefault();
  input.value = await f.text();
  update();
});

input.value = load() ?? EXAMPLE;
update();
