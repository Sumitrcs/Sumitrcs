import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.ts";
import { pascal, singular, toTypeScript } from "../src/types.ts";

const ts = (text: string, rootName?: string) => toTypeScript(parse(text).root, { rootName });

test("an API response", () => {
  assert.equal(ts(`{
    "id": 7, "name": "Asha", "verified": true, "tags": ["a"],
    "address": {"city": "Pune", "pin": "411001"},
    "orders": [
      {"id": "A-1", "total": 499.5, "items": [{"sku": "X", "qty": 2}]},
      {"id": "A-2", "total": 120, "coupon": "DIWALI", "items": []},
      {"id": "A-3", "total": 80, "coupon": null, "items": [{"sku": "Y", "qty": 1, "note": "gift"}]}
    ],
    "last-login": "2026-10-20", "categories": []
  }`, "user"), `export interface User {
  id: number;
  name: string;
  verified: boolean;
  tags: string[];
  address: Address;
  orders: Order[];
  "last-login": string;
  categories: unknown[];
}

export interface Address {
  city: string;
  pin: string;
}

export interface Order {
  id: string;
  total: number;
  items: Item[];
  coupon?: string | null;
}

export interface Item {
  sku: string;
  qty: number;
  note?: string;
}
`);
});

test("a top-level array gets an item interface", () => {
  assert.equal(ts(`[{"id": 1}, {"id": 2, "x": true}]`), `export type Root = RootItem[];

export interface RootItem {
  id: number;
  x?: boolean;
}
`);
});

test("plain values and mixed arrays", () => {
  assert.equal(ts(`42`), `export type Root = number;\n`);
  assert.equal(ts(`[]`), `export type Root = unknown[];\n`);
  assert.equal(ts(`[1, "a", null, 2]`), `export type Root = (number | string | null)[];\n`);
  assert.equal(ts(`[[1, 2], [3]]`), `export type Root = number[][];\n`);
  assert.equal(ts(`{"e": {}}`), `export interface Root {\n  e: Record<string, unknown>;\n}\n`);
});

test("objects mixed with other values in an array", () => {
  assert.equal(ts(`{"data": [{"a": 1}, null, {"a": 2, "b": "x"}]}`), `export interface Root {
  data: (DataItem | null)[];
}

export interface DataItem {
  a: number;
  b?: string;
}
`);
});

test("the same shape is reused; a different shape with the same name gets a number", () => {
  assert.equal(ts(`{"from": {"city": "A"}, "to": {"city": "B"}, "meta": {"x": {"city": 1}}, "x": {"y": 1}}`), `export interface Root {
  from: From;
  to: From;
  meta: Meta;
  x: X2;
}

export interface From {
  city: string;
}

export interface Meta {
  x: X;
}

export interface X {
  city: number;
}

export interface X2 {
  y: number;
}
`);
});

test("names", () => {
  assert.equal(pascal("user_profile"), "UserProfile");
  assert.equal(pascal("user-profile"), "UserProfile");
  assert.equal(pascal("userProfile"), "UserProfile");
  assert.equal(pascal("2fa codes"), "T2faCodes");
  assert.equal(pascal("!!!"), "");
  assert.equal(singular("Categories"), "Category");
  assert.equal(singular("Boxes"), "Box");
  assert.equal(singular("Addresses"), "Address");
  assert.equal(singular("Users"), "User");
  assert.equal(singular("Status"), "Status");
  assert.equal(singular("Data"), "DataItem");
});
