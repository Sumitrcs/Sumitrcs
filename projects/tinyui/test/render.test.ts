import { test } from "node:test";
import assert from "node:assert/strict";
import { container, html, ops, resetOps, type FakeElement } from "./fakedom.ts";
import { Fragment, flush, h, longestIncreasing, render, unmountRoot, type VNode } from "../src/tinyui.ts";

test("renders elements, text, attributes and nested children", () => {
  const root = container();
  render(h("div", { class: "card", id: "x", hidden: false }, h("h1", null, "Hello ", 42), h("p", { title: "t" }, "body")), root);
  assert.equal(html(root), '<div class="card" id="x"><h1>Hello 42</h1><p title="t">body</p></div>');
});

test("null, false and true render nothing; arrays are flattened", () => {
  const root = container();
  const show = false;
  render(h("ul", null, [h("li", null, "a"), [h("li", null, "b")]], show && h("li", null, "hidden"), null, true), root);
  assert.equal(html(root), "<ul><li>a</li><li>b</li></ul>");
});

test("boolean attributes, className and style objects", () => {
  const root = container();
  render(h("input", { disabled: true, className: "big", style: { fontSize: 14, color: "red", "--gap": "2px", margin: 0 } }), root);
  assert.equal(html(root), '<input disabled class="big" style="font-size: 14px; color: red; --gap: 2px; margin: 0"></input>');
  render(h("input", { disabled: false, className: "big", style: { color: "blue" } }), root);
  assert.equal(html(root), '<input class="big" style="color: blue"></input>');
  render(h("div", { style: { opacity: 0.5, zIndex: 3, "--hue": 120, width: 40 } }), root);
  assert.equal(html(root), '<div style="opacity: 0.5; z-index: 3; --hue: 120; width: 40px"></div>');
});

test("an update only touches what changed", () => {
  const root = container();
  const view = (n: number) => h("div", { class: "box" }, h("span", null, "count: "), h("b", null, n));
  render(view(1), root);
  const b = root.querySelector("b");
  resetOps();
  render(view(2), root);
  assert.equal(html(root), '<div class="box"><span>count: </span><b>2</b></div>');
  assert.deepEqual(ops, { created: 0, inserted: 0, removed: 0, attrs: 0, text: 1 });
  assert.equal(root.querySelector("b"), b, "the same DOM element is reused");
});

test("a different element type replaces the node", () => {
  const root = container();
  render(h("div", null, h("p", null, "x")), root);
  render(h("div", null, h("section", null, "x")), root);
  assert.equal(html(root), "<div><section>x</section></div>");
});

const list = (keys: (string | number)[]) => h("ul", null, keys.map((k) => h("li", { key: k }, String(k))));

test("keyed lists: every reordering ends up right", () => {
  const cases: [string, string][] = [
    ["abcd", "dcba"], ["abcd", "dabc"], ["abcd", "bcda"], ["abcd", "acbd"], ["abcd", "abcde"],
    ["abcd", "xabcd"], ["abcd", "abd"], ["abcd", ""], ["", "abc"], ["abcdef", "fbdace"], ["abc", "xyz"],
  ];
  for (const [from, to] of cases) {
    const root = container();
    render(list([...from]), root);
    const before = new Map(root.querySelectorAll("li").map((li) => [li.textContent, li]));
    render(list([...to]), root);
    assert.equal(root.textContent, to, `${from} → ${to}`);
    for (const li of root.querySelectorAll("li")) {
      if (before.has(li.textContent)) assert.equal(li, before.get(li.textContent), `${li.textContent} kept its DOM node`);
    }
  }
});

test("keyed lists move the fewest nodes", () => {
  const moves = (from: string, to: string) => {
    const root = container();
    render(list([...from]), root);
    resetOps();
    render(list([...to]), root);
    return ops.inserted;
  };
  assert.equal(moves("abcd", "dabc"), 1); // only d moves
  assert.equal(moves("abcd", "bcda"), 1); // only a moves
  assert.equal(moves("abcde", "aecdb"), 2); // b and e swap: c d stay
  assert.equal(moves("abcd", "dcba"), 3);
  assert.equal(moves("abcd", "abcd"), 0);
  assert.equal(moves("abcd", "abxcd"), 2); // the new li: its text goes in, then it goes in the list
});

test("random keyed shuffles stay correct", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const root = container();
  let keys: number[] = [];
  for (let round = 0; round < 300; round++) {
    const pool = Array.from({ length: 12 }, (_, i) => i).filter(() => rand() < 0.7);
    keys = pool.sort(() => rand() - 0.5);
    render(list(keys), root);
    assert.equal(root.querySelectorAll("li").map((li) => li.textContent).join(","), keys.join(","));
  }
});

