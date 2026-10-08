import { parseCron, type CronFields } from "./parse.ts";
import { assertTimeZone, daysInMonth, fromWall, toWall, weekday, type WallTime } from "./zoned.ts";

export interface CronOptions {
  /** IANA zone such as "Asia/Kolkata". Defaults to UTC. */
  timeZone?: string;
}

const MAX_YEARS_AHEAD = 8; // "0 0 29 2 MON" can be years apart; give up beyond this

export class Cron {
  readonly fields: CronFields;
  readonly timeZone: string;

  constructor(expression: string, options: CronOptions = {}) {
    this.fields = parseCron(expression);
    this.timeZone = options.timeZone ?? "UTC";
    assertTimeZone(this.timeZone);
  }

  /** Does the calendar day match the day-of-month / day-of-week rules? */
  matchesDay(year: number, month: number, day: number): boolean {
    const f = this.fields;
    const dim = daysInMonth(year, month);
    const wd = weekday(year, month, day);

    const domMatch = f.lastDayOfMonth ? day === dim : f.dayOfMonth.has(day);
    const dowMatch =
      f.dayOfWeek.has(wd) ||
      (f.lastWeekdays.has(wd) && day + 7 > dim) ||
      f.nthWeekdays.some(([w, n]) => w === wd && Math.ceil(day / 7) === n);

    // Vixie cron rule: if both fields are restricted, a day matching EITHER runs.
    if (f.domStar && f.dowStar) return true;
    if (f.domStar) return dowMatch;
    if (f.dowStar) return domMatch;
    return domMatch || dowMatch;
  }

  /** The first run strictly after `from`. Returns null if none within 8 years. */
  next(from: Date | number = Date.now()): Date | null {
    const f = this.fields;
    // Cron has one-second resolution: the earliest candidate is the next whole second.
    const fromMs = typeof from === "number" ? from : from.getTime();
    const earliest = Math.floor(fromMs / 1000) * 1000 + 1000;
    const start = toWall(earliest, this.timeZone);
    const months = [...f.month].sort((a, b) => a - b);
    const hours = [...f.hour].sort((a, b) => a - b);
    const minutes = [...f.minute].sort((a, b) => a - b);
    const seconds = [...f.second].sort((a, b) => a - b);

    for (let year = start.year; year <= start.year + MAX_YEARS_AHEAD; year++) {
      for (const month of months) {
        if (year === start.year && month < start.month) continue;
        const firstDay = year === start.year && month === start.month ? start.day : 1;
        for (let day = firstDay; day <= daysInMonth(year, month); day++) {
          if (!this.matchesDay(year, month, day)) continue;
          const sameDay = year === start.year && month === start.month && day === start.day;
          for (const hour of hours) {
            if (sameDay && hour < start.hour) continue;
            const sameHour = sameDay && hour === start.hour;
            for (const minute of minutes) {
              if (sameHour && minute < start.minute) continue;
              const sameMinute = sameHour && minute === start.minute;
              for (const second of seconds) {
                if (sameMinute && second < start.second) continue;
                const wall: WallTime = { year, month, day, hour, minute, second };
                const ms = fromWall(wall, this.timeZone);
                // Times skipped by a DST jump don't exist and are not run. After a
                // fall-back, a wall time can map to an instant before `earliest`.
                if (ms !== null && ms >= earliest) return new Date(ms);
              }
            }
          }
        }
      }
    }
    return null;
  }

  /** The next `count` run times. */
  nextN(count: number, from: Date | number = Date.now()): Date[] {
    const out: Date[] = [];
    let cursor: Date | number = from;
    while (out.length < count) {
      const n = this.next(cursor);
      if (!n) break;
      out.push(n);
      cursor = n;
    }
    return out;
  }

  /** Every run in (from, to]. */
  *between(from: Date | number, to: Date | number): Generator<Date> {
    const end = typeof to === "number" ? to : to.getTime();
    let cursor: Date | number = from;
    for (;;) {
      const n = this.next(cursor);
      if (!n || n.getTime() > end) return;
      yield n;
      cursor = n;
    }
  }

  /** Does `date` fall exactly on a scheduled second? */
  matches(date: Date | number): boolean {
    const ms = typeof date === "number" ? date : date.getTime();
    const n = this.next(ms - 1000);
    return n !== null && n.getTime() === Math.floor(ms / 1000) * 1000;
  }
}
