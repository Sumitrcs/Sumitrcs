/**
 * UPI payment links, the text inside every "Scan & Pay" QR code in India.
 *
 *   upi://pay?pa=shop@okicici&pn=Sharma%20Stores&am=250.00&cu=INR&tn=Order%2042
 *
 *   pa  payee address (the UPI ID / VPA), required
 *   pn  payee name, shown to the payer
 *   am  amount in rupees; leave it out and the payer types it
 *   cu  currency, always INR
 *   tn  transaction note
 *   tr  transaction reference (your order or invoice number)
 *
 * Any UPI app (BHIM, Google Pay, PhonePe, Paytm, bank apps) understands these.
 */

export interface UpiPayment {
  vpa: string;
  name?: string;
  amount?: number | string;
  note?: string;
  reference?: string;
}

export class UpiError extends Error {}

/** handle@provider, e.g. sharma.stores@okhdfcbank or 9876543210@ybl */
const VPA = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

/** Most UPI payments are capped at ₹1 lakh per transaction (some categories allow more). */
export const USUAL_LIMIT = 100000;

export function validateVpa(vpa: string): string | null {
  const v = vpa.trim();
  if (!v) return "Enter a UPI ID, like shopname@okicici";
  if (!v.includes("@")) return "A UPI ID has an @, like shopname@okicici";
  if (!VPA.test(v)) return "That doesn't look like a UPI ID (letters, digits, . _ - before the @)";
  return null;
}

/**
 * Normalises an amount to exactly two decimals ("250" → "250.00").
 * Returns "" for an empty amount (the payer will enter it).
 */
export function formatAmount(amount: number | string | undefined): string {
  if (amount === undefined || amount === "") return "";
  const text = String(amount).trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new UpiError("Amount must be a number with at most 2 decimals, like 250 or 99.50");
  const [rupees, paise = ""] = text.split(".");
  const value = `${BigInt(rupees)}.${paise.padEnd(2, "0")}`;
  if (value === "0.00") throw new UpiError("Amount must be more than zero");
  return value;
}

/** Builds the upi://pay link. Throws UpiError for a bad UPI ID or amount. */
export function buildUpiLink(p: UpiPayment): string {
  const problem = validateVpa(p.vpa);
  if (problem) throw new UpiError(problem);
  const params: [string, string][] = [["pa", p.vpa.trim()]];
  if (p.name?.trim()) params.push(["pn", p.name.trim()]);
  const am = formatAmount(p.amount);
  if (am) params.push(["am", am]);
  params.push(["cu", "INR"]);
  if (p.note?.trim()) params.push(["tn", p.note.trim()]);
  if (p.reference?.trim()) params.push(["tr", p.reference.trim()]);
  // encodeURIComponent turns spaces into %20, which every UPI app accepts
  // (some don't accept "+"), and keeps the @ in the UPI ID readable.
  return "upi://pay?" + params.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%40/g, "@")}`).join("&");
}

/** Reads a upi://pay link back into its parts (handy for checking a QR you were given). */
export function parseUpiLink(link: string): UpiPayment & { currency: string } {
  const m = /^upi:\/\/pay\?(.*)$/i.exec(link.trim());
  if (!m) throw new UpiError("Not a UPI payment link (it should start with upi://pay?)");
  const params = new Map<string, string>();
  for (const part of m[1].split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const value = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    params.set(key.toLowerCase(), value);
  }
  const vpa = params.get("pa");
  if (!vpa) throw new UpiError("The link has no payee address (pa=)");
  return {
    vpa,
    name: params.get("pn"),
    amount: params.get("am"),
    note: params.get("tn"),
    reference: params.get("tr"),
    currency: params.get("cu") ?? "INR",
  };
}
