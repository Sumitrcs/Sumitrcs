// Binary min-heap keyed by a numeric priority. Ties are broken by insertion
// order so the search is deterministic (and so the visualisation looks the
// same every time).
export class MinHeap {
  constructor() {
    this.items = [];
    this.seq = 0;
  }

  get size() {
    return this.items.length;
  }

  push(value, priority) {
    this.items.push({ value, priority, seq: this.seq++ });
    this.#up(this.items.length - 1);
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      this.items[0] = last;
      this.#down(0);
    }
    return top?.value;
  }

  #less(a, b) {
    const x = this.items[a];
    const y = this.items[b];
    return x.priority < y.priority || (x.priority === y.priority && x.seq < y.seq);
  }

  #swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
  }

  #up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(i, p)) break;
      this.#swap(i, p);
      i = p;
    }
  }

  #down(i) {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.items.length && this.#less(l, m)) m = l;
      if (r < this.items.length && this.#less(r, m)) m = r;
      if (m === i) return;
      this.#swap(i, m);
      i = m;
    }
  }
}
