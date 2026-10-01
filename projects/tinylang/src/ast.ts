export interface Pos {
  line: number;
  col: number;
}

export type Expr =
  | { kind: "Number"; value: number; pos: Pos }
  | { kind: "String"; parts: (string | Expr)[]; pos: Pos }
  | { kind: "Bool"; value: boolean; pos: Pos }
  | { kind: "Nil"; pos: Pos }
  | { kind: "Ident"; name: string; pos: Pos }
  | { kind: "Array"; items: Expr[]; pos: Pos }
  | { kind: "Map"; entries: [Expr, Expr][]; pos: Pos }
  | { kind: "Unary"; op: string; operand: Expr; pos: Pos }
  | { kind: "Binary"; op: string; left: Expr; right: Expr; pos: Pos }
  | { kind: "Logical"; op: "and" | "or"; left: Expr; right: Expr; pos: Pos }
  | { kind: "Assign"; target: Expr; value: Expr; pos: Pos }
  | { kind: "Call"; callee: Expr; args: Expr[]; pos: Pos }
  | { kind: "Index"; object: Expr; index: Expr; pos: Pos }
  | { kind: "Fn"; name: string | null; params: string[]; body: Stmt[]; pos: Pos }
  | { kind: "If"; cond: Expr; then: Stmt[]; otherwise: Stmt[] | null; pos: Pos }
  | { kind: "Range"; from: Expr; to: Expr; pos: Pos };

export type Stmt =
  | { kind: "Let"; name: string; value: Expr; pos: Pos }
  | { kind: "Expr"; expr: Expr; pos: Pos }
  | { kind: "Return"; value: Expr | null; pos: Pos }
  | { kind: "While"; cond: Expr; body: Stmt[]; pos: Pos }
  | { kind: "For"; name: string; iterable: Expr; body: Stmt[]; pos: Pos }
  | { kind: "Break"; pos: Pos }
  | { kind: "Continue"; pos: Pos };
