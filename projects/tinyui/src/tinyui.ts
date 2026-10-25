// tinyui: a small React-style UI library, written to be read.
//
// You describe what the screen should look like as a tree of plain objects
// (the "virtual DOM"). When state changes, the tree is built again and
// compared with the previous one, and only the differences are applied to
// the real DOM:
//
//   h("ul", null, items.map((it) => h("li", { key: it.id }, it.text)))
//
//   render ─► components return vnodes ─► reconcile with the last tree
//          ─► create / update / move / remove real DOM nodes ─► run effects

export type Key = string | number;
export type Props = Record<string, any> & { key?: Key; children?: Child[] };
export type Component<P = any> = (props: P & { children: VNode[] }) => Child;
export type Child = VNode | string | number | boolean | null | undefined | Child[];

export const Fragment = Symbol("Fragment");
const TEXT = Symbol("text");
const EMPTY = Symbol("empty"); // a component that rendered nothing

export interface VNode {
  type: string | Component | typeof Fragment | typeof TEXT | typeof EMPTY;
  props: Props;
  key: Key | null;
  children: VNode[];
  text?: string;
}

/** Creates a virtual DOM node: h("div", { class: "box" }, "Hello"). */
export function h(type: VNode["type"], props?: Props | null, ...children: Child[]): VNode {
  const { key = null, ...rest } = props ?? {};
  return { type, props: rest, key, children: normalize(children) };
}

// Flattens nested arrays and turns strings and numbers into text nodes.
// null, undefined, true and false render nothing, so `cond && h(...)` works.
function normalize(children: Child[], out: VNode[] = []): VNode[] {
  for (const c of children) {
    if (Array.isArray(c)) normalize(c, out);
    else if (c === null || c === undefined || typeof c === "boolean") continue;
    else if (typeof c === "object") out.push(c);
    else out.push({ type: TEXT, props: {}, key: null, children: [], text: String(c) });
  }
  return out;
}

// ---- instances: what is mounted right now -----------------------------
//
// Every vnode that is on screen has an Instance remembering its DOM node(s),
// its children and, for components, its hooks. An instance always owns at
// least one DOM node (an empty comment stands in for "nothing"), which
// makes it easy to know where it is in its parent.

interface Instance {
  vnode: VNode;
  dom: Node | null;        // for elements, text and placeholders
  kids: Instance[];        // children (elements, fragments) or the rendered child (components)
  hooks: Hook[];
  parent: Instance | null; // the enclosing component, for scheduling
  mounted: boolean;
  depth: number;
}

type Hook =
  | { kind: "state"; value: any; setter: (v: any) => void }
  | { kind: "effect"; deps?: unknown[]; cleanup?: (() => void) | void; pending?: () => (() => void) | void }
  | { kind: "memo"; deps: unknown[]; value: any }
  | { kind: "ref"; value: { current: any } };

function firstNode(inst: Instance): Node {
  return inst.dom ?? firstNode(inst.kids[0]);
}

function lastNode(inst: Instance): Node {
  return inst.dom ?? lastNode(inst.kids[inst.kids.length - 1]);
}

/** All of an instance's top-level DOM nodes, in order. */
function domNodes(inst: Instance, out: Node[] = []): Node[] {
  if (inst.dom) out.push(inst.dom);
  else for (const k of inst.kids) domNodes(k, out);
  return out;
}

// ---- mounting: vnode → new DOM ------------------------------------------
//
// Mounting builds the DOM for a subtree without inserting its top level
// into the page; the caller places it (see placeChildren). Children of an
// element are appended to that element right away.

let currentComponent: Instance | null = null;
let hookIndex = 0;
const pendingEffects: Instance[] = [];

