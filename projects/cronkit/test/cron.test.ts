import { test } from "node:test";
import assert from "node:assert/strict";
import { Cron, CronSyntaxError, describe, parseCron, schedule } from "../src/index.ts";

const iso = (d: Date | null) => d?.toISOString() ?? null;
const at = (s: string) => new Date(s);

test("basic fields, lists, ranges and steps", () => {
  const f = parseCron("*/15 9-17 1,15 JAN-MAR MON-FRI");
  assert.deepEqual([...f.minute], [0, 15, 30, 45]);
  assert.deepEqual([...f.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...f.month], [1, 2, 3]);
  assert.deepEqual([...f.dayOfWeek], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("5/20 * * * *").minute], [5, 25, 45]);
  assert.deepEqual([...parseCron("0 0 * * 7").dayOfWeek], [0]); // 7 is Sunday
});

test("syntax errors name the field", () => {
  const cases: [string, RegExp][] = [
    ["* * *", /expected 5 or 6 fields/],
    ["60 * * * *", /minute: 60 is out of range/],
    ["* 25 * * *", /hour/],
    ["* * 0 * *", /day of month/],
    ["* * * FOO *", /month: 'FOO' is not a number or name/],
    ["*/0 * * * *", /invalid step/],
    ["5-1 * * * *", /backwards/],
  ];
  for (const [expr, re] of cases) assert.throws(() => new Cron(expr), (e: unknown) => e instanceof CronSyntaxError && re.test(e.message), expr);
  assert.throws(() => new Cron("* * * * *", { timeZone: "Mars/Olympus" }), /Unknown time zone/);
});

test("next run in UTC", () => {
  assert.equal(iso(new Cron("30 9 * * *").next(at("2026-10-01T08:00:00Z"))), "2026-10-01T09:30:00.000Z");
  assert.equal(iso(new Cron("30 9 * * *").next(at("2026-10-01T09:30:00Z"))), "2026-10-02T09:30:00.000Z");
  assert.equal(iso(new Cron("0 0 1 1 *").next(at("2026-10-01T00:00:00Z"))), "2027-01-01T00:00:00.000Z");
  assert.equal(iso(new Cron("@hourly").next(at("2026-12-31T23:59:59Z"))), "2027-01-01T00:00:00.000Z");
  // six-field expression with seconds
  assert.equal(iso(new Cron("*/10 * * * * *").next(at("2026-10-01T00:00:05Z"))), "2026-10-01T00:00:10.000Z");
});

test("leap day and impossible schedules", () => {
  assert.equal(iso(new Cron("0 12 29 2 *").next(at("2026-10-01T00:00:00Z"))), "2028-02-29T12:00:00.000Z");
  assert.equal(new Cron("0 0 31 2 *").next(at("2026-01-01T00:00:00Z")), null);
});

test("day-of-month OR day-of-week when both are restricted (Vixie cron)", () => {
  const c = new Cron("0 0 13 * FRI");
  const runs = c.nextN(4, at("2026-02-01T00:00:00Z")).map(iso);
  // Fridays in Feb 2026: 6, 13, 20, 27 — plus the 13th (also a Friday)
  assert.deepEqual(runs, [
    "2026-02-06T00:00:00.000Z",
    "2026-02-13T00:00:00.000Z",
    "2026-02-20T00:00:00.000Z",
    "2026-02-27T00:00:00.000Z",
  ]);
  assert.equal(iso(c.next(at("2026-02-28T00:00:00Z"))), "2026-03-06T00:00:00.000Z");
});

test("L, nth weekday and last weekday", () => {
  assert.deepEqual(new Cron("0 18 L * *").nextN(3, at("2026-01-15T00:00:00Z")).map(iso), [
    "2026-01-31T18:00:00.000Z",
    "2026-02-28T18:00:00.000Z",
    "2026-03-31T18:00:00.000Z",
  ]);
  // Second Monday of each month
  assert.deepEqual(new Cron("0 10 * * MON#2").nextN(2, at("2026-10-01T00:00:00Z")).map(iso), [
    "2026-10-12T10:00:00.000Z",
    "2026-11-09T10:00:00.000Z",
  ]);
  // Last Friday of the month
  assert.equal(iso(new Cron("0 17 * * 5L").next(at("2026-10-01T00:00:00Z"))), "2026-10-30T17:00:00.000Z");
});

