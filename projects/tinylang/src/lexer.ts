export type TokenType =
  | "number" | "string" | "ident"
  | "let" | "fn" | "return" | "if" | "else" | "while" | "for" | "in" | "true" | "false" | "nil"
  | "and" | "or" | "break" | "continue"
  | "+" | "-" | "*" | "/" | "%" | "!" | "=" | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "(" | ")" | "{" | "}" | "[" | "]" | "," | ":" | ";" | "." | "=>" | ".."
  | "eof";

export interface Token {
  type: TokenType;
  lexeme: string;
  value?: number | string;
  line: number;
  col: number;
}

export class SyntaxError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(`${message} at ${line}:${col}`);
    this.line = line;
    this.col = col;
  }
}

const KEYWORDS = new Set([
  "let", "fn", "return", "if", "else", "while", "for", "in", "true", "false", "nil", "and", "or", "break", "continue",
]);

// Longest operators first so ">=" wins over ">".
const OPERATORS = ["==", "!=", "<=", ">=", "=>", "..", "+", "-", "*", "/", "%", "!", "=", "<", ">", "(", ")", "{", "}", "[", "]", ",", ":", ";", "."];

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", "{": "{" };

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") advance();
      continue;
    }

    const startLine = line;
    const startCol = col;

    if (/[0-9]/.test(c)) {
      let j = i;
      while (/[0-9_]/.test(src[j] ?? "")) j++;
      // A single dot followed by a digit is a decimal point; ".." is a range.
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (/[0-9_]/.test(src[j] ?? "")) j++;
      }
      const lexeme = src.slice(i, j);
      tokens.push({ type: "number", lexeme, value: Number(lexeme.replaceAll("_", "")), line: startLine, col: startCol });
      advance(j - i);
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (/[A-Za-z0-9_]/.test(src[j] ?? "")) j++;
      const word = src.slice(i, j);
      const type = (KEYWORDS.has(word) ? word : "ident") as TokenType;
      tokens.push({ type, lexeme: word, line: startLine, col: startCol });
      advance(j - i);
      continue;
    }

    if (c === '"') {
      advance();
      let value = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          const esc = ESCAPES[src[i + 1]];
          if (esc === undefined) throw new SyntaxError(`Unknown escape \\${src[i + 1]}`, line, col);
          // Keep \{ marked so interpolation can tell it apart from a real brace.
          value += src[i + 1] === "{" ? "\u0000{" : esc;
          advance(2);
        } else {
          value += src[i];
          advance();
        }
      }
      if (i >= src.length) throw new SyntaxError("Unterminated string", startLine, startCol);
      advance();
      tokens.push({ type: "string", lexeme: value, value, line: startLine, col: startCol });
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new SyntaxError(`Unexpected character '${c}'`, line, col);
    tokens.push({ type: op as TokenType, lexeme: op, line: startLine, col: startCol });
    advance(op.length);
  }

  tokens.push({ type: "eof", lexeme: "", line, col });
  return tokens;
}
