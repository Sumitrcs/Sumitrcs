// A JSON parser written by hand, so that it can do what JSON.parse can't:
//
//   - say exactly where an error is (line and column) and, for the mistakes
//     people actually make (trailing commas, single quotes, comments, Python's
//     True/None ...), what to do about it;
//   - keep numbers as the text they were written as, so 12345678901234567890
//     and 1.50 survive a format/minify round trip unchanged;
//   - keep keys in their original order and notice duplicate keys.
//
// The result is a small syntax tree (Node). toValue() turns it into ordinary
// JavaScript values when that's what you want.

export type Node =
  | { kind: "null"; offset: number }
  | { kind: "boolean"; value: boolean; offset: number }
  | { kind: "number"; raw: string; offset: number }
  | { kind: "string"; value: string; offset: number }
  | { kind: "array"; items: Node[]; offset: number }
  | { kind: "object"; entries: Entry[]; offset: number };

export interface Entry {
  key: string;
  value: Node;
  offset: number; // where the key starts
}

export interface Warning {
  message: string;
  line: number;
  col: number;
  offset: number;
}

export interface Parsed {
  root: Node;
  warnings: Warning[];
}

export class JsonError extends Error {
  line: number;
  col: number;
  offset: number;
  hint: string;
  constructor(message: string, text: string, offset: number, hint = "") {
    const { line, col } = position(text, offset);
    super(`${message} (line ${line}, column ${col})`);
    this.name = "JsonError";
    this.line = line;
    this.col = col;
    this.offset = offset;
    this.hint = hint;
  }
}

/** Deeper nesting than this is almost certainly a mistake (or an attack). */
export const MAX_DEPTH = 500;

