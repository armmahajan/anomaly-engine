/**
 * A small pool of render pages (or anything costly to open): at most `max`
 * exist, each used by one request at a time. A request takes a free one, opens
 * a new one while there are fewer than `max`, or waits for one in order. A
 * page that fails to open is dropped (the next waiter gets a fresh one).
 */

interface Slot<T> {
  item: Promise<T>;
  busy: boolean;
}

export class PagePool<T> {
  private slots: Slot<T>[] = [];
  private waiters: { resolve: (slot: Slot<T>) => void; reject: (error: Error) => void }[] = [];
  private readonly create: () => Promise<T>;
  readonly max: number;

  constructor(create: () => Promise<T>, max: number) {
    this.create = create;
    this.max = Math.max(1, Math.floor(max));
  }

  /** Pages open (or opening). */
  get size(): number {
    return this.slots.length;
  }

  /** Pages in use. */
  get busy(): number {
    return this.slots.filter((s) => s.busy).length;
  }

  /** Requests waiting for a page. */
  get waiting(): number {
    return this.waiters.length;
  }

  async use<R>(work: (item: T) => Promise<R>): Promise<R> {
    const slot = await this.acquire();
    let item: T;
    try {
      item = await slot.item;
    } catch (error) {
      this.drop(slot);
      throw error;
    }
    try {
      return await work(item);
    } finally {
      this.release(slot);
    }
  }

  /** Forget every page (their browser is closing); waiting requests fail. Returns the pages that were open. */
  clear(): Promise<T>[] {
    const items = this.slots.map((s) => s.item);
    this.slots = [];
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(new Error("the renderer closed"));
    return items;
  }

  private acquire(): Promise<Slot<T>> {
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    if (this.slots.length < this.max) return Promise.resolve(this.grow());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private grow(): Slot<T> {
    const slot: Slot<T> = { item: this.create(), busy: true };
    slot.item.catch(() => {}); // the request that opened it reports the failure
    this.slots.push(slot);
    return slot;
  }

  private release(slot: Slot<T>): void {
    if (!this.slots.includes(slot)) return; // cleared meanwhile
    const next = this.waiters.shift();
    if (next) next.resolve(slot); // handed over still busy
    else slot.busy = false;
  }

  private drop(slot: Slot<T>): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    this.slots.splice(i, 1);
    const next = this.waiters.shift();
    if (next) next.resolve(this.grow());
  }
}
