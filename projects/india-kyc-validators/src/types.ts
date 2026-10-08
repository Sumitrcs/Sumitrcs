export type ValidationResult<T = undefined> =
  | { valid: true; value: string; info: T }
  | { valid: false; value: string; errors: string[] };

export function normalize(input: unknown): string {
  return String(input ?? "").replace(/[\s-]/g, "").toUpperCase();
}

export function fail<T>(value: string, ...errors: string[]): ValidationResult<T> {
  return { valid: false, value, errors };
}