function mount(vnode: VNode, owner: Instance | null, depth: number): Instance {
  const inst: Instance = { vnode, dom: null, kids: [], hooks: [], parent: owner, mounted: true, depth };
  const { type } = vnode;
  if (type === TEXT) {
    inst.dom = document.createTextNode(vnode.text!);
  } else if (type === EMPTY) {
    inst.dom = document.createComment("");
  } else if (type === Fragment) {
    inst.kids = vnode.children.length ? vnode.children.map((c) => mount(c, owner, depth + 1)) : [mount(empty(), owner, depth + 1)];
  } else if (typeof type === "function") {
    inst.kids = [mount(renderComponent(inst), inst, depth + 1)];
  } else {
    const el = document.createElement(type as string);
    inst.dom = el;
    setProps(el as HTMLElement, {}, vnode.props);
    for (const c of vnode.children) {
      const kid = mount(c, owner, depth + 1);
      inst.kids.push(kid);
      for (const n of domNodes(kid)) el.appendChild(n);
    }
    if (vnode.props.ref) vnode.props.ref.current = el;
  }
  return inst;
}

function empty(): VNode {
  return { type: EMPTY, props: {}, key: null, children: [] };
}

// Calls a function component with hooks pointing at its instance.
function renderComponent(inst: Instance): VNode {
  const prev = currentComponent;
  const prevIndex = hookIndex;
  currentComponent = inst;
  hookIndex = 0;
  try {
    const fn = inst.vnode.type as Component;
    const out = normalize([fn({ ...inst.vnode.props, children: inst.vnode.children })]);
    // A component returns one node; several are wrapped in a fragment.
    if (out.length === 0) return empty();
    return out.length === 1 ? out[0] : { type: Fragment, props: {}, key: null, children: out };
  } finally {
    currentComponent = prev;
    hookIndex = prevIndex;
    if (inst.hooks.some((hk) => hk.kind === "effect" && hk.pending)) pendingEffects.push(inst);
  }
}

// ---- unmounting -------------------------------------------------------------

function unmount(inst: Instance, removeDom: boolean): void {
  if (removeDom) {
    for (const n of domNodes(inst)) n.parentNode?.removeChild(n);
  }
  inst.mounted = false;
  for (const k of inst.kids) unmount(k, false);
  for (const hk of inst.hooks) {
    if (hk.kind === "effect" && typeof hk.cleanup === "function") hk.cleanup();
  }
  if (inst.vnode.props.ref && inst.dom) inst.vnode.props.ref.current = null;
}

// ---- patching: old instance + new vnode → updated instance --------------------

function sameKind(a: VNode, b: VNode): boolean {
  return a.type === b.type && a.key === b.key;
}

// Updates `inst` in place to match `vnode` (which has the same type and key).
function patch(parent: Node, inst: Instance, vnode: VNode): Instance {
  const old = inst.vnode;
  inst.vnode = vnode;
  if (vnode.type === TEXT) {
    if (old.text !== vnode.text) inst.dom!.nodeValue = vnode.text!;
  } else if (vnode.type === EMPTY) {
    // nothing to do
  } else if (vnode.type === Fragment) {
    const kids = vnode.children.length ? vnode.children : [empty()];
    inst.kids = reconcileChildren(parent, inst.kids, kids, lastNode(inst).nextSibling, inst.parent, inst.depth + 1);
  } else if (typeof vnode.type === "function") {
    rerender(inst);
  } else {
    const el = inst.dom as HTMLElement;
    setProps(el, old.props, vnode.props);
    inst.kids = reconcileChildren(el, inst.kids, vnode.children, null, inst.parent, inst.depth + 1);
    if (vnode.props.ref) vnode.props.ref.current = el;
  }
  return inst;
}

function rerender(inst: Instance): void {
  const child = renderComponent(inst);
  const parent = firstNode(inst).parentNode!;
  inst.kids = reconcileChildren(parent, inst.kids, [child], lastNode(inst).nextSibling, inst, inst.depth + 1);
}

