import { encodeText, toSvg, type ErrorLevel, type QrCode } from "./qr.ts";
import { USUAL_LIMIT, UpiError, buildUpiLink, formatAmount, validateVpa } from "./upi.ts";

const STORAGE_KEY = "upi-qr:v1";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const preview = $<HTMLDivElement>("qr");
const card = $<HTMLElement>("card");
const message = $<HTMLParagraphElement>("message");
const details = $<HTMLParagraphElement>("details");
const buttons = document.querySelectorAll<HTMLButtonElement>("[data-needs-qr]");

let current: { qr: QrCode; text: string; fileName: string } | null = null;

interface Saved {
  mode: string;
  [field: string]: string;
}

function load(): Saved | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function save(values: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Private mode or storage disabled: the page still works, it just won't remember.
  }
}

function values(): Saved {
  const data = new FormData(form);
  const out: Saved = { mode: String(data.get("mode") ?? "upi") };
  for (const [k, v] of data) out[k] = String(v);
  return out;
}

function show(problem: string, warning = ""): void {
  message.textContent = problem || warning;
  message.className = problem ? "message error" : warning ? "message warn" : "message";
}

function update(): void {
  const v = values();
  save(v);
  const upiMode = v.mode === "upi";
  document.body.dataset.mode = v.mode;

  let text = "";
  let warning = "";
  try {
    if (upiMode) {
      const vpaProblem = v.vpa.trim() ? validateVpa(v.vpa) : "Enter your UPI ID to make a payment QR";
      if (vpaProblem) throw new UpiError(vpaProblem);
      text = buildUpiLink({ vpa: v.vpa, name: v.name, amount: v.amount, note: v.note, reference: v.reference });
      const amount = formatAmount(v.amount);
      if (amount && Number(amount) > USUAL_LIMIT) {
        warning = "Most UPI payments are limited to ₹1,00,000 per transaction; the payer's app may refuse more.";
      }
    } else {
      text = v.text;
      if (!text) throw new UpiError("Type some text or a link");
    }
    const qr = encodeText(text, { level: v.level as ErrorLevel });
    current = { qr, text, fileName: upiMode ? `upi-${v.vpa.split("@")[0]}` : "qr-code" };
    preview.innerHTML = toSvg(qr);
    details.textContent = `Version ${qr.version} · ${qr.size}×${qr.size} squares · mask ${qr.mask} · error correction ${qr.level}`;
    show("", warning);
  } catch (err) {
    current = null;
    preview.innerHTML = "";
    details.textContent = "";
    show(err instanceof Error ? err.message : String(err));
  }

  // The printable card shows who is being paid.
  $("cardName").textContent = upiMode ? v.name.trim() || "Scan & pay" : "";
  $("cardVpa").textContent = upiMode ? v.vpa.trim() : "";
  const amount = upiMode && current ? safeAmount(v.amount) : "";
  $("cardAmount").textContent = amount ? `₹${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "";
  $("cardHint").textContent = upiMode ? "Scan with any UPI app" : "";
  card.classList.toggle("empty", !current);
  buttons.forEach((b) => (b.disabled = !current));
}

function safeAmount(raw: string): string {
  try {
    return formatAmount(raw);
  } catch {
    return "";
  }
}

function download(name: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Draws the code on a canvas, square by square, for a crisp PNG. */
function downloadPng(): void {
  if (!current) return;
  const { qr } = current;
  const border = 4;
  const scale = Math.max(4, Math.floor(1024 / (qr.size + border * 2)));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = (qr.size + border * 2) * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  qr.modules.forEach((row, y) =>
    row.forEach((dark, x) => dark && ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale)),
  );
  canvas.toBlob((blob) => blob && download(`${current!.fileName}.png`, blob), "image/png");
}

form.addEventListener("input", update);
form.addEventListener("submit", (e) => e.preventDefault());
$("png").addEventListener("click", downloadPng);
$("svg").addEventListener("click", () => {
  if (current) download(`${current.fileName}.svg`, new Blob([toSvg(current.qr)], { type: "image/svg+xml" }));
});
$("copy").addEventListener("click", async () => {
  if (!current) return;
  try {
    await navigator.clipboard.writeText(current.text);
    show("", "Copied: " + current.text);
  } catch {
    show("", current.text); // clipboard blocked: at least show it for manual copying
  }
});
$("print").addEventListener("click", () => window.print());

// Restore the last values (or a friendly example) and draw.
const saved = load() ?? { mode: "upi", vpa: "", name: "", amount: "", note: "", reference: "", text: "", level: "M" };
for (const [k, v] of Object.entries(saved)) {
  const field = form.elements.namedItem(k);
  if (field instanceof RadioNodeList) field.value = v;
  else if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) field.value = v;
}
$("example").addEventListener("click", () => {
  for (const [k, v] of Object.entries({ vpa: "sharma.stores@okicici", name: "Sharma General Stores", amount: "", note: "", reference: "" })) {
    (form.elements.namedItem(k) as HTMLInputElement).value = v;
  }
  (form.elements.namedItem("mode") as RadioNodeList).value = "upi";
  update();
});
update();
