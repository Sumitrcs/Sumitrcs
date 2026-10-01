import { test } from "node:test";
import assert from "node:assert/strict";
import { Interpreter, show, RuntimeError } from "../src/interpreter.ts";
import { SyntaxError, tokenize } from "../src/lexer.ts";

function run(src: string) {
  const it = new Interpreter();
  const value = it.run(src);
  return { value: show(value, true), output: it.output };
}

test("arithmetic precedence and associativity", () => {
  assert.equal(run("1 + 2 * 3 - 4 / 2").value, "5");
  assert.equal(run("(1 + 2) * 3").value, "9");
  assert.equal(run("-2 * -3").value, "6");
  assert.equal(run("10 - 3 - 2").value, "5");
  assert.equal(run("2 * 3 % 4").value, "2");
});

test("comparison, equality and logic short-circuit", () => {
  assert.equal(run("1 < 2 and 3 >= 3").value, "true");
  assert.equal(run("nil or \"default\"").value, '"default"');
  assert.equal(run("false and undefinedThing").value, "false");
  assert.equal(run("[1, [2]] == [1, [2]]").value, "true");
  assert.equal(run("!nil").value, "true");
});

test("variables, assignment and scoping", () => {
  assert.equal(run("let a = 1; let b = a = 5; a + b").value, "10");
  assert.equal(run("let x = 1; if true { let x = 2 }; x").value, "1");
  assert.equal(run("let x = 1; if true { x = 2 }; x").value, "2");
  assert.throws(() => run("y = 3"), /undeclared variable 'y'/);
});

test("functions, recursion and implicit return", () => {
  assert.equal(run("fn fact(n) { if n <= 1 { 1 } else { n * fact(n - 1) } } fact(10)").value, "3628800");
  assert.equal(run("let add = fn(a, b) => a + b; add(2, 3)").value, "5");
  assert.equal(run("fn f() { return; 99 } f()").value, "nil");
});

test("closures capture variables by reference", () => {
  const src = `
    fn makeAccount(balance) {
      {
        deposit: fn(x) { balance = balance + x; balance },
        withdraw: fn(x) {
          if x > balance { return "insufficient funds" }
          balance = balance - x
          balance
        },
      }
    }
    let acct = makeAccount(100)
    acct.deposit(50)
    print(acct.withdraw(500))
    acct.withdraw(30)
  `;
  const r = run(src);
  assert.equal(r.value, "120");
  assert.deepEqual(r.output, ["insufficient funds"]);
});

test("arrays, negative indexing, ranges and maps", () => {
  assert.equal(run("let a = [1, 2, 3]; a[-1]").value, "3");
  assert.equal(run("let a = [1, 2]; a[0] = 9; a").value, "[9, 2]");
  assert.equal(run("0..5").value, "[0, 1, 2, 3, 4]");
  assert.equal(run('let m = {a: 1, "b c": 2}; m["b c"] + m.a').value, "3");
  assert.equal(run("let m = {}; m.missing").value, "nil");
  assert.equal(run("len({x: 1, y: 2}) + len(\"héllo\")").value, "7");
});

test("loops with break and continue", () => {
  const r = run(`
    let total = 0
    for i in 0..20 {
      if i % 2 == 0 { continue }
      if i > 9 { break }
      total = total + i
    }
    let n = 0
    while true { n = n + 1; if n == 5 { break } }
    [total, n]
  `);
  assert.equal(r.value, "[25, 5]");
});

test("string interpolation and escapes", () => {
  assert.equal(run('let name = "Sumit"; "Hi {name}, 2+2={2 + 2}"').value, '"Hi Sumit, 2+2=4"');
  assert.equal(run('"literal \\{braces}"').value, '"literal {braces}"');
  assert.equal(run('"ab" * 3').value, '"ababab"');
});

test("higher-order builtins", () => {
  assert.equal(run("map([1, 2, 3], fn(x) => x * 10)").value, "[10, 20, 30]");
  assert.equal(run("filter(1..10, fn(x) => x % 3 == 0)").value, "[3, 6, 9]");
  assert.equal(run("reduce([1, 2, 3, 4], fn(a, b) => a * b, 1)").value, "24");
  assert.equal(run('sort(["pear", "apple", "fig"])').value, '["apple", "fig", "pear"]');
  assert.equal(run('join(split("a,b,c", ","), "-")').value, '"a-b-c"');
});

test("runtime errors carry line and column", () => {
  assert.throws(() => run("let x = 1\nx + \"a\" - 1"), (e: unknown) => e instanceof RuntimeError && e.pos.line === 2);
  assert.throws(() => run("1 / 0"), /Division by zero at 1:3/);
  assert.throws(() => run("[1][5]"), /out of range/);
  assert.throws(() => run("fn f(a) { a } f()"), /expects 1 argument/);
  assert.throws(() => run("fn f() { f() } f()"), /Stack overflow/);
  assert.throws(() => run("5()"), /not callable/);
});

test("syntax errors carry line and column", () => {
  assert.throws(() => run("let = 5"), (e: unknown) => e instanceof SyntaxError && /Expected a variable name/.test(e.message));
  assert.throws(() => run('"unterminated'), /Unterminated string at 1:1/);
  assert.throws(() => run("1 +"), /Unexpected end of input/);
  assert.throws(() => run("1 = 2"), /Invalid assignment target/);
  assert.throws(() => tokenize("let a = @"), /Unexpected character '@' at 1:9/);
});

test("numbers: decimals, underscores and ranges don't clash", () => {
  assert.equal(run("1_000_000 + 0.5").value, "1000000.5");
  assert.equal(run("len(1..4)").value, "3");
});
