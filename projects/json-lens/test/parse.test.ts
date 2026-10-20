import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonError, MAX_DEPTH, parse, pathPart, position, stats, toValue } from "../src/parse.ts";
import { mutate, randomJson, rng } from "./random.ts";

function errorOf(text: string): JsonError {
  try {
    parse(text);
  } catch (e) {
    if (e instanceof JsonError) return e;
    throw e;
  }
  assert.fail(`expected ${JSON.stringify(text)} to be rejected`);
}

test("parses every kind of value", () => {
  const text = `{"s": "hi\\n\\u00e9\\ud83d\\ude00", "n": -1.5e3, "t": true, "f": false, "z": null, "a": [1, [], {}]}`;
  assert.deepEqual(toValue(parse(text).root), JSON.parse(text));
});

test("agrees with JSON.parse on 5,000 random documents", () => {
  const r = rng(1);
  for (let i = 0; i < 5000; i++) {
    const text = randomJson(r);
    assert.deepStrictEqual(toValue(parse(text).root), JSON.parse(text), text);
  }
});

test("accepts and rejects exactly what JSON.parse does, on 20,000 broken documents", () => {
  const r = rng(2);
  let rejected = 0;
  for (let i = 0; i < 20000; i++) {
    let text = randomJson(r);
    for (let k = 1 + Math.floor(r() * 2); k > 0; k--) text = mutate(r, text);
    let expected: unknown;
    let ok = true;
    try {
      expected = JSON.parse(text);
    } catch {
      ok = false;
    }
    if (ok) {
      assert.deepStrictEqual(toValue(parse(text).root), expected, text);
    } else {
      rejected++;
      const e = errorOf(text);
      assert.ok(e.offset >= 0 && e.offset <= text.length, `offset out of range for ${JSON.stringify(text)}`);
    }
  }
  assert.ok(rejected > 10000, `only ${rejected} broken documents: the test is too weak`);
});

test("keeps numbers exactly as written", () => {
  const root = parse(`[1.50, 12345678901234567890, 1E+2, -0]`).root;
  assert.equal(root.kind, "array");
  assert.deepEqual(root.items.map((n) => (n.kind === "number" ? n.raw : "")), ["1.50", "12345678901234567890", "1E+2", "-0"]);
});

test("keeps keys in their written order, including number-like keys", () => {
  const root = parse(`{"b": 1, "10": 2, "a": 3, "2": 4}`).root;
  assert.equal(root.kind, "object");
  assert.deepEqual(root.entries.map((e) => e.key), ["b", "10", "a", "2"]);
  // JSON.parse would put "2" and "10" first:
  assert.deepEqual(Object.keys(JSON.parse(`{"b": 1, "10": 2, "a": 3, "2": 4}`)), ["2", "10", "b", "a"]);
});

test("a key called __proto__ is just a key", () => {
  const v = toValue(parse(`{"__proto__": {"admin": true}}`).root) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).admin, undefined);
  assert.deepEqual(Object.keys(v), ["__proto__"]);
});

