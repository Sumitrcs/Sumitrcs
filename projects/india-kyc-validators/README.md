# india-kyc-validators

[![CI](https://github.com/Sumitrcs/india-kyc-validators/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/india-kyc-validators/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Zero-dependency TypeScript validators for Indian identifiers. Every validator
returns a typed result with either decoded information or a list of human
readable errors — handy for onboarding forms, invoicing software and KYC
pipelines.

| Identifier | What is checked |
|---|---|
| **GSTIN** | format, state code, embedded PAN, **mod-36 checksum** |
| **PAN** | format, holder type (Individual, Company, HUF, Firm …) |
| **Aadhaar** | 12 digits, first digit rule, **Verhoeff checksum** |
| **IFSC** | bank code + branch code |
| **TAN** | format, city code |
| **UPI ID** | handle and PSP provider |
| **PIN code** | format and postal region |
| **Vehicle number** | standard and Bharat (BH) series |

## Usage

```ts
import { validateGstin, validatePan, validateAadhaar } from "india-kyc-validators";

const r = validateGstin("27AAPFU0939F1ZV");
if (r.valid) {
  console.log(r.info.state);              // "Maharashtra"
  console.log(r.info.panInfo.entityType); // "Firm / LLP"
} else {
  console.log(r.errors);                  // ["Checksum mismatch: expected 'V', got 'W'"]
}
```

Inputs are normalised — spaces, hyphens and lower case are accepted, so
`"27aapfu0939f1zv"` and `"2345 6789 0123"` work as typed by users.

## How the checksums work

**GSTIN (15th character).** Each of the first 14 characters is mapped to its
index in `0-9A-Z`. Weights alternate 1, 2, 1, 2 … Each product is folded as
`floor(p / 36) + p % 36` and summed. The check character is
`(36 - sum % 36) % 36` mapped back to the charset.

**Aadhaar (12th digit).** Uses the Verhoeff algorithm, based on the dihedral
group D5. Unlike Luhn it detects *every* single-digit error and *every*
adjacent transposition — there is a test that proves it.

## Running tests

Requires Node.js 22.18+ (runs TypeScript natively, no build step).

```bash
npm test
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
