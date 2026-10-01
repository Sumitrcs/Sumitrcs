import { validatePan, type PanInfo } from "./pan.ts";
import { stateName } from "./states.ts";
import { fail, normalize, type ValidationResult } from "./types.ts";

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{10}[1-9A-Z][A-Z0-9][0-9A-Z]$/;

export interface GstinInfo {
  stateCode: string;
  state: string;
  pan: string;
  panInfo: PanInfo;
  /** Registration number of this PAN within the state (1 = first). */
  entityNumber: number;
  checkChar: string;
}

/**
 * Computes the GSTIN check character for the first 14 characters.
 * Mod-36 scheme: alternate weights 1 and 2, products folded as
 * quotient + remainder of division by 36.
 */
export function gstinCheckChar(first14: string): string {
  const s = normalize(first14);
  if (s.length !== 14) throw new RangeError("Expected the first 14 characters of a GSTIN");
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = CHARSET.indexOf(s[i]);
    if (code < 0) throw new RangeError(`Invalid character '${s[i]}' at position ${i + 1}`);
    const product = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

export function validateGstin(input: unknown): ValidationResult<GstinInfo> {
  const gstin = normalize(input);
  if (gstin.length !== 15) return fail(gstin, `GSTIN must be 15 characters, got ${gstin.length}`);
  if (!GSTIN_RE.test(gstin)) return fail(gstin, "GSTIN has an invalid format");

  const errors: string[] = [];
  const stateCode = gstin.slice(0, 2);
  const state = stateName(stateCode);
  if (!state) errors.push(`Unknown state code '${stateCode}'`);

  const pan = gstin.slice(2, 12);
  const panResult = validatePan(pan);
  if (!panResult.valid) errors.push(...panResult.errors.map((e) => `Embedded PAN: ${e}`));

  const expected = gstinCheckChar(gstin.slice(0, 14));
  if (expected !== gstin[14]) errors.push(`Checksum mismatch: expected '${expected}', got '${gstin[14]}'`);

  if (errors.length || !panResult.valid || !state) return fail(gstin, ...errors);

  return {
    valid: true,
    value: gstin,
    info: {
      stateCode,
      state,
      pan,
      panInfo: panResult.info,
      entityNumber: CHARSET.indexOf(gstin[12]),
      checkChar: expected,
    },
  };
}
