import type { Expr, Pos, Stmt } from "./ast.ts";
import { SyntaxError, tokenize, type Token, type TokenType } from "./lexer.ts";

// Binding powers for the Pratt parser (higher binds tighter).
const PREC = {
  assign: 1,
  or: 2,
  and: 3,
  equality: 4,
  comparison: 5,
  range: 6,
  term: 7,
  factor: 8,
  unary: 9,
  call: 10,
} as const;

const INFIX: Partial<Record<TokenType, number>> = {
  "=": PREC.assign,
  or: PREC.or,
  and: PREC.and,
  "==": PREC.equality,
  "!=": PREC.equality,
  "<": PREC.comparison,
  "<=": PREC.comparison,
  ">": PREC.comparison,
  ">=": PREC.comparison,
  "..": PREC.range,
  "+": PREC.term,
  "-": PREC.term,
  "*": PREC.factor,
  "/": PREC.factor,
  "%": PREC.factor,
  "(": PREC.call,
  "[": PREC.call,
  ".": PREC.call,
};

export function parse(src: string): Stmt[] {
  return new Parser(tokenize(src)).program();
}

class Parser {
  tokens: Token[];
  i = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.i];
  }
  at(type: TokenType): boolean {
    return this.peek().type === type;
  }
  advance(): Token {
    return this.tokens[this.i++];
  }
  match(type: TokenType): boolean {
    if (!this.at(type)) return false;
    this.i++;
    return true;
  }
  expect(type: TokenType, what = `'${type}'`): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new SyntaxError(`Expected ${what} but found ${t.type === "eof" ? "end of input" : `'${t.lexeme}'`}`, t.line, t.col);
    }
    return this.advance();
  }
  pos(t: Token = this.peek()): Pos {
    return { line: t.line, col: t.col };
  }

  program(): Stmt[] {
    const out: Stmt[] = [];
    while (!this.at("eof")) out.push(this.statement());
    return out;
  }

  block(): Stmt[] {
    this.expect("{");
    const out: Stmt[] = [];
    while (!this.at("}") && !this.at("eof")) out.push(this.statement());
    this.expect("}");
    return out;
  }

  statement(): Stmt {
    const t = this.peek();
    const pos = this.pos(t);
    let s: Stmt;
    switch (t.type) {
      case "let": {
        this.advance();
        const name = this.expect("ident", "a variable name").lexeme;
        this.expect("=");
        s = { kind: "Let", name, value: this.expression(), pos };
        break;
      }
      case "return": {
        this.advance();
        const value = this.at(";") || this.at("}") ? null : this.expression();
        s = { kind: "Return", value, pos };
        break;
      }
      case "while": {
        this.advance();
        const cond = this.expression();
        return { kind: "While", cond, body: this.block(), pos };
      }
      case "for": {
        this.advance();
        const name = this.expect("ident", "a loop variable").lexeme;
        this.expect("in");
        const iterable = this.expression();
        return { kind: "For", name, iterable, body: this.block(), pos };
      }
      case "break":
        this.advance();
        s = { kind: "Break", pos };
        break;
      case "continue":
        this.advance();
        s = { kind: "Continue", pos };
        break;
      case "fn":
        // Named function declaration: sugar for `let name = fn(...) {...}`
        if (this.tokens[this.i + 1]?.type === "ident") {
          const fnExpr = this.expression();
          if (fnExpr.kind === "Fn" && fnExpr.name) return { kind: "Let", name: fnExpr.name, value: fnExpr, pos };
          s = { kind: "Expr", expr: fnExpr, pos };
          break;
        }
      // fallthrough
      default:
        s = { kind: "Expr", expr: this.expression(), pos };
    }
    this.match(";");
    return s;
  }

  expression(minPrec = 0): Expr {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      const prec = INFIX[t.type];
      if (prec === undefined || prec <= minPrec) break;
      left = this.infix(left, t, prec);
    }
    return left;
  }

  prefix(): Expr {
    const t = this.advance();
    const pos = this.pos(t);
    switch (t.type) {
      case "number":
        return { kind: "Number", value: t.value as number, pos };
      case "string":
        return { kind: "String", parts: this.interpolate(t), pos };
      case "true":
      case "false":
        return { kind: "Bool", value: t.type === "true", pos };
      case "nil":
        return { kind: "Nil", pos };
      case "ident":
        return { kind: "Ident", name: t.lexeme, pos };
      case "-":
      case "!":
        return { kind: "Unary", op: t.type, operand: this.expression(PREC.unary), pos };
      case "(": {
        const e = this.expression();
        this.expect(")");
        return e;
      }
      case "[": {
        const items: Expr[] = [];
        while (!this.at("]")) {
          items.push(this.expression());
          if (!this.match(",")) break;
        }
        this.expect("]");
        return { kind: "Array", items, pos };
      }
      case "{": {
        const entries: [Expr, Expr][] = [];
        while (!this.at("}")) {
          // Bare identifiers as keys are sugar for strings: { name: "x" }
          const k = this.peek();
          const key: Expr =
            k.type === "ident" && this.tokens[this.i + 1]?.type === ":"
              ? (this.advance(), { kind: "String", parts: [k.lexeme], pos: this.pos(k) })
              : this.expression();
          this.expect(":");
          entries.push([key, this.expression()]);
          if (!this.match(",")) break;
        }
        this.expect("}");
        return { kind: "Map", entries, pos };
      }
      case "fn": {
        const name = this.at("ident") ? this.advance().lexeme : null;
        this.expect("(");
        const params: string[] = [];
        while (!this.at(")")) {
          params.push(this.expect("ident", "a parameter name").lexeme);
          if (!this.match(",")) break;
        }
        this.expect(")");
        // `fn(x) => x * 2` short form
        if (this.match("=>")) {
          const e = this.expression();
          return { kind: "Fn", name, params, body: [{ kind: "Return", value: e, pos: e.pos }], pos };
        }
        return { kind: "Fn", name, params, body: this.block(), pos };
      }
      case "if": {
        const cond = this.expression();
        const then = this.block();
        let otherwise: Stmt[] | null = null;
        if (this.match("else")) {
          if (this.at("if")) {
            const nested = this.prefix();
            otherwise = [{ kind: "Expr", expr: nested, pos: nested.pos }];
          } else otherwise = this.block();
        }
        return { kind: "If", cond, then, otherwise, pos };
      }
    }
    throw new SyntaxError(`Unexpected ${t.type === "eof" ? "end of input" : `'${t.lexeme}'`}`, t.line, t.col);
  }

  infix(left: Expr, t: Token, prec: number): Expr {
    const pos = this.pos(t);
    this.advance();
    switch (t.type) {
      case "=": {
        if (left.kind !== "Ident" && left.kind !== "Index") {
          throw new SyntaxError("Invalid assignment target", t.line, t.col);
        }
        // Right-associative: a = b = c
        return { kind: "Assign", target: left, value: this.expression(prec - 1), pos };
      }
      case "and":
      case "or":
        return { kind: "Logical", op: t.type, left, right: this.expression(prec), pos };
      case "..":
        return { kind: "Range", from: left, to: this.expression(prec), pos };
      case "(": {
        const args: Expr[] = [];
        while (!this.at(")")) {
          args.push(this.expression());
          if (!this.match(",")) break;
        }
        this.expect(")");
        return { kind: "Call", callee: left, args, pos };
      }
      case "[": {
        const index = this.expression();
        this.expect("]");
        return { kind: "Index", object: left, index, pos };
      }
      case ".": {
        const name = this.expect("ident", "a property name");
        return { kind: "Index", object: left, index: { kind: "String", parts: [name.lexeme], pos: this.pos(name) }, pos };
      }
      default:
        return { kind: "Binary", op: t.type, left, right: this.expression(prec), pos };
    }
  }

  /** "Hello {name}!" -> ["Hello ", Ident(name), "!"] */
  interpolate(t: Token): (string | Expr)[] {
    const s = t.value as string;
    const parts: (string | Expr)[] = [];
    let buf = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\u0000" && s[i + 1] === "{") {
        buf += "{";
        i++;
      } else if (s[i] === "{") {
        const end = s.indexOf("}", i);
        if (end < 0) throw new SyntaxError("Unclosed '{' in string interpolation", t.line, t.col);
        if (buf) parts.push(buf);
        buf = "";
        const inner = new Parser(tokenize(s.slice(i + 1, end))).expression();
        parts.push(inner);
        i = end;
      } else buf += s[i];
    }
    if (buf || parts.length === 0) parts.push(buf);
    return parts;
  }
}
