import { test } from "node:test";
import assert from "node:assert/strict";
import { container, html, type FakeElement } from "./fakedom.ts";
import {
  flush, h, render, unmountRoot, useCallback, useEffect, useMemo, useReducer, useRef, useState, type Child,
} from "../src/tinyui.ts";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("function components get props and children", () => {
  const Card = ({ title, children }: { title: string; children: Child[] }) => h("section", null, h("h2", null, title), children);
  const root = container();
  render(h(Card, { title: "Hi" }, h("p", null, "one"), h("p", null, "two")), root);
  assert.equal(html(root), "<section><h2>Hi</h2><p>one</p><p>two</p></section>");
});

test("components can return nothing, text or several nodes", () => {
  const Maybe = ({ show }: { show: boolean }) => (show ? "yes" : null);
  const Pair = () => [h("i", null, "a"), h("i", null, "b")];
  const root = container();
  render(h("div", null, h(Maybe, { show: false }), h(Pair, null), h("b", null, "end")), root);
  assert.equal(html(root), "<div><i>a</i><i>b</i><b>end</b></div>");
  render(h("div", null, h(Maybe, { show: true }), h(Pair, null), h("b", null, "end")), root);
  assert.equal(html(root), "<div>yes<i>a</i><i>b</i><b>end</b></div>");
});

test("useState: clicking re-renders, and several updates are batched", async () => {
  let renders = 0;
  const Counter = () => {
    renders++;
    const [n, setN] = useState(0);
    return h("button", { onClick: () => { setN((x) => x + 1); setN((x) => x + 1); } }, `clicked ${n}`);
  };
  const root = container();
  render(h(Counter, null), root);
  const button = root.querySelector("button")!;
  button.fire("click");
  assert.equal(root.textContent, "clicked 0", "not yet: updates are applied a moment later");
  await tick();
  assert.equal(root.textContent, "clicked 2");
  assert.equal(renders, 2, "two updates, one render");
  assert.equal(root.querySelector("button"), button);
});

test("setting the same value doesn't re-render", async () => {
  let renders = 0;
  let set!: (v: number) => void;
  const C = () => {
    renders++;
    const [n, setN] = useState(5);
    set = setN;
    return h("p", null, n);
  };
  render(h(C, null), container());
  set(5);
  await tick();
  assert.equal(renders, 1);
});

test("state is kept per component instance, and follows keys when reordered", async () => {
  const sets: Record<string, (v: string) => void> = {};
  const Item = ({ id }: { id: string }) => {
    const [note, setNote] = useState("");
    sets[id] = setNote;
    return h("li", null, `${id}:${note}`);
  };
  const root = container();
  const view = (ids: string[]) => h("ul", null, ids.map((id) => h(Item, { key: id, id })));
  render(view(["a", "b", "c"]), root);
  sets.b("hello");
  await tick();
  render(view(["c", "b", "a"]), root);
  assert.equal(root.textContent, "c:b:helloa:"); // b kept its note after moving
});

test("a parent re-render keeps children's state", async () => {
  let setChild!: (n: number) => void;
  let setParent!: (s: string) => void;
  const Child = () => {
    const [n, setN] = useState(1);
    setChild = setN;
    return h("b", null, n);
  };
  const Parent = () => {
    const [label, setLabel] = useState("x");
    setParent = setLabel;
    return h("div", null, label, h(Child, null));
  };
  const root = container();
  render(h(Parent, null), root);
  setChild(7);
  await tick();
  setParent("y");
  await tick();
  assert.equal(html(root), "<div>y<b>7</b></div>");
});

test("useEffect runs after rendering, again when deps change, and cleans up", async () => {
  const log: string[] = [];
  let setN!: (n: number) => void;
  let setOther!: (s: string) => void;
  const C = () => {
    const [n, sn] = useState(0);
    const [other, so] = useState("a");
    setN = sn;
    setOther = so;
    useEffect(() => {
      log.push(`run ${n}`);
      return () => log.push(`cleanup ${n}`);
    }, [n]);
    useEffect(() => {
      log.push("mount only");
    }, []);
    return h("p", null, `${n}${other}`);
  };
  const root = container();
  render(h(C, null), root);
  assert.deepEqual(log, ["run 0", "mount only"]);
  setOther("b"); // n didn't change: no effect
  await tick();
  assert.deepEqual(log, ["run 0", "mount only"]);
  setN(1);
  await tick();
  assert.deepEqual(log, ["run 0", "mount only", "cleanup 0", "run 1"]);
  unmountRoot(root);
  assert.deepEqual(log.slice(-1), ["cleanup 1"]);
});

