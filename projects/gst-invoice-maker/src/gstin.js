// GSTIN: 2-digit state code + 10-character PAN + entity number + 'Z' + check character.

export const STATES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};

/** Union territories without a legislature charge UTGST instead of SGST. */
export const UT_WITHOUT_LEGISLATURE = new Set(["04", "26", "31", "35", "38"]);

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The 15th character is a mod-36 checksum of the first 14: weights alternate
 * 1 and 2, and each product is folded as quotient + remainder of division by 36.
 */
export function checkChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARSET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/** Returns { ok, gstin, state, stateCode, error }. */
export function validateGstin(input) {
  const gstin = String(input || "").replace(/\s/g, "").toUpperCase();
  if (gstin.length !== 15) return { ok: false, gstin, error: "GSTIN must be 15 characters" };
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    return { ok: false, gstin, error: "GSTIN format looks wrong (e.g. 07AAACR5055K1Z9)" };
  }
  const stateCode = gstin.slice(0, 2);
  if (!STATES[stateCode]) return { ok: false, gstin, error: `Unknown state code ${stateCode}` };
  const expected = checkChar(gstin.slice(0, 14));
  if (expected !== gstin[14]) return { ok: false, gstin, error: `Check digit should be ${expected} — probably a typo` };
  return { ok: true, gstin, stateCode, state: STATES[stateCode] };
}