/** Line and column (both from 1) of a character offset. */
export function position(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

// Words people write in "JSON" that come from other languages.
const WORD_HINTS: Record<string, string> = {
  True: "JSON booleans are lower case: true",
  False: "JSON booleans are lower case: false",
  TRUE: "JSON booleans are lower case: true",
  FALSE: "JSON booleans are lower case: false",
  None: "JSON has no None (that's Python): use null",
  Null: "JSON's null is lower case: null",
  NULL: "JSON's null is lower case: null",
  nil: "JSON has no nil: use null",
  undefined: "JSON has no undefined: use null, or leave the key out",
  NaN: "JSON has no NaN: use null, or a string like \"NaN\"",
  Infinity: "JSON has no Infinity: use null, or a very large number",
};

export function parse(text: string): Parsed {
  return new Parser(text).run();
}

class Parser {
  text: string;
  pos = 0;
  depth = 0;
  warnings: Warning[] = [];

  constructor(text: string) {
    this.text = text;
  }

  run(): Parsed {
    if (this.text.charCodeAt(0) === 0xfeff) {
      this.warn("the text starts with an invisible byte order mark (BOM); it was skipped", 0);
      this.pos = 1;
    }
    this.skipSpace();
    if (this.pos >= this.text.length) {
      throw this.error("Empty input", this.pos, "Paste some JSON, for example {\"name\": \"Asha\"}");
    }
    const root = this.value();
    this.skipSpace();
    if (this.pos < this.text.length) {
      const c = this.text[this.pos];
      let hint = "A JSON document is exactly one value. To hold several, put them in an array: [ {...}, {...} ]";
      if (c === ",") hint = "Several values separated by commas? Wrap them in [ ] to make an array";
      else if (c === "}" || c === "]") hint = `There is an extra ${c} here, or a matching ${c === "}" ? "{" : "["} is missing earlier`;
      throw this.error(`Unexpected ${describe(c)} after the end of the JSON value`, this.pos, hint);
    }
    return { root, warnings: this.warnings };
  }

  error(message: string, offset: number, hint = ""): JsonError {
    return new JsonError(message, this.text, offset, hint);
  }

  warn(message: string, offset: number): void {
    const { line, col } = position(this.text, offset);
    this.warnings.push({ message, line, col, offset });
  }

  skipSpace(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.pos++;
      } else if (c === "/" && (t[this.pos + 1] === "/" || t[this.pos + 1] === "*")) {
        throw this.error("Comments are not allowed in JSON", this.pos,
          "Remove the comment. (Some tools accept comments in .jsonc files, but JSON itself has none.)");
      } else {
        return;
      }
    }
  }

  value(): Node {
    const t = this.text;
    const start = this.pos;
    const c = t[start];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === "\"") return { kind: "string", value: this.string(), offset: start };
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    if (c === undefined) throw this.unexpectedEnd();
    if (c === "'") {
      throw this.error("Strings must use double quotes", start, "Change 'text' to \"text\"");
    }
    if (c === "+" || c === ".") return this.number(); // gives a precise message
    const word = /^[A-Za-z_$][\w$]*/.exec(t.slice(start, start + 40))?.[0];
    if (word === "true" || word === "false") {
      this.pos += word.length;
      return { kind: "boolean", value: word === "true", offset: start };
    }
    if (word === "null") {
      this.pos += 4;
      return { kind: "null", offset: start };
    }
    if (word) {
      const hint = WORD_HINTS[word] ?? "Text values need double quotes: \"" + word + "\"";
      throw this.error(`Unexpected word "${word}"`, start, hint);
    }
    throw this.error(`Unexpected ${describe(c)}`, start, "A value can be a string, number, object {...}, array [...], true, false or null");
  }

  enter(offset: number): void {
    if (++this.depth > MAX_DEPTH) {
      throw this.error(`Nested more than ${MAX_DEPTH} levels deep`, offset, "This is almost certainly not real data");
    }
  }

  object(): Node {
    const t = this.text;
    const start = this.pos;
    this.enter(start);
    this.pos++; // {
    const entries: Entry[] = [];
    const seen = new Map<string, number>();
    this.skipSpace();
    if (t[this.pos] === "}") {
      this.pos++;
      this.depth--;
      return { kind: "object", entries, offset: start };
    }
    for (;;) {
      this.skipSpace();
      const keyAt = this.pos;
      const c = t[keyAt];
      if (c !== "\"") {
        if (c === undefined) throw this.unclosed("{", start);
        if (c === "}" && entries.length > 0) {
          throw this.error("Trailing comma before }", this.lastComma(keyAt),
            "Remove the comma after the last item: JSON doesn't allow one");
        }
        if (c === "'") throw this.error("Keys must use double quotes", keyAt, "Change 'key' to \"key\"");
        const word = /^[A-Za-z_$][\w$]*/.exec(t.slice(keyAt, keyAt + 40))?.[0];
        if (word) throw this.error(`Key "${word}" is not in quotes`, keyAt, `In JSON every key needs double quotes: "${word}": ...`);
        throw this.error(`Expected a key in double quotes, found ${describe(c)}`, keyAt, "Each item in an object looks like \"key\": value");
      }
      const key = this.string();
      const first = seen.get(key);
      if (first !== undefined) {
        const { line } = position(t, first);
        this.warn(`duplicate key "${key}" (first used on line ${line}); most programs keep only the last one`, keyAt);
      } else {
        seen.set(key, keyAt);
      }
      this.skipSpace();
      if (t[this.pos] !== ":") {
        if (this.pos >= t.length) throw this.unclosed("{", start);
        throw this.error(`Expected : after the key "${key}", found ${describe(t[this.pos])}`, this.pos,
          "Keys and values are separated by a colon: \"key\": value");
      }
      this.pos++;
      this.skipSpace();
      if (t[this.pos] === "," || t[this.pos] === "}") {
        throw this.error(`Missing value for the key "${key}"`, this.pos, "Put a value after the colon, or null if there is none");
      }
      if (this.pos >= t.length) throw this.unclosed("{", start);
      entries.push({ key, value: this.value(), offset: keyAt });
      this.skipSpace();
      const d = t[this.pos];
      if (d === ",") {
        this.pos++;
        continue;
      }
      if (d === "}") {
        this.pos++;
        this.depth--;
        return { kind: "object", entries, offset: start };
      }
      if (d === undefined) throw this.unclosed("{", start);
      if (d === "\"") throw this.error("Missing comma between items", this.pos, "Put a comma after the previous value");
      if (d === "]") throw this.error("Found ] but the open bracket here is {", this.pos, `The object opened at line ${position(t, start).line} must be closed with }`);
      throw this.error(`Expected , or } after a value, found ${describe(d)}`, this.pos,
        d === "'" ? "Strings must use double quotes" : "Items in an object are separated by commas");
    }
  }

  array(): Node {
    const t = this.text;
    const start = this.pos;
    this.enter(start);
    this.pos++; // [
    const items: Node[] = [];
    this.skipSpace();
    if (t[this.pos] === "]") {
      this.pos++;
      this.depth--;
      return { kind: "array", items, offset: start };
    }
    for (;;) {
      this.skipSpace();
      const c = t[this.pos];
      if (c === undefined) throw this.unclosed("[", start);
      if (c === "]" && items.length > 0) {
        throw this.error("Trailing comma before ]", this.lastComma(this.pos), "Remove the comma after the last item: JSON doesn't allow one");
      }
      if (c === ",") {
        throw this.error(items.length ? "Missing value: two commas in a row" : "Missing value before the comma", this.pos,
          "Remove the extra comma, or put null where the value should be");
      }
      items.push(this.value());
      this.skipSpace();
      const d = t[this.pos];
      if (d === ",") {
        this.pos++;
        continue;
      }
      if (d === "]") {
        this.pos++;
        this.depth--;
        return { kind: "array", items, offset: start };
      }
      if (d === undefined) throw this.unclosed("[", start);
      if (d === "}") throw this.error("Found } but the open bracket here is [", this.pos, `The array opened at line ${position(t, start).line} must be closed with ]`);
      if (d === ":") throw this.error("Unexpected : inside an array", this.pos, "Arrays hold plain values. For key: value pairs use an object { }");
      if (/["\[{\-0-9tfn]/.test(d)) throw this.error("Missing comma between items", this.pos, "Put a comma after the previous value");
      throw this.error(`Expected , or ] after a value, found ${describe(d)}`, this.pos, "Put a comma between the items of an array");
    }
  }

  // Offset of the comma before position `at`, for trailing-comma errors.
  lastComma(at: number): number {
    const i = this.text.lastIndexOf(",", at);
    return i >= 0 ? i : at;
  }

  unclosed(bracket: string, start: number): JsonError {
    const { line, col } = position(this.text, start);
    const close = bracket === "{" ? "}" : "]";
    return this.error(`Unexpected end of input: the ${bracket} at line ${line}, column ${col} is never closed`, this.text.length,
      `Add the missing ${close}, or check that the text wasn't cut off when copying`);
  }

  unexpectedEnd(): JsonError {
    return this.error("Unexpected end of input: a value is missing", this.text.length, "The text may have been cut off when copying");
  }

  string(): string {
    const t = this.text;
    const start = this.pos;
    this.pos++; // opening quote
    let out = "";
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= t.length) {
        throw this.error("This string is never closed", start, "Add the closing \" at the end of the text");
      }
      const code = t.charCodeAt(this.pos);
      if (code === 0x22) { // "
        out += t.slice(chunk, this.pos);
        this.pos++;
        return out;
      }
      if (code === 0x5c) { // backslash
        out += t.slice(chunk, this.pos);
        out += this.escape();
        chunk = this.pos;
        continue;
      }
      if (code < 0x20) {
        if (code === 0x0a) {
          throw this.error("Line break inside a string", this.pos,
            "Write a line break as \\n, or check for a missing closing \" on the line before");
        }
        throw this.error(`Control character U+${hex4(code)} inside a string`, this.pos,
          code === 0x09 ? "Write a tab as \\t" : "Write it as an escape, e.g. \\u" + hex4(code));
      }
      this.pos++;
    }
  }

  escape(): string {
    const t = this.text;
    const at = this.pos;
    const c = t[at + 1];
    this.pos += 2;
    switch (c) {
      case "\"": return "\"";
      case "\\": return "\\";
      case "/": return "/";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "u": {
        const digits = t.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
          throw this.error("\\u must be followed by 4 hex digits", at, "For example \\u00e9 is é");
        }
        this.pos += 4;
        return String.fromCharCode(parseInt(digits, 16));
      }
      case undefined:
        throw this.error("This string is never closed", at, "Add the closing \" at the end of the text");
      default:
        throw this.error(`Invalid escape \\${c}`, at,
          c === "'" ? "A single quote needs no backslash inside a JSON string" :
          "Valid escapes are \\\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX. For a backslash itself write \\\\ (common in Windows paths)");
    }
  }

  number(): Node {
    const t = this.text;
    const start = this.pos;
    let i = start;
    const digits = () => {
      const from = i;
      while (t[i] >= "0" && t[i] <= "9") i++;
      return i - from;
    };
    if (t[i] === "+") throw this.error("Numbers can't start with +", i, "Remove the + sign");
    if (t[i] === ".") throw this.error("Numbers can't start with a dot", i, "Write 0.5, not .5");
    if (t[i] === "-") i++;
    if (t[i] === "0" && t[i + 1] >= "0" && t[i + 1] <= "9") {
      throw this.error("Numbers can't have leading zeros", i,
        "Write 7, not 07. If it's a code like a PIN or phone number, make it a string: \"07\"");
    }
    if (digits() === 0) {
      if (/^-?Infinity/.test(t.slice(start, start + 9))) throw this.error("JSON has no Infinity", start, WORD_HINTS.Infinity);
      throw this.error("Expected a digit", i, "A number looks like 42, -3.5 or 1e6");
    }
    if (t[i] === ".") {
      i++;
      if (digits() === 0) throw this.error("Expected a digit after the decimal point", i, "Write 1.0 or 1, not 1.");
    }
    if (t[i] === "e" || t[i] === "E") {
      i++;
      if (t[i] === "+" || t[i] === "-") i++;
      if (digits() === 0) throw this.error("Expected a digit in the exponent", i, "An exponent looks like 1e6 or 2.5E-3");
    }
    const raw = t.slice(start, i);
    this.pos = i;
    if (/^-?\d+$/.test(raw) && !Number.isSafeInteger(Number(raw))) {
      this.warn(`${raw} is too big to be exact in JavaScript (it becomes ${Number(raw)}); store IDs like this as strings`, start);
    }
    return { kind: "number", raw, offset: start };
  }
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

