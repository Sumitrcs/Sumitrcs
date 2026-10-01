#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Interpreter, show } from "./interpreter.ts";

const file = process.argv[2];
const interp = new Interpreter((s) => console.log(s));

if (file) {
  try {
    interp.run(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`${file}: ${(e as Error).message}`);
    process.exit(1);
  }
} else {
  console.log("tinylang REPL — Ctrl+D to exit");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: ">> " });
  let buffer = "";
  rl.prompt();
  rl.on("line", (line) => {
    buffer += line + "\n";
    // Keep reading while braces are unbalanced, so multi-line functions work.
    const depth = [...buffer].reduce((d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
    if (depth > 0) {
      rl.setPrompt(".. ");
      rl.prompt();
      return;
    }
    try {
      const v = interp.run(buffer);
      if (v !== null) console.log(show(v, true));
    } catch (e) {
      console.error((e as Error).message);
    }
    buffer = "";
    rl.setPrompt(">> ");
    rl.prompt();
  });
}
