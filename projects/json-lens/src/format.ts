// Turns the syntax tree back into JSON text: pretty-printed or minified,
// optionally with object keys sorted. Numbers are written exactly as they
// were read (see parse.ts), so nothing changes except the whitespace.
import type { Node } from "./parse.ts";

export interface FormatOptions {
  indent?: number | "tab"; // 0 = minify
  sortKeys?: boolean;
}

export function format(root: Node, opts: FormatOptions = {}): string {
  const indent = opts.indent === "tab" ? "\t" : " ".repeat(opts.indent ?? 2);
  const parts: string[] = [];
  const write = (n: Node, pad: string): void => {
    switch (n.kind) {
      case "null": parts.push("null"); return;
      case "boolean": parts.push(String(n.value)); return;
      case "number": parts.push(n.raw); return;
      case "string": parts.push(JSON.stringify(n.value)); return;
      case "array": {
        if (n.items.length === 0) {
          parts.push("[]");
          return;
        }
        const inner = pad + indent;
        parts.push("[");
        n.items.forEach((item, i) => {
          if (i > 0) parts.push(",");
          if (indent) parts.push("\n", inner);
          write(item, inner);
        });
        if (indent) parts.push("\n", pad);
        parts.push("]");
        return;
      }
      case "object": {
        if (n.entries.length === 0) {
          parts.push("{}");
          return;
        }
        const entries = opts.sortKeys ? sortedEntries(n.entries) : n.entries;
        const inner = pad + indent;
        parts.push("{");
        entries.forEach((e, i) => {
          if (i > 0) parts.push(",");
          if (indent) parts.push("\n", inner);
          parts.push(JSON.stringify(e.key), indent ? ": " : ":");
          write(e.value, inner);
        });
        if (indent) parts.push("\n", pad);
        parts.push("}");
        return;
      }
    }
  };
  write(root, "");
  return parts.join("");
}

// Sorting is stable, so duplicate keys keep their original order.
function sortedEntries<T extends { key: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Size in bytes when saved as UTF-8. */
export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
