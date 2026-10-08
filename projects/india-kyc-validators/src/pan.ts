import { fail, normalize, type ValidationResult } from "./types.ts";

export const PAN_ENTITY_TYPES: Readonly<Record<string, string>> = Object.freeze({
  P: "Individual",
  C: "Company",
  H: "Hindu Undivided Family",
  F: "Firm / LLP",
  A: "Association of Persons",
  T: "Trust",
  B: "Body of Individuals",
  L: "Local Authority",
  J: "Artificial Juridical Person",
  G: "Government",
});

export interface PanInfo {
  entityCode: string;
  entityType: string;
  /** 5th character: first letter of surname (individuals) or of the entity name. */
  nameInitial: string;
}

const PAN_RE = /^[A-Z]{3}[A-Z][A-Z][0-9]{4}[A-Z]$/;

export function validatePan(input: unknown): ValidationResult<PanInfo> {
  const pan = normalize(input);
  if (pan.length !== 10) return fail(pan, `PAN must be 10 characters, got ${pan.length}`);
  if (!PAN_RE.test(pan)) return fail(pan, "PAN must match AAAAA9999A");

  const entityCode = pan[3];
  const entityType = PAN_ENTITY_TYPES[entityCode];
  if (!entityType) return fail(pan, `Unknown PAN holder type '${entityCode}' at position 4`);

  return { valid: true, value: pan, info: { entityCode, entityType, nameInitial: pan[4] } };
}
