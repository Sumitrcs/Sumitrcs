import { fail, normalize, type ValidationResult } from "./types.ts";

export function validateIfsc(input: unknown): ValidationResult<{ bankCode: string; branchCode: string }> {
  const ifsc = normalize(input);
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    return fail(ifsc, "IFSC must be 4 letters, a zero, then 6 alphanumerics (e.g. SBIN0001234)");
  }
  return { valid: true, value: ifsc, info: { bankCode: ifsc.slice(0, 4), branchCode: ifsc.slice(5) } };
}

export function validateTan(input: unknown): ValidationResult<{ cityCode: string }> {
  const tan = normalize(input);
  if (!/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(tan)) return fail(tan, "TAN must match AAAA99999A");
  return { valid: true, value: tan, info: { cityCode: tan.slice(0, 3) } };
}

export function validateUpi(input: unknown): ValidationResult<{ handle: string; provider: string }> {
  // UPI IDs are case-insensitive but conventionally lower-case; keep dots and underscores.
  const vpa = String(input ?? "").trim().toLowerCase();
  const m = /^([a-z0-9._-]{2,256})@([a-z][a-z0-9]{1,63})$/.exec(vpa);
  if (!m) return fail(vpa, "UPI ID must look like name@bank");
  if (/^[._-]|[._-]$/.test(m[1])) return fail(vpa, "UPI handle cannot start or end with a separator");
  return { valid: true, value: vpa, info: { handle: m[1], provider: m[2] } };
}

const PIN_REGIONS: Record<string, string> = {
  "1": "Delhi, Haryana, Punjab, Himachal Pradesh, J&K, Ladakh, Chandigarh",
  "2": "Uttar Pradesh, Uttarakhand",
  "3": "Rajasthan, Gujarat, Daman & Diu, Dadra & Nagar Haveli",
  "4": "Maharashtra, Goa, Madhya Pradesh, Chhattisgarh",
  "5": "Andhra Pradesh, Telangana, Karnataka",
  "6": "Tamil Nadu, Kerala, Puducherry, Lakshadweep",
  "7": "West Bengal, Odisha, North-East, Andaman & Nicobar",
  "8": "Bihar, Jharkhand",
  "9": "Army Postal Service",
};

export function validatePincode(input: unknown): ValidationResult<{ region: string }> {
  const pin = normalize(input);
  if (!/^[1-9][0-9]{5}$/.test(pin)) return fail(pin, "PIN code must be 6 digits and cannot start with 0");
  return { valid: true, value: pin, info: { region: PIN_REGIONS[pin[0]] } };
}

export function validateVehicleNumber(
  input: unknown,
): ValidationResult<{ series: "standard" | "bharat"; stateCode: string }> {
  const reg = normalize(input);
  // Bharat series: YY BH #### XX
  if (/^[0-9]{2}BH[0-9]{4}[A-HJ-NP-Z]{1,2}$/.test(reg)) {
    return { valid: true, value: reg, info: { series: "bharat", stateCode: "BH" } };
  }
  // Standard: SS RR [X{1,3}] NNNN, e.g. DL3CAB1234, MH12AB1234, KA01M1234
  if (/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(reg)) {
    return { valid: true, value: reg, info: { series: "standard", stateCode: reg.slice(0, 2) } };
  }
  return fail(reg, "Not a valid Indian vehicle registration number");
}
