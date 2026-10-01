# cronkit

[![CI](https://github.com/Sumitrcs/cronkit/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/cronkit/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A dependency-free **cron expression parser and scheduler** for Node.js,
written in TypeScript — with the edge cases most libraries get wrong
handled and tested.

```ts
import { Cron, describe, schedule } from "cronkit";

const cron = new Cron("0 9 * * MON-FRI", { timeZone: "Asia/Kolkata" });
cron.next();                  // next 09:00 IST on a weekday
cron.nextN(5);                // next five runs
describe("0 9 * * MON-FRI");  // "At 09:00, Monday through Friday"

const job = schedule("*/30 * * * *", async (at) => {
  await sendReminders(at);
}, { timeZone: "Asia/Kolkata" });
job.stop();
```

```
$ cronkit "0 10 * * MON#2" --tz Asia/Kolkata -n 3
At 10:00, on the second Monday
Next 3 runs (Asia/Kolkata):
  Monday, 12 October 2026 at 10:00:00 GMT+5:30
  Monday, 9 November 2026 at 10:00:00 GMT+5:30
  Monday, 14 December 2026 at 10:00:00 GMT+5:30
```

## Syntax

```
┌───────────── second (0-59)        optional — 6-field form
│ ┌─────────── minute (0-59)
│ │ ┌───────── hour (0-23)
│ │ │ ┌─────── day of month (1-31, L = last day)
│ │ │ │ ┌───── month (1-12 or JAN-DEC)
│ │ │ │ │ ┌─── day of week (0-7 or SUN-SAT; 7 = Sunday; MON#2 = second Monday; 5L = last Friday)
* * * * * *
```

Lists `1,15`, ranges `9-17`, steps `*/15` and `5/20`, names, and the macros
`@yearly @monthly @weekly @daily @hourly` are supported.

## Correctness details

| Situation | Behaviour |
|---|---|
| Both day-of-month and day-of-week restricted | **OR**, like Vixie cron: `0 0 13 * FRI` runs every Friday *and* every 13th |
| `0 12 29 2 *` | finds the next leap year |
| `0 0 31 2 *` | returns `null` instead of looping forever |
| DST spring-forward | a wall time that doesn't exist (02:30 in New York on 8 March 2026) is skipped |
| DST fall-back | a repeated wall time (01:30 on 1 Nov 2026) runs **once**, at the first occurrence |
| Interval jobs across DST | `*/30` keeps its local-clock cadence: 01:30 EST → 03:00 EDT |
| Waits longer than 24.8 days | the scheduler chains timeouts (Node's `setTimeout` overflows at 2³¹−1 ms) |
| Slow async tasks | the next run is armed *before* the task starts; overlapping runs are skipped by default |

Time zone maths uses only `Intl.DateTimeFormat`: wall-clock fields are
searched directly (year → month → day → hour → minute → second, skipping
whole branches that can't match), then converted to an instant by trying the
zone offsets on either side of the date and verifying the round-trip.

## Tests

```bash
npm test
```

Requires Node.js 22.18+ (runs TypeScript directly).

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
