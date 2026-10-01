import { Cron, type CronOptions } from "./cron.ts";

// setTimeout overflows above 2^31-1 ms (~24.8 days); longer waits are chained.
const MAX_TIMEOUT = 2_147_483_647;

export interface JobOptions extends CronOptions {
  /** Skip a run if the previous one (async) hasn't finished. Default true. */
  preventOverlap?: boolean;
  onError?: (err: unknown) => void;
}

export interface Job {
  readonly cron: Cron;
  nextRun(): Date | null;
  stop(): void;
  readonly running: boolean;
}

export function schedule(expression: string, task: (scheduledAt: Date) => unknown, options: JobOptions = {}): Job {
  const cron = new Cron(expression, options);
  const preventOverlap = options.preventOverlap ?? true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let busy = false;
  let upcoming: Date | null = null;

  const arm = (after: number) => {
    if (stopped) return;
    upcoming = cron.next(after);
    if (!upcoming) return;
    const wait = () => {
      const delay = upcoming!.getTime() - Date.now();
      if (delay > MAX_TIMEOUT) {
        timer = setTimeout(wait, MAX_TIMEOUT);
      } else {
        timer = setTimeout(fire, Math.max(0, delay));
      }
    };
    wait();
  };

  const fire = async () => {
    const at = upcoming!;
    arm(at.getTime()); // schedule the next run first, so a slow task can't delay it
    if (busy && preventOverlap) return;
    busy = true;
    try {
      await task(at);
    } catch (err) {
      options.onError ? options.onError(err) : console.error(`[cronkit] job '${expression}' failed:`, err);
    } finally {
      busy = false;
    }
  };

  arm(Date.now());
  return {
    cron,
    nextRun: () => upcoming,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    get running() {
      return busy;
    },
  };
}
