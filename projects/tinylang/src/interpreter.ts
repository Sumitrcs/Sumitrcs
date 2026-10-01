import type { Expr, Pos, Stmt } from "./ast.ts";
import { parse } from "./parser.ts";

export type Value = number | string | boolean | null | Value[] | MapValue | Closure | Builtin;

export class MapValue {
  entries = new Map<string, Value>();
}

export class Closure {
  name: string;
  params: string[];
  body: Stmt[];
  env: Env;
  constructor(name: string, params: string[], body: Stmt[], env: Env) {
    this.name = name;
    this.params = params;
    this.body = body;
    this.env = env;
  }
}

export class Builtin {
  name: string;
  arity: number | null;
  fn: (args: Value[], interp: Interpreter, pos: Pos) => Value;
  constructor(name: string, arity: number | null, fn: (args: Value[], interp: Interpreter, pos: Pos) => Value) {
    this.name = name;
    this.arity = arity;
    this.fn = fn;
  }
}

export class RuntimeError extends Error {
  pos: Pos;
  constructor(message: string, pos: Pos) {
    super(`${message} at ${pos.line}:${pos.col}`);
    this.pos = pos;
  }
}

export class Env {
  vars = new Map<string, Value>();
  parent: Env | null;
  constructor(parent: Env | null = null) {
    this.parent = parent;
  }
  define(name: string, v: Value) {
    this.vars.set(name, v);
  }
  lookup(name: string, pos: Pos): Value {
    for (let e: Env | null = this; e; e = e.parent) {
      if (e.vars.has(name)) return e.vars.get(name)!;
    }
    throw new RuntimeError(`Undefined variable '${name}'`, pos);
  }
  assign(name: string, v: Value, pos: Pos) {
    for (let e: Env | null = this; e; e = e.parent) {
      if (e.vars.has(name)) {
        e.vars.set(name, v);
        return;
      }
    }
    throw new RuntimeError(`Assignment to undeclared variable '${name}' (use let)`, pos);
  }
}

// Control flow is implemented with exceptions that never escape the interpreter.
class ReturnSignal {
  value: Value;
  constructor(value: Value) {
    this.value = value;
  }
}
class BreakSignal {}
class ContinueSignal {}

const MAX_DEPTH = 500;

export function typeOf(v: Value): string {
  if (v === null) return "nil";
  if (Array.isArray(v)) return "array";
  if (v instanceof MapValue) return "map";
  if (v instanceof Closure || v instanceof Builtin) return "function";
  return typeof v;
}

export function show(v: Value, nested = false): string {
  if (v === null) return "nil";
  if (typeof v === "string") return nested ? JSON.stringify(v) : v;
  if (Array.isArray(v)) return "[" + v.map((x) => show(x, true)).join(", ") + "]";
  if (v instanceof MapValue) {
    return "{" + [...v.entries].map(([k, x]) => `${k}: ${show(x, true)}`).join(", ") + "}";
  }
  if (v instanceof Closure) return `<fn ${v.name}>`;
  if (v instanceof Builtin) return `<builtin ${v.name}>`;
  return String(v);
}

export function truthy(v: Value): boolean {
  return v !== null && v !== false;
}

function equal(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  return a === b;
}

export class Interpreter {
  globals = new Env();
  output: string[] = [];
  depth = 0;
  /** Where print() goes; defaults to collecting into `output`. */
  write: (s: string) => void;

  constructor(write?: (s: string) => void) {
    this.write = write ?? ((s) => this.output.push(s));
    installBuiltins(this);
  }

  run(src: string): Value {
    let last: Value = null;
    try {
      for (const s of parse(src)) last = this.exec(s, this.globals);
    } catch (e) {
      // Deeply nested expressions can exhaust the host stack before MAX_DEPTH.
      if (e instanceof RangeError && /call stack/.test(e.message)) {
        this.depth = 0;
        throw new RuntimeError("Stack overflow (recursion too deep)", { line: 0, col: 0 });
      }
      throw e;
    }
    return last;
  }

  execBlock(stmts: Stmt[], env: Env): Value {
    let last: Value = null;
    for (const s of stmts) last = this.exec(s, env);
    return last;
  }

  exec(s: Stmt, env: Env): Value {
    switch (s.kind) {
      case "Let": {
        const v = this.eval(s.value, env);
        if (v instanceof Closure && v.name === "anonymous") v.name = s.name;
        env.define(s.name, v);
        return null;
      }
      case "Expr":
        return this.eval(s.expr, env);
      case "Return":
        throw new ReturnSignal(s.value ? this.eval(s.value, env) : null);
      case "Break":
        throw new BreakSignal();
      case "Continue":
        throw new ContinueSignal();
      case "While":
        while (truthy(this.eval(s.cond, env))) {
          if (this.loopBody(s.body, new Env(env))) break;
        }
        return null;
      case "For": {
        const it = this.eval(s.iterable, env);
        const items: Value[] = Array.isArray(it)
          ? [...it]
          : it instanceof MapValue
            ? [...it.entries.keys()]
            : typeof it === "string"
              ? [...it]
              : this.fail(`Cannot iterate over ${typeOf(it)}`, s.pos);
        for (const item of items) {
          const scope = new Env(env);
          scope.define(s.name, item);
          if (this.loopBody(s.body, scope)) break;
        }
        return null;
      }
    }
  }

