import { test } from "node:test";
import assert from "node:assert/strict";
import { UpiError, buildUpiLink, formatAmount, parseUpiLink, validateVpa } from "../src/upi.ts";

test("builds a standard UPI link", () => {
  assert.equal(
    buildUpiLink({ vpa: "sharma.stores@okicici", name: "Sharma Stores", amount: 250, note: "Order 42", reference: "INV-2026-001" }),
    "upi://pay?pa=sharma.stores@okicici&pn=Sharma%20Stores&am=250.00&cu=INR&tn=Order%2042&tr=INV-2026-001",
  );
});

test("amount is optional: the payer types it", () => {
  assert.equal(buildUpiLink({ vpa: "9876543210@ybl" }), "upi://pay?pa=9876543210@ybl&cu=INR");
});

test("special characters are escaped, Unicode survives", () => {
  const link = buildUpiLink({ vpa: "a.b@sbi", name: "राम & Sons", note: "50% advance #1" });
  assert.equal(link, "upi://pay?pa=a.b@sbi&pn=%E0%A4%B0%E0%A4%BE%E0%A4%AE%20%26%20Sons&cu=INR&tn=50%25%20advance%20%231");
  assert.equal(parseUpiLink(link).name, "राम & Sons");
});

test("amounts are normalised to two decimals", () => {
  assert.equal(formatAmount(""), "");
  assert.equal(formatAmount(undefined), "");
  assert.equal(formatAmount("99.5"), "99.50");
  assert.equal(formatAmount("1,25,000"), "125000.00");
  assert.equal(formatAmount("0007.05"), "7.05");
  assert.equal(formatAmount(12), "12.00");
  for (const bad of ["abc", "1.234", "-5", "1e3", "0", "0.00"]) {
    assert.throws(() => formatAmount(bad), UpiError, bad);
  }
});

test("UPI ID validation", () => {
  for (const ok of ["shop@okicici", "9876543210@ybl", "first.last-1_2@okhdfcbank", "x9@paytm"]) {
    assert.equal(validateVpa(ok), null, ok);
  }
  assert.match(validateVpa("")!, /Enter a UPI ID/);
  assert.match(validateVpa("shop.okicici")!, /has an @/);
  for (const bad of ["@okicici", "a@b", "sh op@okicici", "shop@1bank", "shop@@x"]) {
    assert.notEqual(validateVpa(bad), null, bad);
  }
  assert.throws(() => buildUpiLink({ vpa: "nope" }), UpiError);
});

test("parses links, including ones written by other apps", () => {
  const p = parseUpiLink("UPI://pay?pa=abc@upi&pn=A+B&am=10&cu=INR&mc=5411");
  assert.equal(p.vpa, "abc@upi");
  assert.equal(p.name, "A B"); // some apps use + for space
  assert.equal(p.amount, "10");
  assert.throws(() => parseUpiLink("https://example.com"), /upi:\/\/pay/);
  assert.throws(() => parseUpiLink("upi://pay?pn=NoAddress"), /no payee address/);
});

test("round trip: build → parse", () => {
  const original = { vpa: "kirana@axl", name: "Gupta Kirana", amount: "1499.00", note: "Diwali order", reference: "R-77" };
  const back = parseUpiLink(buildUpiLink(original));
  assert.deepEqual({ ...back, currency: undefined }, { ...original, currency: undefined });
});
