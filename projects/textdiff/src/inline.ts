import { diff } from "./myers.ts";

export interface Segment {
  op: "equal" | "insert" | "delete";
  text: string;
}

/** Word-level diff of two strings, keeping whitespace and punctuation as tokens. */
export function diffWords(a: string, b: string): Segment[] {
  const tokenize = (s: string) => s.match(/\w+|\s+|[^\w\s]/gu) ?? [];
  return diff(tokenize(a), tokenize(b)).map((e) => ({ op: e.op, text: e.items.join("") }));
}

/** Character-level diff, useful for highlighting changes inside short lines. */
export function diffChars(a: string, b: string): Segment[] {
  return diff([...a], [...b]).map((e) => ({ op: e.op, text: e.items.join("") }));
}
