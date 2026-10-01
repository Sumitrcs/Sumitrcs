# tinylang

A small, expression-oriented programming language with first-class functions,
closures, maps, ranges and string interpolation — implemented from scratch in
TypeScript with **zero dependencies**: a hand-written lexer, a **Pratt
parser** and a tree-walking interpreter.

```rust
fn counter() {
  let count = 0
  fn() { count = count + 1; count }
}
let next = counter()
next(); next()
print("counter: {next()}")          # counter: 3

let squares = map(1..11, fn(x) => x * x)
print(filter(squares, fn(x) => x % 2 == 0))   # [4, 16, 36, 64, 100]
```

## Language features

| Feature | Example |
|---|---|
| Numbers, strings, booleans, `nil` | `1_000_000`, `3.14`, `"hi"` |
| String interpolation | `"total: {a + b}"` |
| Arrays with negative indexing | `xs[-1]` |
| Maps with dot access | `{name: "Sumit"}.name` |
| Ranges | `for i in 0..10 { ... }` |
| Functions, recursion, closures | `fn fib(n) { ... }` |
| Arrow lambdas | `fn(x) => x * 2` |
| `if` as an expression | `let s = if ok { "yes" } else { "no" }` |
| Implicit return of last expression | `fn sq(x) { x * x }` |
| `while`, `for … in`, `break`, `continue` | |
| Builtins | `print len type str num push pop keys has map filter reduce sort split join floor sqrt` |

Errors always point to the source position:

```
>> let total = 10
>> total + "x" - 1
Expected a number but got string at 1:13
```

## Try it

Needs Node.js 22.18+ (runs TypeScript directly, no build step).

```bash
npm run example      # runs examples/showcase.tl
npm run repl         # interactive REPL with multi-line input
node src/cli.ts my-script.tl
```

## How it works

```
source ──▶ lexer.ts ──▶ tokens ──▶ parser.ts ──▶ AST ──▶ interpreter.ts ──▶ value
```

- **Lexer** — single pass, tracks line/column, handles escapes and
  `1..5` vs `1.5` correctly.
- **Parser** — top-down operator precedence (Pratt). Each token has a binding
  power; prefix and infix handlers make adding an operator a one-line
  change. Assignment is right-associative; calls, indexing and `.` bind
  tightest. String interpolation re-enters the parser for each `{expr}`.
- **Interpreter** — environments form a parent chain, so closures simply
  keep a reference to the environment they were created in. `return`,
  `break` and `continue` unwind via internal signals. Recursion depth is
  capped so runaway programs fail with a clean error instead of crashing
  the host.

## Tests

```bash
npm test
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