test("unkeyed lists are matched by position", () => {
  const root = container();
  render(h("ul", null, h("li", null, "a"), h("li", null, "b")), root);
  const [first] = root.querySelectorAll("li");
  render(h("ul", null, h("li", null, "x"), h("li", null, "b"), h("li", null, "c")), root);
  assert.equal(html(root), "<ul><li>x</li><li>b</li><li>c</li></ul>");
  assert.equal(root.querySelectorAll("li")[0], first);
});

test("fragments render several nodes without a wrapper", () => {
  const root = container();
  const view = (items: string[]) => h("div", null, h("b", null, "start"), h(Fragment, null, items.map((t) => h("i", { key: t }, t))), h("b", null, "end"));
  render(view(["1", "2"]), root);
  assert.equal(html(root), "<div><b>start</b><i>1</i><i>2</i><b>end</b></div>");
  render(view(["2", "3", "1"]), root);
  assert.equal(html(root), "<div><b>start</b><i>2</i><i>3</i><i>1</i><b>end</b></div>");
  render(view([]), root);
  assert.equal(html(root), "<div><b>start</b><b>end</b></div>");
  render(view(["9"]), root);
  assert.equal(html(root), "<div><b>start</b><i>9</i><b>end</b></div>");
});

test("events call the latest handler, through a single listener", () => {
  const root = container();
  const calls: string[] = [];
  render(h("button", { onClick: () => calls.push("first") }, "go"), root);
  const button = root.querySelector("button")!;
  button.fire("click");
  render(h("button", { onClick: () => calls.push("second") }, "go"), root);
  button.fire("click");
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(button.listeners.get("click")!.size, 1);
  render(h("button", null, "go"), root);
  button.fire("click");
  assert.equal(calls.length, 2);
  assert.equal(button.listeners.get("click")!.size, 0);
});

test("value and checked are set as properties", () => {
  const root = container();
  render(h("input", { value: "hi", checked: true }), root);
  const input = root.querySelector("input") as FakeElement;
  assert.equal(input.value, "hi");
  assert.equal(input.checked, true);
  assert.equal(input.getAttribute("value"), null);
  input.value = "typed"; // the user types; the state still says "hi"
  render(h("input", { value: "hi", checked: true }), root);
  assert.equal(input.value, "hi", "the input follows the state (a controlled input)");
});

test("refs point at the DOM element, and are cleared on unmount", () => {
  const root = container();
  const ref = { current: null as any };
  render(h("div", null, h("canvas", { ref })), root);
  assert.equal(ref.current, root.querySelector("canvas"));
  render(h("div", null), root);
  assert.equal(ref.current, null);
});

test("render(null) and unmountRoot clear the container", () => {
  const root = container();
  render(h("p", null, "x"), root);
  render(null, root);
  assert.equal(html(root), "");
  render(h("p", null, "y"), root);
  assert.equal(html(root), "<p>y</p>");
  unmountRoot(root);
  assert.equal(root.childNodes.length, 0);
  flush(); // nothing pending: harmless
});

test("longest increasing subsequence", () => {
  const values = (seq: number[]) => longestIncreasing(seq).map((i) => seq[i]);
  assert.deepEqual(values([3, 0, 1, 2]), [0, 1, 2]);
  assert.deepEqual(values([0, 8, 4, 12, 2, 10, 6, 14, 1, 9]).length, 4);
  assert.deepEqual(values([-1, 2, -1, 3]), [2, 3]);
  assert.deepEqual(values([]), []);
  assert.deepEqual(values([3, 2, 1]).length, 1);
  // Check against brute force on random sequences.
  for (let t = 0; t < 200; t++) {
    const seq = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10) - 1);
    let best = 0;
    for (let mask = 0; mask < 256; mask++) {
      const picked = seq.filter((v, i) => mask & (1 << i) && v >= 0);
      if (picked.every((v, i) => i === 0 || v > picked[i - 1]) && picked.length === seq.filter((v, i) => mask & (1 << i)).length) {
        best = Math.max(best, picked.length);
      }
    }
    const got = values(seq);
    assert.equal(got.length, best, `seq ${seq}`);
    assert.ok(got.every((v, i) => i === 0 || v > got[i - 1]));
  }
});

test("h() keeps the key out of props", () => {
  const v: VNode = h("li", { key: 3, class: "x" }, "t");
  assert.equal(v.key, 3);
  assert.deepEqual(v.props, { class: "x" });
});