// [input, line, col, message part, hint part]
const errors: [string, number, number, string, string][] = [
  ["", 1, 1, "Empty input", "Paste some JSON"],
  ["   \n  ", 2, 3, "Empty input", ""],
  [`{"a": 1,}`, 1, 8, "Trailing comma before }", "Remove the comma"],
  [`[1,\n 2,\n]`, 2, 3, "Trailing comma before ]", "Remove the comma"],
  [`{name: "x"}`, 1, 2, `Key "name" is not in quotes`, `"name": ...`],
  [`{'a': 1}`, 1, 2, "Keys must use double quotes", "\"key\""],
  [`{"a": 'x'}`, 1, 7, "Strings must use double quotes", "\"text\""],
  [`{"ok": True}`, 1, 8, `Unexpected word "True"`, "lower case: true"],
  [`{"x": None}`, 1, 7, `Unexpected word "None"`, "use null"],
  [`[undefined]`, 1, 2, `Unexpected word "undefined"`, "use null"],
  [`[NaN]`, 1, 2, `Unexpected word "NaN"`, "no NaN"],
  [`[-Infinity]`, 1, 2, "no Infinity", "very large number"],
  [`[hello]`, 1, 2, `Unexpected word "hello"`, `"hello"`],
  [`{\n  // name\n  "a": 1\n}`, 2, 3, "Comments are not allowed", ".jsonc"],
  [`[1 /* x */]`, 1, 4, "Comments are not allowed", ""],
  [`{"pin": 0411}`, 1, 9, "leading zeros", "make it a string"],
  [`[+1]`, 1, 2, "can't start with +", ""],
  [`[.5]`, 1, 2, "can't start with a dot", "0.5"],
  [`[1.]`, 1, 4, "after the decimal point", ""],
  [`[1e]`, 1, 4, "in the exponent", ""],
  [`[-]`, 1, 3, "Expected a digit", ""],
  [`{"a": 1}\n{"b": 2}`, 2, 1, "after the end of the JSON value", "put them in an array"],
  [`{"a": 1}, {"b": 2}`, 1, 9, "after the end of the JSON value", "Wrap them in [ ]"],
  [`{"a": 1}}`, 1, 9, "after the end", "extra }"],
  [`{"a": [1, 2}`, 1, 12, "Found } but the open bracket here is [", "closed with ]"],
  [`[{"a": 1]`, 1, 9, "Found ] but the open bracket here is {", "closed with }"],
  [`{"a": 1 "b": 2}`, 1, 9, "Missing comma", ""],
  [`[1 2]`, 1, 4, "Missing comma", ""],
  [`[1,,2]`, 1, 4, "two commas in a row", ""],
  [`[,1]`, 1, 2, "Missing value before the comma", ""],
  [`{"a" 1}`, 1, 6, "Expected : after the key \"a\"", "colon"],
  [`{"a": }`, 1, 7, `Missing value for the key "a"`, "null"],
  [`{"a": 1`, 1, 8, "the { at line 1, column 1 is never closed", "missing }"],
  [`[\n  [1, 2],\n  [3`, 3, 5, "the [ at line 3, column 3 is never closed", "missing ]"],
  [`{"a": "abc`, 1, 7, "string is never closed", ""],
  [`{"a": "line\nbreak"}`, 1, 12, "Line break inside a string", "\\n"],
  [`["a\tb"]`, 1, 4, "Control character U+0009", "\\t"],
  [`["C:\\Users\\asha"]`, 1, 5, "Invalid escape \\U", "Windows paths"],
  [`["it\\'s"]`, 1, 5, "Invalid escape \\'", "needs no backslash"],
  [`["\\u12"]`, 1, 3, "4 hex digits", ""],
  [`[1 : 2]`, 1, 4, "Unexpected : inside an array", "object"],
  [`@`, 1, 1, `Unexpected "@"`, ""],
];

for (const [text, line, col, message, hint] of errors) {
  test(`error: ${JSON.stringify(text)}`, () => {
    const e = errorOf(text);
    assert.equal(e.line, line, `line (${e.message})`);
    assert.equal(e.col, col, `column (${e.message})`);
    assert.ok(e.message.includes(message), `message: ${e.message}`);
    assert.ok(e.message.endsWith(`(line ${line}, column ${col})`));
    assert.ok(e.hint.includes(hint), `hint: ${e.hint}`);
  });
}

test("warns about duplicate keys, big integers and a BOM", () => {
  const { warnings, root } = parse(`\ufeff{"id": 1,\n "id": 2, "n": 12345678901234567890, "ok": 9007199254740991}`);
  assert.deepEqual(warnings.map((w) => [w.line, w.message.slice(0, 30)]), [
    [1, "the text starts with an invisi"],
    [2, "duplicate key \"id\" (first used"],
    [2, "12345678901234567890 is too bi"],
  ]);
  assert.deepEqual(toValue(root), { id: 2, n: 12345678901234567890, ok: 9007199254740991 });
});

test("rejects nesting deeper than the limit, but handles deep enough documents", () => {
  const ok = "[".repeat(MAX_DEPTH) + "]".repeat(MAX_DEPTH);
  assert.equal(stats(parse(ok).root).maxDepth, MAX_DEPTH - 1);
  const e = errorOf("[".repeat(MAX_DEPTH + 1) + "]".repeat(MAX_DEPTH + 1));
  assert.match(e.message, /Nested more than 500 levels/);
});

test("a large document parses in linear time", () => {
  const big = JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, name: "user " + i, tags: ["a", "b"], score: i / 7 })));
  const t0 = performance.now();
  const { root } = parse(big);
  const ms = performance.now() - t0;
  assert.equal(stats(root).values, 1 + 20000 * 7);
  assert.ok(ms < 2000, `${big.length} bytes took ${ms.toFixed(0)} ms`);
});

test("stats", () => {
  assert.deepEqual(stats(parse(`{"a": [1, {"b": null}], "c": "x"}`).root), { values: 6, objects: 2, arrays: 1, keys: 3, maxDepth: 3 });
});

test("position counts lines and columns from 1", () => {
  assert.deepEqual(position("ab\ncd", 0), { line: 1, col: 1 });
  assert.deepEqual(position("ab\ncd", 3), { line: 2, col: 1 });
  assert.deepEqual(position("ab\ncd", 5), { line: 2, col: 3 });
});

test("paths use dot notation when they can", () => {
  assert.equal("$" + pathPart("users") + pathPart(0) + pathPart("first name") + pathPart("$ok"), `$.users[0]["first name"].$ok`);
});