function describe(c: string | undefined): string {
  if (c === undefined) return "end of input";
  if (c === "\n") return "line break";
  if (c.charCodeAt(0) < 0x20) return `control character U+${hex4(c.charCodeAt(0))}`;
  return `"${c}"`;
}

/** Converts the tree to plain JavaScript values, exactly as JSON.parse would. */
export function toValue(node: Node): unknown {
  switch (node.kind) {
    case "null": return null;
    case "boolean": return node.value;
    case "number": return Number(node.raw);
    case "string": return node.value;
    case "array": return node.items.map(toValue);
    case "object": {
      const out: Record<string, unknown> = {};
      for (const e of node.entries) {
        // defineProperty, so a key called "__proto__" is stored as a normal key.
        Object.defineProperty(out, e.key, { value: toValue(e.value), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
  }
}

export interface Stats {
  values: number;
  objects: number;
  arrays: number;
  keys: number;
  maxDepth: number;
}

export function stats(root: Node): Stats {
  const s: Stats = { values: 0, objects: 0, arrays: 0, keys: 0, maxDepth: 0 };
  const walk = (n: Node, depth: number): void => {
    s.values++;
    s.maxDepth = Math.max(s.maxDepth, depth);
    if (n.kind === "array") {
      s.arrays++;
      for (const item of n.items) walk(item, depth + 1);
    } else if (n.kind === "object") {
      s.objects++;
      s.keys += n.entries.length;
      for (const e of n.entries) walk(e.value, depth + 1);
    }
  };
  walk(root, 0);
  return s;
}

/** A JavaScript expression path for a key, e.g. $.users[0].name or $["first name"]. */
export function pathPart(key: string | number): string {
  if (typeof key === "number") return `[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}