  /** Runs a loop body; returns true if the loop should stop. */
  loopBody(body: Stmt[], env: Env): boolean {
    try {
      this.execBlock(body, env);
    } catch (e) {
      if (e instanceof BreakSignal) return true;
      if (e instanceof ContinueSignal) return false;
      throw e;
    }
    return false;
  }

  fail(msg: string, pos: Pos): never {
    throw new RuntimeError(msg, pos);
  }

  eval(e: Expr, env: Env): Value {
    switch (e.kind) {
      case "Number":
        return e.value;
      case "Bool":
        return e.value;
      case "Nil":
        return null;
      case "String":
        return e.parts.map((p) => (typeof p === "string" ? p : show(this.eval(p, env)))).join("");
      case "Ident":
        return env.lookup(e.name, e.pos);
      case "Array":
        return e.items.map((x) => this.eval(x, env));
      case "Map": {
        const m = new MapValue();
        for (const [k, v] of e.entries) m.entries.set(this.key(this.eval(k, env), k.pos), this.eval(v, env));
        return m;
      }
      case "Fn": {
        const c = new Closure(e.name ?? "anonymous", e.params, e.body, env);
        return c;
      }
      case "Range": {
        const from = this.num(this.eval(e.from, env), e.pos);
        const to = this.num(this.eval(e.to, env), e.pos);
        const out: Value[] = [];
        for (let i = from; i < to; i++) out.push(i);
        return out;
      }
      case "If": {
        const scope = new Env(env);
        if (truthy(this.eval(e.cond, env))) return this.execBlock(e.then, scope);
        return e.otherwise ? this.execBlock(e.otherwise, scope) : null;
      }
      case "Unary": {
        const v = this.eval(e.operand, env);
        return e.op === "!" ? !truthy(v) : -this.num(v, e.pos);
      }
      case "Logical": {
        const l = this.eval(e.left, env);
        if (e.op === "or") return truthy(l) ? l : this.eval(e.right, env);
        return truthy(l) ? this.eval(e.right, env) : l;
      }
      case "Binary":
        return this.binary(e.op, this.eval(e.left, env), this.eval(e.right, env), e.pos);
      case "Assign": {
        const v = this.eval(e.value, env);
        if (e.target.kind === "Ident") env.assign(e.target.name, v, e.pos);
        else if (e.target.kind === "Index") {
          const obj = this.eval(e.target.object, env);
          const idx = this.eval(e.target.index, env);
          if (Array.isArray(obj)) obj[this.arrayIndex(obj, idx, e.pos)] = v;
          else if (obj instanceof MapValue) obj.entries.set(this.key(idx, e.pos), v);
          else this.fail(`Cannot assign into ${typeOf(obj)}`, e.pos);
        }
        return v;
      }
      case "Index": {
        const obj = this.eval(e.object, env);
        const idx = this.eval(e.index, env);
        if (Array.isArray(obj)) return obj[this.arrayIndex(obj, idx, e.pos)];
        if (typeof obj === "string") return obj[this.arrayIndex([...obj], idx, e.pos)];
        if (obj instanceof MapValue) return obj.entries.get(this.key(idx, e.pos)) ?? null;
        return this.fail(`Cannot index ${typeOf(obj)}`, e.pos);
      }
      case "Call": {
        const callee = this.eval(e.callee, env);
        const args = e.args.map((a) => this.eval(a, env));
        return this.call(callee, args, e.pos);
      }
    }
  }

  call(callee: Value, args: Value[], pos: Pos): Value {
    if (callee instanceof Builtin) {
      if (callee.arity !== null && args.length !== callee.arity) {
        this.fail(`${callee.name}() expects ${callee.arity} argument(s), got ${args.length}`, pos);
      }
      return callee.fn(args, this, pos);
    }
    if (!(callee instanceof Closure)) return this.fail(`${typeOf(callee)} is not callable`, pos);
    if (args.length !== callee.params.length) {
      this.fail(`${callee.name}() expects ${callee.params.length} argument(s), got ${args.length}`, pos);
    }
    if (++this.depth > MAX_DEPTH) {
      this.depth = 0;
      this.fail("Stack overflow (recursion too deep)", pos);
    }
    const scope = new Env(callee.env);
    callee.params.forEach((p, i) => scope.define(p, args[i]));
    try {
      // The value of the last statement is the implicit return value.
      return this.execBlock(callee.body, scope);
    } catch (sig) {
      if (sig instanceof ReturnSignal) return sig.value;
      if (sig instanceof BreakSignal || sig instanceof ContinueSignal) this.fail("break/continue outside loop", pos);
      throw sig;
    } finally {
      this.depth--;
    }
  }

