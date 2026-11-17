import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, commitField, openStudio, projectRevision, runtimeState, waitForRuntimeAfter, resetProject, type Snapshot } from "./helpers.ts";
import { castOperations, FLOOR, LEDGE_TOP } from "./primitiveCast.ts";

/** Play with `seed` and sample the runtime every frame-ish for `ms`, inside the page. */
const playAndSample = (page: Page, seed: number, ms: number) =>
  page.evaluate(
    async ({ seed, ms }) => {
      await window.studio!.play(seed);
      const samples: Snapshot[] = [];
      const start = performance.now();
      while (performance.now() - start < ms) {
        samples.push((await window.studio!.getRuntimeState()) as Snapshot);
        await new Promise((r) => setTimeout(r, 30));
      }
      window.studio!.stop();
      return samples;
    },
    { seed, ms },
  );

test.afterEach(({ page }) => resetProject(page));

test("every new action and condition runs in the browser build", async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors = collectConsoleErrors(page);
  const r0 = await openStudio(page);
  const status = page.getByTestId("runtime-status");

  const created = await page.request.post("/api/batch", { data: { baseRevision: r0, operations: castOperations() } });
  expect(created.ok(), await created.text()).toBe(true);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 1);

  const samples = await playAndSample(page, 5, 2500);
  await expect(status).toHaveText("Editing");
  const track = (spawnId: string) => samples.map((s) => s.entities.find((e) => e.spawnId === spawnId)!);
  const last = (spawnId: string) => track(spawnId).at(-1)!;

  const hopper = track("hopper_1");
  expect(Math.min(...hopper.map((e) => e.y))).toBeLessThan(FLOOR - 105);
  expect(last("hopper_1")).toMatchObject({ behaviorState: "landed" });
  expect(Math.abs(last("hopper_1").x - 1200)).toBeLessThan(10);

  expect(last("coward_1").x).toBeGreaterThan(900);
  expect(Math.abs(last("chaser_1").x - 300 - 150)).toBeLessThan(8);
  expect(last("homebody_1").behaviorState).toBe("home");
  expect(Math.abs(last("homebody_1").x - 1300)).toBeLessThanOrEqual(4);

  const guardStates = new Set(track("guard_1").map((e) => e.behaviorState));
  expect(guardStates).toEqual(new Set(["fall", "landed", "rest"]));

  const sensed = Object.fromEntries(
    ["high", "level", "even", "uneven", "facer", "front", "seer", "blind", "edge", "dropper"].map((id) => [id, last(`${id}_1`).behaviorState]),
  );
  expect(sensed).toEqual({ high: "yes", level: "idle", even: "yes", uneven: "idle", facer: "yes", front: "idle", seer: "yes", blind: "idle", edge: "stop", dropper: "down" });
  expect(last("edge_1").y).toBeCloseTo(LEDGE_TOP, 0);

  const flips = async (seed: number) => {
    const run = await playAndSample(page, seed, 300);
    await expect(status).toHaveText("Editing");
    return Array.from({ length: 12 }, (_, i) => run.at(-1)!.entities.find((e) => e.spawnId === `coin_${i + 1}`)!.behaviorState);
  };
  const first = await flips(11);
  expect(await flips(11)).toEqual(first);
  expect(await flips(12)).not.toEqual(first);
  expect(new Set(first)).toEqual(new Set(["heads", "tails"]));

  expect(consoleErrors).toEqual([]);
});

test("the starter Charger ignores a player on the ledge above, and its `and` condition is editable", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  const status = page.getByTestId("runtime-status");
  const movePlayer = async (x: number, y: number) => {
    const base = await projectRevision(page);
    const moved = await page.request.post("/api/ops", { data: { name: "setPlaytest", input: { x, y }, baseRevision: base } });
    expect(moved.ok()).toBe(true);
    await waitForRuntimeAfter(page, base);
  };
  const chargerStates = async () => {
    const samples = await playAndSample(page, 1, 2000);
    await expect(status).toHaveText("Editing");
    return new Set(samples.map((s) => s.entities.find((e) => e.spawnId === "charger_1")!.behaviorState));
  };

  await movePlayer(490, LEDGE_TOP);
  expect(await chargerStates()).toEqual(new Set(["patrol"]));
  await movePlayer(420, FLOOR);
  expect(await chargerStates()).toContain("windup");

  await page.getByTestId("character-charger").click();
  const margin = page.getByLabel("patrol to windup playerLevel margin");
  await expect(margin).toHaveValue("60");
  await commitField(page, margin, "200");
  await movePlayer(490, LEDGE_TOP);
  expect(await chargerStates()).toContain("windup");

  expect(consoleErrors).toEqual([]);
});
