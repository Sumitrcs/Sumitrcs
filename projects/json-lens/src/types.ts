// Generates TypeScript interfaces that describe a JSON document.
//
// It works in two steps:
//   1. infer a Shape for every value. Arrays are the interesting part: all
//      their items are merged into one shape, so a key that only some of the
//      objects have becomes optional (key?: ...), and an item that is
//      sometimes a string and sometimes null becomes string | null;
//   2. give every object shape a name (from its key: "orders" → Order) and
//      print one interface per name.
import type { Node } from "./parse.ts";

type Shape =
  | { t: "string" | "number" | "boolean" | "null" | "never" }
  | { t: "array"; item: Shape }
  | { t: "object"; fields: Map<string, Field> }
  | { t: "union"; options: Shape[] };

interface Field {
  shape: Shape;
  optional: boolean;
}

const NEVER: Shape = { t: "never" }; // the item type of an empty array, for now

export function infer(n: Node): Shape {
  switch (n.kind) {
    case "null": return { t: "null" };
    case "boolean": return { t: "boolean" };
    case "number": return { t: "number" };
    case "string": return { t: "string" };
    case "array": return { t: "array", item: n.items.map(infer).reduce(merge, NEVER) };
    case "object": {
      const fields = new Map<string, Field>();
      for (const e of n.entries) {
        // A duplicate key: the last value wins, as in JSON.parse.
        fields.set(e.key, { shape: infer(e.value), optional: false });
      }
      return { t: "object", fields };
    }
  }
}

/** The smallest shape that fits both a and b. */
export function merge(a: Shape, b: Shape): Shape {
  if (a.t === "never") return b;
  if (b.t === "never") return a;
  if (a.t === "union" || b.t === "union") {
    let out = a.t === "union" ? a.options : [a];
    for (const s of b.t === "union" ? b.options : [b]) out = addOption(out, s);
    return out.length === 1 ? out[0] : { t: "union", options: out };
  }
  if (a.t === "object" && b.t === "object") {
    const fields = new Map<string, Field>();
    for (const [k, fa] of a.fields) {
      const fb = b.fields.get(k);
      fields.set(k, fb
        ? { shape: merge(fa.shape, fb.shape), optional: fa.optional || fb.optional }
        : { shape: fa.shape, optional: true });
    }
    for (const [k, fb] of b.fields) {
      if (!a.fields.has(k)) fields.set(k, { shape: fb.shape, optional: true });
    }
    return { t: "object", fields };
  }
  if (a.t === "array" && b.t === "array") return { t: "array", item: merge(a.item, b.item) };
  if (a.t === b.t) return a;
  return { t: "union", options: addOption([a], b) };
}

// Adds s to a list of union options, merging it into an option of the same
// kind (two object shapes become one) instead of listing both.
function addOption(options: Shape[], s: Shape): Shape[] {
  const i = options.findIndex((o) => o.t === s.t);
  if (i < 0) return [...options, s];
  const out = [...options];
  out[i] = merge(options[i], s);
  return out;
}

export interface TypeOptions {
  rootName?: string;
}

export function toTypeScript(root: Node, opts: TypeOptions = {}): string {
  const rootName = pascal(opts.rootName ?? "Root") || "Root";
  const shape = infer(root);
  const blocks: string[] = []; // printed interfaces, in order
  const byBody = new Map<string, string>(); // interface body → its name
  const used = new Set<string>();

  const uniqueName = (wanted: string): string => {
    let name = wanted;
    for (let i = 2; used.has(name); i++) name = wanted + i;
    used.add(name);
    return name;
  };

  // Returns the TypeScript type for a shape, printing interfaces as needed.
  // An object reserves its place in the list before its children are
  // printed, so the outermost interface comes first.
  const typeOf = (s: Shape, nameHint: string): string => {
    switch (s.t) {
      case "never": return "unknown";
      case "string": case "number": case "boolean": case "null": return s.t;
      case "array": {
        const inner = typeOf(s.item, singular(nameHint));
        return /[ |]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
      }
      case "union": {
        const parts = s.options.map((o) => typeOf(o, nameHint));
        // null last reads better: string | null
        return [...parts.filter((p) => p !== "null"), ...parts.filter((p) => p === "null")].join(" | ");
      }
      case "object": {
        if (s.fields.size === 0) return "Record<string, unknown>";
        const slot = blocks.push("") - 1;
        const lines: string[] = [];
        for (const [key, f] of s.fields) {
          const prop = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
          lines.push(`  ${prop}${f.optional ? "?" : ""}: ${typeOf(f.shape, pascal(key) || "Item")};`);
        }
        const body = lines.join("\n");
        const existing = byBody.get(body);
        if (existing) return existing; // the same shape seen before: reuse its name
        const name = uniqueName(nameHint);
        byBody.set(body, name);
        blocks[slot] = `export interface ${name} {\n${body}\n}`;
        return name;
      }
    }
  };

  const top = typeOf(shape, rootName); // a top-level array of objects gives RootItem
  if (top !== rootName) blocks.unshift(`export type ${rootName} = ${top};`);
  return blocks.filter(Boolean).join("\n\n") + "\n";
}

/** "user_profile", "user-profile", "userProfile" → "UserProfile". */
export function pascal(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return /^[0-9]/.test(name) ? "T" + name : name;
}

/** A rough English singular, good enough for type names: "categories" → "Category". */
export function singular(name: string): string {
  if (/ies$/.test(name) && name.length > 4) return name.slice(0, -3) + "y";
  if (/(ss|sh|ch|x|z)es$/.test(name)) return name.slice(0, -2);
  if (/(us|ss|is)$/.test(name)) return name; // status, address, analysis
  if (/s$/.test(name) && name.length > 1) return name.slice(0, -1);
  return name + "Item";
}
