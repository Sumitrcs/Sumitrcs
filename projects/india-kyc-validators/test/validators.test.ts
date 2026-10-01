import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gstinCheckChar,
  validateAadhaar,
  validateGstin,
  validateIfsc,
  validatePan,
  validatePincode,
  validateTan,
  validateUpi,
  validateVehicleNumber,
  verhoeffCheckDigit,
  verhoeffValidate,
} from "../src/index.ts";

test("GSTIN: accepts real-format numbers with correct checksum", () => {
  for (const g of ["27AAPFU0939F1ZV", "29AAGCB7383J1Z4", "33AAACH7409R1Z8"]) {
    const r = validateGstin(g);
    assert.equal(r.valid, true, g);
  }
});

test("GSTIN: extracts state, PAN and entity info", () => {
  const r = validateGstin(" 27aapfu0939f1zv ");
  assert.ok(r.valid);
  assert.equal(r.info.state, "Maharashtra");
  assert.equal(r.info.pan, "AAPFU0939F");
  assert.equal(r.info.panInfo.entityType, "Firm / LLP");
  assert.equal(r.info.entityNumber, 1);
});

test("GSTIN: detects a single-character typo via checksum", () => {
  const r = validateGstin("27AAPFU0939F1ZW");
  assert.equal(r.valid, false);
  assert.match(r.valid ? "" : r.errors.join(), /Checksum mismatch: expected 'V'/);
});

test("GSTIN: rejects unknown state code", () => {
  const body = "50AAPFU0939F1Z";
  const r = validateGstin(body + gstinCheckChar(body));
  assert.equal(r.valid, false);
});

test("PAN: entity type decoding", () => {
  const r = validatePan("ABCPE1234F");
  assert.ok(r.valid);
  assert.equal(r.info.entityType, "Individual");
  assert.equal(r.info.nameInitial, "E");
  assert.equal(validatePan("ABCXE1234F").valid, false);
  assert.equal(validatePan("ABCP1234F").valid, false);
});

test("Verhoeff: textbook example 236 -> 3", () => {
  assert.equal(verhoeffCheckDigit("236"), 3);
  assert.equal(verhoeffValidate("2363"), true);
  assert.equal(verhoeffValidate("2364"), false);
});

test("Verhoeff: catches every adjacent transposition", () => {
  const base = "48271945367";
  const full = base + verhoeffCheckDigit(base);
  for (let i = 0; i < full.length - 1; i++) {
    if (full[i] === full[i + 1]) continue;
    const swapped = full.slice(0, i) + full[i + 1] + full[i] + full.slice(i + 2);
    assert.equal(verhoeffValidate(swapped), false, `transposition at ${i}`);
  }
});

test("Aadhaar: structure + checksum", () => {
  const payload = "49182736455";
  const uid = payload + verhoeffCheckDigit(payload);
  assert.equal(validateAadhaar(uid).valid, true);
  assert.equal(validateAadhaar(uid.slice(0, 4) + " " + uid.slice(4, 8) + " " + uid.slice(8)).valid, true);
  assert.equal(validateAadhaar("1" + uid.slice(1)).valid, false);
  assert.equal(validateAadhaar("12345").valid, false);
});

test("IFSC / TAN / PIN", () => {
  const ifsc = validateIfsc("sbin0001234");
  assert.ok(ifsc.valid && ifsc.info.bankCode === "SBIN");
  assert.equal(validateIfsc("SBIN1001234").valid, false);
  assert.equal(validateTan("DELA12345B").valid, true);
  assert.equal(validateTan("DEL12345B").valid, false);
  const pin = validatePincode("110001");
  assert.ok(pin.valid && pin.info.region.startsWith("Delhi"));
  assert.equal(validatePincode("011001").valid, false);
});

test("UPI IDs", () => {
  assert.equal(validateUpi("sumit.rcs@okaxis").valid, true);
  assert.equal(validateUpi("9876543210@ybl").valid, true);
  assert.equal(validateUpi(".sumit@okaxis").valid, false);
  assert.equal(validateUpi("sumit@").valid, false);
});

test("Vehicle registration numbers", () => {
  assert.equal(validateVehicleNumber("DL 3C AB 1234").valid, true);
  assert.equal(validateVehicleNumber("MH-12-AB-1234").valid, true);
  const bh = validateVehicleNumber("22 BH 1234 AA");
  assert.ok(bh.valid && bh.info.series === "bharat");
  assert.equal(validateVehicleNumber("ABCD").valid, false);
});
