// Wall-clock <-> instant conversion for an IANA time zone using only Intl.

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function assertTimeZone(timeZone: string): void {
  try {
    formatter(timeZone);
  } catch {
    throw new RangeError(`Unknown time zone '${timeZone}'`);
  }
}

export function toWall(ms: number, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

function wallAsUtc(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** Offset (ms) of the zone at instant `ms`: wall time minus UTC. */
export function offsetAt(ms: number, timeZone: string): number {
  return wallAsUtc(toWall(ms, timeZone)) - Math.floor(ms / 1000) * 1000;
}

/**
 * Converts a wall-clock time to an instant. Returns null for wall times that
 * don't exist (skipped by a DST spring-forward). Ambiguous times (repeated by
 * a fall-back) resolve to the earlier instant.
 */
export function fromWall(w: WallTime, timeZone: string): number | null {
  const naive = wallAsUtc(w);
  // Try the offsets in effect a day either side; one of them is right.
  const candidates = new Set([offsetAt(naive - 86_400_000, timeZone), offsetAt(naive + 86_400_000, timeZone)]);
  const matches: number[] = [];
  for (const off of candidates) {
    const ms = naive - off;
    const back = toWall(ms, timeZone);
    if (wallAsUtc(back) === naive) matches.push(ms);
  }
  return matches.length ? Math.min(...matches) : null;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Sunday. Pure calendar arithmetic, independent of time zone. */
export function weekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