  binary(op: string, l: Value, r: Value, pos: Pos): Value {
    switch (op) {
      case "==":
        return equal(l, r);
      case "!=":
        return !equal(l, r);
      case "+":
        if (typeof l === "string" || typeof r === "string") return show(l) + show(r);
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        return this.num(l, pos) + this.num(r, pos);
      case "-":
        return this.num(l, pos) - this.num(r, pos);
      case "*":
        if (typeof l === "string" && typeof r === "number") return l.repeat(Math.max(0, r));
        return this.num(l, pos) * this.num(r, pos);
      case "/": {
        const d = this.num(r, pos);
        if (d === 0) this.fail("Division by zero", pos);
        return this.num(l, pos) / d;
      }
      case "%": {
        const d = this.num(r, pos);
        if (d === 0) this.fail("Division by zero", pos);
        return this.num(l, pos) % d;
      }
    }
    // Comparisons work on numbers or on strings, but not mixed.
    if (typeof l === "string" && typeof r === "string") {
      return op === "<" ? l < r : op === "<=" ? l <= r : op === ">" ? l > r : l >= r;
    }
    const a = this.num(l, pos);
    const b = this.num(r, pos);
    return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
  }

  num(v: Value, pos: Pos): number {
    if (typeof v !== "number") this.fail(`Expected a number but got ${typeOf(v)}`, pos);
    return v;
  }

  key(v: Value, pos: Pos): string {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return this.fail(`Map keys must be strings, numbers or booleans, not ${typeOf(v)}`, pos);
  }

  arrayIndex(arr: unknown[], idx: Value, pos: Pos): number {
    let i = this.num(idx, pos);
    if (!Number.isInteger(i)) this.fail("Index must be an integer", pos);
    if (i < 0) i += arr.length; // Python-style negative indices
    if (i < 0 || i >= arr.length) this.fail(`Index ${idx} out of range (length ${arr.length})`, pos);
    return i;
  }
}

function installBuiltins(it: Interpreter) {
  const def = (name: string, arity: number | null, fn: Builtin["fn"]) => it.globals.define(name, new Builtin(name, arity, fn));

  def("print", null, (args) => {
    it.write(args.map((a) => show(a)).join(" "));
    return null;
  });
  def("len", 1, ([v], interp, pos) => {
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (v instanceof MapValue) return v.entries.size;
    return interp.fail(`len() of ${typeOf(v)}`, pos);
  });
  def("type", 1, ([v]) => typeOf(v));
  def("str", 1, ([v]) => show(v));
  def("num", 1, ([v], interp, pos) => {
    const n = Number(v);
    return Number.isNaN(n) ? interp.fail(`Cannot convert ${show(v, true)} to number`, pos) : n;
  });
  def("push", 2, ([arr, v], interp, pos) => {
    if (!Array.isArray(arr)) return interp.fail("push() needs an array", pos);
    arr.push(v);
    return arr;
  });
  def("pop", 1, ([arr], interp, pos) => {
    if (!Array.isArray(arr) || !arr.length) return interp.fail("pop() needs a non-empty array", pos);
    return arr.pop()!;
  });
  def("keys", 1, ([m], interp, pos) =>
    m instanceof MapValue ? [...m.entries.keys()] : interp.fail("keys() needs a map", pos),
  );
  def("has", 2, ([m, k], interp, pos) =>
    m instanceof MapValue ? m.entries.has(interp.key(k, pos)) : interp.fail("has() needs a map", pos),
  );
  def("floor", 1, ([n], interp, pos) => Math.floor(interp.num(n, pos)));
  def("sqrt", 1, ([n], interp, pos) => Math.sqrt(interp.num(n, pos)));
  def("split", 2, ([s, sep]) => String(s).split(String(sep)));
  def("join", 2, ([arr, sep], interp, pos) =>
    Array.isArray(arr) ? arr.map((x) => show(x)).join(String(sep)) : interp.fail("join() needs an array", pos),
  );
  def("map", 2, ([arr, f], interp, pos) =>
    Array.isArray(arr) ? arr.map((x) => interp.call(f, [x], pos)) : interp.fail("map() needs an array", pos),
  );
  def("filter", 2, ([arr, f], interp, pos) =>
    Array.isArray(arr) ? arr.filter((x) => truthy(interp.call(f, [x], pos))) : interp.fail("filter() needs an array", pos),
  );
  def("reduce", 3, ([arr, f, init], interp, pos) =>
    Array.isArray(arr) ? arr.reduce<Value>((acc, x) => interp.call(f, [acc, x], pos), init) : interp.fail("reduce() needs an array", pos),
  );
  def("sort", 1, ([arr], interp, pos) => {
    if (!Array.isArray(arr)) return interp.fail("sort() needs an array", pos);
    return [...arr].sort((a, b) => (interp.binary("<", a, b, pos) ? -1 : interp.binary(">", a, b, pos) ? 1 : 0));
  });
}
