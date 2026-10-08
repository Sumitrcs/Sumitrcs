#!/usr/bin/env node
// cronkit "<expression>" [--tz Asia/Kolkata] [-n 5]
import { Cron, describe } from "./index.ts";

let expr: string | undefined;
let tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
let n = 5;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tz") tz = args[++i];
  else if (args[i] === "-n") n = Number(args[++i]);
  else expr = args[i];
}

if (!expr) {
  console.error('usage: cronkit "<cron expression>" [--tz Area/City] [-n count]');
  process.exit(2);
}
try {
  const cron = new Cron(expr, { timeZone: tz });
  console.log(describe(expr));
  console.log(`Next ${n} runs (${tz}):`);
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
  for (const d of cron.nextN(n)) console.log("  " + fmt.format(d));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
