export { diff, distance, type Edit, type Op } from "./myers.ts";
export { applyPatch, hunks, parsePatch, PatchError, unifiedDiff, type Hunk, type UnifiedOptions } from "./unified.ts";
export { merge3, type MergeResult } from "./merge.ts";
export { diffChars, diffWords, type Segment } from "./inline.ts";
