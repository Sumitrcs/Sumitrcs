import { financialYear } from "./supply.ts";

export interface SeriesStore {
  /** Atomically increments and returns the next counter for a key. */
  next(key: string): number;
}

export class MemorySeriesStore implements SeriesStore {
  #counters = new Map<string, number>();
  next(key: string): number {
    const n = (this.#counters.get(key) ?? 0) + 1;
    this.#counters.set(key, n);
    return n;
  }
}

/**
 * Generates invoice numbers that reset every financial year.
 * Rule 46 of the CGST Rules caps invoice numbers at 16 characters
 * using only letters, digits, '-' and '/'.
 */
export class InvoiceNumberer {
  readonly prefix: string;
  readonly store: SeriesStore;
  readonly padding: number;

  constructor(prefix: string, store: SeriesStore = new MemorySeriesStore(), padding = 4) {
    if (!/^[A-Z0-9/-]*$/i.test(prefix)) throw new RangeError("Prefix may only contain letters, digits, '-' and '/'");
    this.prefix = prefix;
    this.store = store;
    this.padding = padding;
  }

  next(date = new Date()): string {
    const fy = financialYear(date);
    const n = this.store.next(`${this.prefix}|${fy}`);
    const number = `${this.prefix}${fy}/${String(n).padStart(this.padding, "0")}`;
    if (number.length > 16) throw new RangeError(`Invoice number '${number}' exceeds 16 characters`);
    return number;
  }
}