test("effects can read the DOM they rendered", () => {
  let seen = "";
  const C = () => {
    const ref = useRef<FakeElement | null>(null);
    useEffect(() => {
      seen = ref.current!.textContent;
    });
    return h("p", { ref }, "rendered");
  };
  render(h(C, null), container());
  assert.equal(seen, "rendered");
});

test("unmounting a component runs its cleanups, and late updates are ignored", async () => {
  const log: string[] = [];
  let set!: (n: number) => void;
  const Timer = () => {
    const [n, setN] = useState(0);
    set = setN;
    useEffect(() => () => log.push("stopped"), []);
    return h("span", null, n);
  };
  const root = container();
  render(h("div", null, h(Timer, null)), root);
  render(h("div", null, "gone"), root);
  assert.deepEqual(log, ["stopped"]);
  set(99); // e.g. a timer firing after unmount
  await tick();
  assert.equal(html(root), "<div>gone</div>");
});

test("useMemo and useCallback recompute only when deps change", async () => {
  let computed = 0;
  let set!: (s: { q: string; other: number }) => void;
  const callbacks = new Set<unknown>();
  const C = () => {
    const [state, setState] = useState({ q: "a", other: 0 });
    set = setState;
    const upper = useMemo(() => {
      computed++;
      return state.q.toUpperCase();
    }, [state.q]);
    callbacks.add(useCallback(() => state.q, [state.q]));
    return h("p", null, upper);
  };
  const root = container();
  render(h(C, null), root);
  set({ q: "a", other: 1 });
  await tick();
  assert.equal(computed, 1);
  assert.equal(callbacks.size, 1);
  set({ q: "b", other: 1 });
  await tick();
  assert.equal(computed, 2);
  assert.equal(callbacks.size, 2);
  assert.equal(root.textContent, "B");
});

test("useRef keeps a value across renders without re-rendering", async () => {
  let set!: (n: number) => void;
  let renders = 0;
  const C = () => {
    renders++;
    const count = useRef(0);
    count.current++;
    const [, setN] = useState(0);
    set = setN;
    return h("p", null, count.current);
  };
  const root = container();
  render(h(C, null), root);
  set(1);
  await tick();
  assert.equal(root.textContent, "2");
  assert.equal(renders, 2);
});

test("useReducer", async () => {
  type Action = { type: "add"; text: string } | { type: "clear" };
  let dispatch!: (a: Action) => void;
  const Todos = () => {
    const [items, d] = useReducer((s: string[], a: Action) => (a.type === "add" ? [...s, a.text] : []), []);
    dispatch = d;
    return h("ul", null, items.map((t) => h("li", { key: t }, t)));
  };
  const root = container();
  render(h(Todos, null), root);
  dispatch({ type: "add", text: "milk" });
  dispatch({ type: "add", text: "eggs" });
  await tick();
  assert.equal(html(root), "<ul><li>milk</li><li>eggs</li></ul>");
  dispatch({ type: "clear" });
  flush(); // apply right away instead of waiting
  assert.equal(html(root), "<ul></ul>");
});

test("a controlled input", async () => {
  const Form = () => {
    const [text, setText] = useState("");
    return h("div", null,
      h("input", { value: text, onInput: (e: any) => setText(e.target.value.toUpperCase()) }),
      h("p", null, `${text.length} chars`));
  };
  const root = container();
  render(h(Form, null), root);
  const input = root.querySelector("input")!;
  input.value = "abc";
  input.fire("input");
  await tick();
  assert.equal(input.value, "ABC");
  assert.equal(root.querySelector("p")!.textContent, "3 chars");
});

test("hooks outside a component are an error", () => {
  assert.throws(() => useState(0), /inside a component/);
});

test("an update inside an effect is applied", async () => {
  const C = () => {
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
      setLoaded(true);
    }, []);
    return h("p", null, loaded ? "ready" : "loading");
  };
  const root = container();
  render(h(C, null), root);
  assert.equal(root.textContent, "loading");
  await tick();
  assert.equal(root.textContent, "ready");
});