// Reconciles a list of children: reuse what matches (same key, or same
// position when there are no keys), mount what's new, remove what's gone,
// and finally put the DOM nodes in the right order with as few moves as
// possible. `anchor` is the DOM node right after the list (null = the end).
function reconcileChildren(
  parent: Node, oldKids: Instance[], vnodes: VNode[], anchor: Node | null, owner: Instance | null, depth: number,
): Instance[] {
  const keyOf = (v: VNode, i: number) => (v.key !== null ? "k:" + v.key : "i:" + i);
  const oldByKey = new Map<string, number>();
  let unkeyed = 0;
  oldKids.forEach((k, i) => oldByKey.set(keyOf(k.vnode, k.vnode.key !== null ? i : unkeyed++), i));

  const used = new Array<boolean>(oldKids.length).fill(false);
  const oldIndex: number[] = []; // for each new child: the old position it came from, or -1
  const next: Instance[] = [];
  unkeyed = 0;
  for (const v of vnodes) {
    const i = oldByKey.get(keyOf(v, v.key !== null ? 0 : unkeyed++));
    if (i !== undefined && !used[i] && sameKind(oldKids[i].vnode, v)) {
      used[i] = true;
      oldIndex.push(i);
      next.push(patch(parent, oldKids[i], v));
    } else {
      oldIndex.push(-1);
      next.push(mount(v, owner, depth));
    }
  }
  oldKids.forEach((k, i) => used[i] || unmount(k, true));
  placeChildren(parent, next, oldIndex, anchor);
  return next;
}

// Puts the children's DOM nodes in order. Children that came from old
// positions forming an increasing sequence are already in the right
// relative order; keeping the *longest* such sequence still and moving
// only the rest gives the fewest moves (the same idea as Vue and Inferno).
//   old: a b c d   new: d a b c   → a b c stay, only d moves.
function placeChildren(parent: Node, kids: Instance[], oldIndex: number[], anchor: Node | null): void {
  const stay = new Set(longestIncreasing(oldIndex));
  for (let i = kids.length - 1; i >= 0; i--) {
    const nodes = domNodes(kids[i]);
    if (oldIndex[i] === -1 || !stay.has(i)) {
      for (const n of nodes) parent.insertBefore(n, anchor);
    }
    anchor = nodes[0];
  }
}

/** Positions (into seq) of a longest strictly increasing subsequence, ignoring -1s. O(n log n). */
export function longestIncreasing(seq: number[]): number[] {
  const tails: number[] = []; // tails[k] = index in seq of the smallest tail of an increasing run of length k+1
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i];
    if (v < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i !== -1; i = prev[i]) out.push(i);
  return out.reverse();
}

// ---- properties and events ------------------------------------------------------

// Event handlers are stored on the element and called through one listener
// per event type, so changing a handler never means removing and adding a
// listener.
type WithHandlers = HTMLElement & { __handlers?: Record<string, (e: Event) => void> };

function dispatch(this: WithHandlers, e: Event) {
  this.__handlers?.[e.type]?.(e);
}

function setProps(el: WithHandlers, old: Props, next: Props): void {
  for (const name of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (name === "children" || name === "ref") continue;
    const a = old[name];
    const b = next[name];
    if (a === b && name !== "value" && name !== "checked") continue;
    if (name.startsWith("on") && name.length > 2) {
      const type = name.slice(2).toLowerCase();
      el.__handlers ??= {};
      if (b) {
        if (!el.__handlers[type]) el.addEventListener(type, dispatch);
        el.__handlers[type] = b;
      } else if (el.__handlers[type]) {
        el.removeEventListener(type, dispatch);
        delete el.__handlers[type];
      }
    } else if (name === "style") {
      setStyle(el, a ?? {}, b ?? {});
    } else if (name === "value" || name === "checked") {
      // Properties, not attributes: the attribute is only the initial value.
      // Compared with the live element, so typing doesn't get overwritten
      // unless the state really says something else.
      if ((el as any)[name] !== b) (el as any)[name] = b ?? (name === "value" ? "" : false);
    } else {
      const attr = name === "className" ? "class" : name;
      if (b === false || b === null || b === undefined) el.removeAttribute(attr);
      else el.setAttribute(attr, b === true ? "" : String(b));
    }
  }
}

// Numbers get "px" ({ width: 40 } → 40px), except for properties that
// have no unit and for custom properties like --hue.
const UNITLESS = new Set(["opacity", "zIndex", "fontWeight", "lineHeight", "flex", "flexGrow", "flexShrink", "order", "zoom"]);

function setStyle(el: HTMLElement, a: Record<string, string | number>, b: Record<string, string | number>): void {
  for (const p of Object.keys(a)) if (!(p in b)) el.style.setProperty(cssName(p), "");
  for (const [p, v] of Object.entries(b)) {
    if (a[p] === v) continue;
    const px = typeof v === "number" && v !== 0 && !UNITLESS.has(p) && !p.startsWith("--");
    el.style.setProperty(cssName(p), px ? `${v}px` : String(v));
  }
}

