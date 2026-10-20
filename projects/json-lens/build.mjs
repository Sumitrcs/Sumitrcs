// Turns src/*.ts into dist/*.js for the browser, with no dependencies:
// Node's built-in stripTypeScriptTypes removes the type annotations (the
// code is written so that nothing else needs changing), and imports of
// "./x.ts" become "./x.js".
//
//   node build.mjs           write dist/
//   node build.mjs --check   fail if dist/ is out of date (used in CI)
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

process.removeAllListeners("warning"); // stripTypeScriptTypes is marked experimental
const check = process.argv.includes("--check");
mkdirSync("dist", { recursive: true });
let stale = [];
for (const file of readdirSync("src").filter((f) => f.endsWith(".ts"))) {
  const ts = readFileSync(`src/${file}`, "utf8");
  const js =
    "// Built from src/" + file + " by build.mjs. Edit the .ts file, not this one.\n" +
    stripTypeScriptTypes(ts, { mode: "strip" }).replace(/(from\s+["']\.\/[\w-]+)\.ts(["'])/g, "$1.js$2");
  const out = `dist/${file.replace(/\.ts$/, ".js")}`;
  if (check) {
    // Different Node versions may pad stripped types with different amounts
    // of whitespace, so compare the code with runs of spaces collapsed.
    const squash = (code) => code.replace(/[ \t]+/g, " ").replace(/ +$/gm, "");
    if (!existsSync(out) || squash(readFileSync(out, "utf8")) !== squash(js)) stale.push(out);
  } else {
    writeFileSync(out, js);
    console.log("wrote", out);
  }
}
if (stale.length) {
  console.error("out of date (run node build.mjs):", stale.join(", "));
  process.exit(1);
}
