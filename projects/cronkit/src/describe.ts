import { parseCron } from "./parse.ts";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ORDINAL = ["", "first", "second", "third", "fourth", "fifth"];

function runs(values: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const v of values) {
    const last = out.at(-1);
    if (last && v === last[1] + 1) last[1] = v;
    else out.push([v, v]);
  }
  return out;
}

function list(values: Set<number>, name: (n: number) => string): string {
  const parts = runs([...values].sort((a, b) => a - b)).map(([a, b]) =>
    a === b ? name(a) : b === a + 1 ? `${name(a)} and ${name(b)}` : `${name(a)} through ${name(b)}`,
  );
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts.at(-1) : parts[0];
}

function step(values: Set<number>, min: number, max: number): number | null {
  const v = [...values].sort((a, b) => a - b);
  if (v.length < 3 || v[0] !== min) return null;
  const s = v[1] - v[0];
  if (!v.every((x, i) => x === min + i * s)) return null;
  return v.at(-1)! + s > max ? s : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Plain-English description, e.g. "At 09:30, Monday through Friday". */
export function describe(expression: string): string {
  const f = parseCron(expression);
  const parts: string[] = [];
  const mins = [...f.minute];
  const hrs = [...f.hour];
  const secs = [...f.second];

  const minuteStep = step(f.minute, 0, 59);
  const hourStep = step(f.hour, 0, 23);
  if (f.second.size === 60 && f.minute.size === 60 && f.hour.size === 24) parts.push("Every second");
  else if (f.minute.size === 60 && f.hour.size === 24) parts.push("Every minute");
  else if (minuteStep && f.hour.size === 24) parts.push(`Every ${minuteStep} minutes`);
  else if (mins.length === 1 && f.hour.size === 24) parts.push(mins[0] === 0 ? "Every hour" : `At minute ${mins[0]} past every hour`);
  else if (mins.length === 1 && hourStep) parts.push(`At minute ${mins[0]} past every ${hourStep} hours`);
  else if (mins.length === 1 && hrs.length <= 4) {
    const s = secs.length === 1 && secs[0] !== 0 ? `:${pad(secs[0])}` : "";
    parts.push("At " + hrs.sort((a, b) => a - b).map((h) => `${pad(h)}:${pad(mins[0])}${s}`).join(", "));
  } else {
    parts.push(f.minute.size === 60 ? "Every minute" : `At minute ${list(f.minute, String)}`);
    if (f.hour.size !== 24) parts.push(`past hour ${list(f.hour, String)}`);
  }

  const days: string[] = [];
  if (f.lastDayOfMonth) days.push("on the last day of the month");
  else if (!f.domStar) days.push(`on day ${list(f.dayOfMonth, String)} of the month`);
  if (!f.dowStar) {
    const bits: string[] = [];
    if (f.dayOfWeek.size) bits.push(list(f.dayOfWeek, (d) => DAY_NAMES[d]));
    for (const [w, n] of f.nthWeekdays) bits.push(`the ${ORDINAL[n]} ${DAY_NAMES[w]}`);
    for (const w of f.lastWeekdays) bits.push(`the last ${DAY_NAMES[w]}`);
    days.push((days.length ? "or " : "") + (f.nthWeekdays.length || f.lastWeekdays.size ? "on " : "") + bits.join(", "));
  }
  if (days.length) parts.push(days.join(" "));
  if (f.month.size !== 12) parts.push(`in ${list(f.month, (m) => MONTH_NAMES[m])}`);
  return parts.join(", ");
}