function cssName(p: string): string {
  return p.startsWith("--") ? p : p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

// ---- rendering and scheduling -------------------------------------------------

const roots = new WeakMap<Node, Instance>();

/** Renders a vnode into a container, updating what is already there. */
export function render(vnode: Child, container: Node): void {
  const [v] = normalize([vnode]);
  const old = roots.get(container);
  const kids = reconcileChildren(container, old ? [old] : [], [v ?? empty()], null, null, 0);
  roots.set(container, kids[0]);
  runEffects();
}

/** Removes everything rendered into a container, running effect cleanups. */
export function unmountRoot(container: Node): void {
  const old = roots.get(container);
  if (old) unmount(old, true);
  roots.delete(container);
}

// setState doesn't re-render at once: several updates in the same event
// handler are batched into one render, a moment later (a microtask).
const dirty = new Set<Instance>();
let scheduled = false;

function schedule(inst: Instance): void {
  dirty.add(inst);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

/** Applies pending state updates now (normally this happens automatically). */
export function flush(): void {
  scheduled = false;
  // Parents first: re-rendering a parent re-renders its children anyway.
  const list = [...dirty].sort((a, b) => a.depth - b.depth);
  dirty.clear();
  for (const inst of list) {
    if (inst.mounted) rerender(inst);
  }
  runEffects();
}

function runEffects(): void {
  while (pendingEffects.length) {
    const inst = pendingEffects.shift()!;
    for (const hk of inst.hooks) {
      if (hk.kind !== "effect" || !hk.pending) continue;
      const run = hk.pending;
      hk.pending = undefined;
      if (!inst.mounted) continue;
      if (typeof hk.cleanup === "function") hk.cleanup();
      hk.cleanup = run();
    }
  }
}

// ---- hooks ---------------------------------------------------------------------
//
// Hooks are stored in an array on the component's instance, in call order.
// That's why they must be called in the same order on every render: the
// third useState call always finds the third slot.

function hookSlot<T extends Hook>(init: () => T): T {
  const inst = currentComponent;
  if (!inst) throw new Error("hooks can only be called inside a component");
  const i = hookIndex++;
  if (i >= inst.hooks.length) inst.hooks.push(init());
  return inst.hooks[i] as T;
}

export function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
  const inst = currentComponent!;
  const hook = hookSlot(() => {
    const h: Hook & { kind: "state" } = {
      kind: "state",
      value: typeof initial === "function" ? (initial as () => T)() : initial,
      setter: (next: any) => {
        const value = typeof next === "function" ? next(h.value) : next;
        if (Object.is(value, h.value)) return; // no change, no render
        h.value = value;
        if (inst.mounted) schedule(inst);
      },
    };
    return h;
  });
  return [hook.value, hook.setter];
}

export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void] {
  const [state, setState] = useState(initial);
  const dispatchAction = useMemo(() => (action: A) => setState((s) => reducer(s, action)), []);
  return [state, dispatchAction];
}

function depsChanged(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  return !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
}

/** Runs fn after rendering, again whenever deps change; fn may return a cleanup. */
export function useEffect(fn: () => (() => void) | void, deps?: unknown[]): void {
  const hook = hookSlot<Hook & { kind: "effect" }>(() => ({ kind: "effect", deps: undefined, pending: fn }));
  if (hook.pending === fn) {
    hook.deps = deps; // first render
  } else if (depsChanged(hook.deps, deps)) {
    hook.deps = deps;
    hook.pending = fn;
  }
}

export function useMemo<T>(compute: () => T, deps: unknown[]): T {
  const hook = hookSlot<Hook & { kind: "memo" }>(() => ({ kind: "memo", deps, value: compute() }));
  if (depsChanged(hook.deps, deps)) {
    hook.deps = deps;
    hook.value = compute();
  }
  return hook.value;
}

export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: unknown[]): T {
  return useMemo(() => fn, deps);
}

export function useRef<T>(initial: T): { current: T } {
  return hookSlot<Hook & { kind: "ref" }>(() => ({ kind: "ref", value: { current: initial } })).value;
}
