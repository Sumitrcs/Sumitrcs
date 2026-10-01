export class CronSyntaxError extends Error {
  field: string;
  constructor(message: string, field: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

export interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

export const FIELDS: Record<string, FieldSpec> = {
  second: { name: "second", min: 0, max: 59 },
  minute: { name: "minute", min: 0, max: 59 },
  hour: { name: "hour", min: 0, max: 23 },
  dayOfMonth: { name: "day of month", min: 1, max: 31 },
  month: { name: "month", min: 1, max: 12, names: MONTHS },
  dayOfWeek: { name: "day of week", min: 0, max: 7, names: DAYS }, // 7 = Sunday too
};

export const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export interface CronFields {
  second: Set<number>;
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** "L" in day-of-month: last day of the month. */
  lastDayOfMonth: boolean;
  /** "5L" in day-of-week: last Friday of the month, etc. */
  lastWeekdays: Set<number>;
  /** "MON#2": [weekday, nth] pairs. */
  nthWeekdays: [number, number][];
  /** Whether the field was "*" — affects day-of-month / day-of-week OR semantics. */
  domStar: boolean;
  dowStar: boolean;
  source: string;
}

function value(token: string, spec: FieldSpec): number {
  const upper = token.toUpperCase();
  if (spec.names && upper in spec.names) return spec.names[upper];
  if (!/^\d+$/.test(token)) throw new CronSyntaxError(`'${token}' is not a number${spec.names ? " or name" : ""}`, spec.name);
  const n = Number(token);
  if (n < spec.min || n > spec.max) throw new CronSyntaxError(`${n} is out of range ${spec.min}-${spec.max}`, spec.name);
  return n;
}

/** Parses one comma-separated field into the set of allowed values. */
export function parseField(text: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  if (text === "") throw new CronSyntaxError("empty field", spec.name);
  for (const part of text.split(",")) {
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new CronSyntaxError(`'${part}' has more than one '/'`, spec.name);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw new CronSyntaxError(`invalid step '${stepPart}'`, spec.name);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === "?") {
      lo = spec.min;
      hi = spec.max === 7 ? 6 : spec.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = value(a, spec);
      hi = value(b, spec);
      if (lo > hi) throw new CronSyntaxError(`range ${rangePart} is backwards`, spec.name);
    } else {
      lo = value(rangePart, spec);
      // "5/15" means "from 5 to max every 15"
      hi = stepPart !== undefined ? (spec.max === 7 ? 6 : spec.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(spec.max === 7 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expression: string): CronFields {
  const source = expression.trim();
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new CronSyntaxError(`expected 5 or 6 fields, got ${parts.length}`, "expression");
  }
  const [sec, min, hour, dom, mon, dow] = parts.length === 6 ? parts : ["0", ...parts];

  let lastDayOfMonth = false;
  let domText = dom;
  if (dom.toUpperCase() === "L") {
    lastDayOfMonth = true;
    domText = "*";
  }

  const lastWeekdays = new Set<number>();
  const nthWeekdays: [number, number][] = [];
  const plainDow: string[] = [];
  for (const piece of dow.split(",")) {
    const nth = /^(\w+)#([1-5])$/.exec(piece);
    const last = /^(\w+)L$/i.exec(piece);
    if (nth) nthWeekdays.push([value(nth[1], FIELDS.dayOfWeek) % 7, Number(nth[2])]);
    else if (last) lastWeekdays.add(value(last[1], FIELDS.dayOfWeek) % 7);
    else plainDow.push(piece);
  }
  const specialDow = nthWeekdays.length > 0 || lastWeekdays.size > 0;

  return {
    second: parseField(sec, FIELDS.second),
    minute: parseField(min, FIELDS.minute),
    hour: parseField(hour, FIELDS.hour),
    dayOfMonth: parseField(domText, FIELDS.dayOfMonth),
    month: parseField(mon, FIELDS.month),
    dayOfWeek: plainDow.length ? parseField(plainDow.join(","), FIELDS.dayOfWeek) : new Set(),
    lastDayOfMonth,
    lastWeekdays,
    nthWeekdays,
    domStar: (dom === "*" || dom === "?") && !lastDayOfMonth,
    dowStar: (dow === "*" || dow === "?") && !specialDow,
    source,
  };
}
