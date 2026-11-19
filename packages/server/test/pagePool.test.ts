import { describe, expect, it } from "vitest";
import { PagePool } from "../src/art/pagePool.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("PagePool", () => {
  it("opens pages on demand up to the limit, gives each to one request at a time and queues the rest in order", async () => {
    let made = 0;
    const pool = new PagePool(async () => ({ page: ++made }), 2);
    const gates = [gate(), gate(), gate(), gate()];
    const used: number[][] = [];
    const work = (i: number) =>
      pool.use(async ({ page }) => {
        used.push([i, page]);
        await gates[i]!.opened;
        return i;
      });

    const runs = [work(0), work(1), work(2), work(3)];
    await tick();
    expect(made).toBe(2);
    expect(pool.size).toBe(2);
    expect(pool.busy).toBe(2);
    expect(pool.waiting).toBe(2);
    expect(used).toEqual([
      [0, 1],
      [1, 2],
    ]);

    // A freed page goes to the first waiting request.
    gates[1]!.open();
    await tick();
    expect(used.at(-1)).toEqual([2, 2]);
    gates[0]!.open();
    await tick();
    expect(used.at(-1)).toEqual([3, 1]);
    gates[2]!.open();
    gates[3]!.open();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(made).toBe(2);
    expect(pool.busy).toBe(0);
    expect(pool.waiting).toBe(0);

    // An idle page is reused.
    await pool.use(async () => {});
    expect(made).toBe(2);
  });

  it("a page that fails to open is dropped and the next request gets a fresh one", async () => {
    let attempts = 0;
    const pool = new PagePool(async () => {
      attempts++;
      if (attempts === 1) throw new Error("boot failed");
      return attempts;
    }, 1);
    const first = pool.use(async (n) => n);
    const second = pool.use(async (n) => n);
    await expect(first).rejects.toThrow("boot failed");
    expect(await second).toBe(2);
    expect(pool.size).toBe(1);
  });

  it("a failing request frees its page", async () => {
    const pool = new PagePool(async () => "page", 1);
    await expect(pool.use(async () => Promise.reject(new Error("render failed")))).rejects.toThrow("render failed");
    expect(await pool.use(async (p) => p)).toBe("page");
  });

  it("clear forgets the pages and fails the waiting requests", async () => {
    const pool = new PagePool(async () => "page", 1);
    const g = gate();
    const holding = pool.use(() => g.opened);
    const waiting = pool.use(async () => "never");
    await tick();
    expect(pool.clear()).toHaveLength(1);
    await expect(waiting).rejects.toThrow("the renderer closed");
    g.open();
    await holding;
    expect(pool.size).toBe(0);
  });
});