test("time zones without DST (Asia/Kolkata, UTC+5:30)", () => {
  const c = new Cron("0 9 * * MON-FRI", { timeZone: "Asia/Kolkata" });
  assert.equal(iso(c.next(at("2026-10-01T00:00:00Z"))), "2026-10-01T03:30:00.000Z");
  assert.equal(iso(c.next(at("2026-10-02T04:00:00Z"))), "2026-10-05T03:30:00.000Z"); // skips the weekend
});

test("DST spring forward: nonexistent wall times are skipped", () => {
  // New York jumps from 02:00 to 03:00 on 2026-03-08
  const c = new Cron("30 2 * * *", { timeZone: "America/New_York" });
  assert.deepEqual(c.nextN(2, at("2026-03-07T12:00:00Z")).map(iso), [
    "2026-03-09T06:30:00.000Z", // the 8th has no 02:30
    "2026-03-10T06:30:00.000Z",
  ]);
  // A job every 30 minutes keeps its local cadence across the jump
  const every = new Cron("*/30 * * * *", { timeZone: "America/New_York" });
  assert.deepEqual(every.nextN(3, at("2026-03-08T06:15:00Z")).map(iso), [
    "2026-03-08T06:30:00.000Z", // 01:30 EST
    "2026-03-08T07:00:00.000Z", // 03:00 EDT
    "2026-03-08T07:30:00.000Z",
  ]);
});

test("DST fall back: repeated hour runs once", () => {
  // 01:30 happens twice in New York on 2026-11-01; run at the first one only.
  const c = new Cron("30 1 * * *", { timeZone: "America/New_York" });
  assert.deepEqual(c.nextN(2, at("2026-10-31T12:00:00Z")).map(iso), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
});

test("between and matches", () => {
  const c = new Cron("0 */6 * * *");
  const runs = [...c.between(at("2026-10-01T00:00:00Z"), at("2026-10-02T00:00:00Z"))].map(iso);
  assert.deepEqual(runs, ["2026-10-01T06:00:00.000Z", "2026-10-01T12:00:00.000Z", "2026-10-01T18:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
  assert.equal(c.matches(at("2026-10-01T12:00:00Z")), true);
  assert.equal(c.matches(at("2026-10-01T12:01:00Z")), false);
});

test("human descriptions", () => {
  assert.equal(describe("* * * * *"), "Every minute");
  assert.equal(describe("*/5 * * * *"), "Every 5 minutes");
  assert.equal(describe("0 * * * *"), "Every hour");
  assert.equal(describe("30 9 * * 1-5"), "At 09:30, Monday through Friday");
  assert.equal(describe("0 9,18 * * SAT,SUN"), "At 09:00, 18:00, Sunday and Saturday");
  assert.equal(describe("0 0 1 */3 *"), "At 00:00, on day 1 of the month, in January, April, July and October");
  assert.equal(describe("0 18 L * *"), "At 18:00, on the last day of the month");
  assert.equal(describe("0 10 * * MON#2"), "At 10:00, on the second Monday");
  assert.equal(describe("0 */4 * * *"), "At minute 0 past every 4 hours");
});

test("scheduler fires and stops", async () => {
  const fired: Date[] = [];
  const job = schedule("* * * * * *", (d) => {
    fired.push(d);
  });
  await new Promise((r) => setTimeout(r, 2200));
  job.stop();
  const count = fired.length;
  assert.ok(count >= 1 && count <= 3, `fired ${count} times`);
  assert.ok(fired.every((d) => d.getMilliseconds() === 0));
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(fired.length, count, "no runs after stop()");
});
