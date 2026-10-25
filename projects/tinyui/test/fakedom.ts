// A tiny stand-in for the browser DOM, enough for tinyui's tests to run in
// Node. It also counts DOM operations, so tests can check that an update
// did the minimum amount of work.

export const ops = { created: 0, inserted: 0, removed: 0, attrs: 0, text: 0 };

export function resetOps(): void {
  for (const k of Object.keys(ops) as (keyof typeof ops)[]) ops[k] = 0;
}

export class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  nodeType: number;
  private _value: string | null = null;
  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  get nodeValue() {
    return this._value;
  }
  set nodeValue(v: string | null) {
    ops.text++;
    this._value = v;
  }
  get nextSibling(): FakeNode | null {
    const sibs = this.parentNode?.childNodes;
    return sibs ? (sibs[sibs.indexOf(this) + 1] ?? null) : null;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    if (this.nodeType === 3) return this._value ?? "";
    if (this.nodeType === 8) return "";
    return this.childNodes.map((c) => c.textContent).join("");
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    if (node.parentNode) node.parentNode.detach(node);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (i < 0) throw new Error("insertBefore: reference node is not a child");
    this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    ops.inserted++;
    return node;
  }
  appendChild(node: FakeNode): FakeNode {
    return this.insertBefore(node, null);
  }
  removeChild(node: FakeNode): FakeNode {
    if (node.parentNode !== this) throw new Error("removeChild: not a child");
    this.detach(node);
    ops.removed++;
    return node;
  }
  private detach(node: FakeNode): void {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
  }
  initValue(v: string): this {
    this._value = v;
    return this;
  }
}

export class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(e: any) => void>>();
  styles = new Map<string, string>();
  value = "";
  checked = false;
  style = {
    setProperty: (name: string, v: string) => {
      ops.attrs++;
      if (v === "") this.styles.delete(name);
      else this.styles.set(name, v);
    },
  };
  tagName: string;
  constructor(tagName: string) {
    super(1);
    this.tagName = tagName;
  }
  setAttribute(name: string, v: string): void {
    ops.attrs++;
    this.attributes.set(name, v);
  }
  removeAttribute(name: string): void {
    ops.attrs++;
    this.attributes.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, fn: (e: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** Fires an event the way a browser would call listeners (this = the element). */
  fire(type: string, extra: Record<string, unknown> = {}): void {
    const event = { type, target: this, ...extra };
    for (const fn of this.listeners.get(type) ?? []) fn.call(this, event);
  }
  querySelector(tag: string): FakeElement | null {
    return this.querySelectorAll(tag)[0] ?? null;
  }
  querySelectorAll(tag: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) {
          if (c.tagName === tag) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

/** Serializes a subtree as HTML (comment placeholders are left out). */
export function html(node: FakeNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType === 8) return "";
  const el = node as FakeElement;
  const inner = el.childNodes.map(html).join("");
  if (el.tagName === "#root") return inner;
  const attrs = [...el.attributes].map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v}"`)).join("");
  const style = el.styles.size ? ` style="${[...el.styles].map(([k, v]) => `${k}: ${v}`).join("; ")}"` : "";
  return `<${el.tagName}${attrs}${style}>${inner}</${el.tagName}>`;
}

export const fakeDocument = {
  createElement(tag: string) {
    ops.created++;
    return new FakeElement(tag);
  },
  createTextNode(text: string) {
    ops.created++;
    return new FakeNode(3).initValue(text);
  },
  createComment(text: string) {
    ops.created++;
    return new FakeNode(8).initValue(text);
  },
};

(globalThis as any).document = fakeDocument;

export function container(): FakeElement {
  return new FakeElement("#root");
}
