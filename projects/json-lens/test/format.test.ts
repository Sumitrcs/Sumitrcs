import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.ts";
import { byteSize, format, humanSize } from "../src/format.ts";
import { randomJson, rng } from "./random.ts";

const fmt = (text: string, opts = {}) => format(parse(text).root, opts);

test("output matches JSON.stringify for 3,000 random documents", () => {
  const r = rng(3);
  for (let i = 0; i < 3000; i++) {
    const value = JSON.parse(randomJson(r));
    const canonical = JSON.stringify(value);
    assert.equal(fmt(canonical, { indent: 0 }), canonical);
    assert.equal(fmt(canonical, { indent: 2 }), JSON.stringify(value, null, 2));
    assert.equal(fmt(canonical, { indent: 4 }), JSON.stringify(value, null, 4));
    assert.equal(fmt(canonical, { indent: "tab" }), JSON.stringify(value, null, "\t"));
  }
});

test("formatting is idempotent and minify undoes it", () => {
  const r = rng(4);
  for (let i = 0; i < 1000; i++) {
    const text = randomJson(r);
    const pretty = fmt(text);
    assert.equal(fmt(pretty), pretty);
    assert.equal(fmt(pretty, { indent: 0 }), fmt(text, { indent: 0 }));
  }
});

test("numbers and escapes are kept as written", () => {
  assert.equal(fmt(`{ "id" : 12345678901234567890 , "price": 1.50, "e": 1E+2 }`, { indent: 0 }),
    `{"id":12345678901234567890,"price":1.50,"e":1E+2}`);
  assert.equal(fmt(`["\\u00e9\\/"]`, { indent: 0 }), `["é/"]`);
});

test("sort keys, recursively and stably", () => {
  assert.equal(fmt(`{"b": 1, "a": {"z": 0, "y": [{"d": 1, "c": 2}]}, "B": 2}`, { indent: 0, sortKeys: true }),
    `{"B":2,"a":{"y":[{"c":2,"d":1}],"z":0},"b":1}`);
});

test("empty containers stay on one line", () => {
  assert.equal(fmt(`{"a": [], "b": {}}`), `{\n  "a": [],\n  "b": {}\n}`);
});

test("sizes", () => {
  assert.equal(byteSize("é😀"), 6);
  assert.equal(humanSize(512), "512 B");
  assert.equal(humanSize(2048), "2.0 KB");
  assert.equal(humanSize(3 * 1024 * 1024), "3.0 MB");
});
