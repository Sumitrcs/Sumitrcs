// Built from src/demo.ts by build.mjs. Edit the .ts file, not this one.
// The demo page, built with tinyui itself.
import { h, render, useEffect, useMemo, useRef, useState } from "./tinyui.js";

// ---- 1. A counter ----------------------------------------------------------

function Counter() {
  const [count, setCount] = useState(0);
  return h("div", { class: "row" },
    h("button", { onClick: () => setCount((c) => c - 1), "aria-label": "minus one" }, "−"),
    h("output", { class: "count" }, count),
    h("button", { onClick: () => setCount((c) => c + 1), "aria-label": "plus one" }, "+"),
    h("button", { class: "link", onClick: () => setCount(0), disabled: count === 0 }, "reset"));
}

// ---- 2. A todo list ----------------------------------------------------------

                
             
               
                
 

const STORAGE_KEY = "tinyui-demo-todos";

function loadTodos()         {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (Array.isArray(saved)) return saved;
  } catch {
    // storage unavailable or corrupted: start fresh
  }
  return [
    { id: 1, text: "Read how keyed diffing works", done: true },
    { id: 2, text: "Build a component with useState", done: false },
    { id: 3, text: "Write my own hook", done: false },
  ];
}

                                        

function Todos() {
  const [todos, setTodos] = useState(loadTodos);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState        ("all");
  const input = useRef                         (null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
    } catch {
      // private mode: the list just won't be remembered
    }
  }, [todos]);

  const visible = useMemo(
    () => todos.filter((t) => filter === "all" || (filter === "done") === t.done),
    [todos, filter],
  );
  const left = todos.filter((t) => !t.done).length;

  const add = (e       ) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setTodos((ts) => [...ts, { id: Date.now(), text, done: false }]);
    setDraft("");
    input.current?.focus();
  };
  const toggle = (id        ) => setTodos((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const remove = (id        ) => setTodos((ts) => ts.filter((t) => t.id !== id));

  return h("div", null,
    h("form", { class: "row", onSubmit: add },
      h("input", {
        ref: input, value: draft, placeholder: "What needs doing?", "aria-label": "New todo",
        onInput: (e       ) => setDraft((e.target                    ).value),
      }),
      h("button", { type: "submit", disabled: !draft.trim() }, "Add")),
    h("ul", { class: "todos" },
      visible.map((t) => h("li", { key: t.id, class: t.done ? "done" : "" },
        h("label", null,
          h("input", { type: "checkbox", checked: t.done, onChange: () => toggle(t.id) }),
          h("span", null, t.text)),
        h("button", { class: "link", onClick: () => remove(t.id), "aria-label": `Delete ${t.text}` }, "✕"))),
      visible.length === 0 && h("li", { class: "empty" }, "Nothing here.")),
    h("div", { class: "row small" },
      h("span", null, `${left} left`),
      (["all", "active", "done"]            ).map((f) =>
        h("button", { key: f, class: f === filter ? "chip on" : "chip", onClick: () => setFilter(f) }, f)),
      todos.some((t) => t.done) &&
        h("button", { class: "link", onClick: () => setTodos((ts) => ts.filter((t) => !t.done)) }, "clear done")));
}

// ---- 3. The keyed list lab -------------------------------------------------------
//
// A MutationObserver watches the real <ol> and counts how many nodes the
// last update inserted. Moving a node counts as one insert.

function KeyedLab() {
  const [items, setItems] = useState(() => Array.from({ length: 8 }, (_, i) => i + 1));
  const [useKeys, setUseKeys] = useState(true);
  const [inserted, setInserted] = useState               (null);
  const [next, setNext] = useState(9);
  const list = useRef                         (null);

  useEffect(() => {
    const observer = new MutationObserver((records) => {
      let n = 0;
      for (const r of records) if (r.target === list.current) n += r.addedNodes.length;
      if (n > 0 || records.some((r) => r.target !== list.current)) setInserted(n);
    });
    observer.observe(list.current , { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  const shuffle = () => setItems((xs) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  });
  const actions                         = [
    ["Last to first", () => setItems((xs) => [xs[xs.length - 1], ...xs.slice(0, -1)])],
    ["Swap 2 and 7", () => setItems((xs) => xs.length > 6 ? xs.map((x, i) => (i === 1 ? xs[6] : i === 6 ? xs[1] : x)) : xs)],
    ["Reverse", () => setItems((xs) => [...xs].reverse())],
    ["Shuffle", shuffle],
    ["Add", () => { setItems((xs) => [...xs, next]); setNext((n) => n + 1); }],
    ["Remove first", () => setItems((xs) => xs.slice(1))],
  ];

  return h("div", null,
    h("div", { class: "row wrap" }, actions.map(([label, fn]) => h("button", { key: label, onClick: fn }, label))),
    h("label", { class: "row small" },
      h("input", { type: "checkbox", checked: useKeys, onChange: () => setUseKeys((k) => !k) }),
      h("span", null, "use keys")),
    h("ol", { class: "chips", ref: list },
      items.map((n) => h("li", { key: useKeys ? n : undefined, style: { "--hue": (n * 47) % 360 } }, n))),
    h("p", { class: "small", "aria-live": "polite" },
      inserted === null ? "Click a button to see how many DOM nodes each update moves."
        : `The last update inserted or moved ${inserted} <li> node${inserted === 1 ? "" : "s"}` +
          (useKeys ? "." : ". Without keys, items are matched by position, so the text changes instead.")));
}

function App() {
  return h("main", null,
    h("header", null,
      h("h1", null, "tinyui"),
      h("p", null, "A React-style UI library in about 450 lines of TypeScript: virtual DOM, keyed diffing, hooks. Everything on this page is rendered by it."),
      h("a", { href: "https://github.com/Sumitrcs/tinyui" }, "Source code and walkthrough →")),
    h("section", { class: "card" }, h("h2", null, "1. State"), h("p", { class: "small" }, "useState: each click re-renders only this component."), h(Counter, null)),
    h("section", { class: "card" }, h("h2", null, "2. A todo app"), h("p", { class: "small" }, "useState, useEffect (saving to localStorage), useMemo, useRef and a controlled input."), h(Todos, null)),
    h("section", { class: "card" }, h("h2", null, "3. Keyed diffing lab"), h("p", { class: "small" }, "Reorder the list and watch how few DOM nodes move: tinyui keeps the longest run of items already in order still."), h(KeyedLab, null)));
}

render(h(App, null), document.getElementById("app") );
