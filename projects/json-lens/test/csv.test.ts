import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.ts";
import { CsvError, quote, toCsv } from "../src/csv.ts";

const csv = (text: string) => toCsv(parse(text).root);

test("an array of objects, with nested keys flattened", () => {
  assert.equal(csv(`[
    {"id": 1, "name": "Asha", "address": {"city": "Pune", "pin": "411001"}, "tags": ["a", "b"]},
    {"id": 2, "name": "Ravi, Jr.", "address": {"city": "Delhi"}, "active": false, "tags": []}
  ]`), [
    "id,name,address.city,address.pin,tags,active",
    "1,Asha,Pune,411001,a; b,",
    "2,\"Ravi, Jr.\",Delhi,,,false",
    "",
  ].join("\r\n"));
});

test("quotes, line breaks and nested arrays of objects", () => {
  assert.equal(csv(`[{"q": "say \\"hi\\"", "nl": "a\\nb", "items": [{"x": 1}], "n": null, "e": {}}]`),
    `q,nl,items,n,e\r\n"say ""hi""","a\nb","[{""x"":1}]",,{}\r\n`);
});

test("formula-like text is defused, numbers are not", () => {
  assert.equal(csv(`[{"a": "=SUM(A1:A9)", "b": "-x", "c": -5, "d": "@cmd"}]`), `a,b,c,d\r\n'=SUM(A1:A9),'-x,-5,'@cmd\r\n`);
});

test("plain values become a value column; one object is one row", () => {
  assert.equal(csv(`[1, "two", null]`), `value\r\n1\r\ntwo\r\n\r\n`);
  assert.equal(csv(`{"a": 1}`), `a\r\n1\r\n`);
});

test("errors", () => {
  assert.throws(() => csv(`"text"`), CsvError);
  assert.throws(() => csv(`[]`), /empty/);
});

test("quote", () => {
  assert.equal(quote("plain"), "plain");
  assert.equal(quote(" padded"), "\" padded\"");
  assert.equal(quote("a\rb"), "\"a\rb\"");
});
