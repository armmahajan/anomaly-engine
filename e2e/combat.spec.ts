import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, commitField, openStudio, projectRevision, runtimeState, waitForRuntimeAfter, type Snapshot } from "./helpers.ts";

const FLOOR = 660;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const find = (s: Snapshot, spawnId: string) => s.entities.find((e) => e.spawnId === spawnId)!;

async function api(page: Page, operations: object[]) {
  const base = await projectRevision(page);
  const res = await page.request.post("/api/batch", { data: { baseRevision: base, operations } });
  expect(res.ok(), await res.text()).toBe(true);
  await waitForRuntimeAfter(page, base);
}

test.afterEach(async ({ page }) => {
  await page.request.post("/api/reset", { data: { baseRevision: await projectRevision(page) } });
});

async function play(page: Page) {
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
}

async function stop(page: Page) {
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
}

/** Sample the runtime in the page every ~30ms until `ms` has passed. */
const sample = (page: Page, ms: number) =>
  page.evaluate(async (ms) => {
    const out = [];
    const start = performance.now();
    while (performance.now() - start < ms) {
      out.push(await window.studio!.getRuntimeState());
      await new Promise((r) => setTimeout(r, 30));
    }
    return out;
  }, ms) as Promise<Snapshot[]>;

const tap = async (page: Page, key: string, ms = 40) => {
  await page.keyboard.down(key);
  await pause(ms);
  await page.keyboard.up(key);
};

test("fight the starter Charger with the sword until it dies", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByTestId("character-charger").click();
  await expect(page.getByLabel("Health")).toHaveValue("4");
  await expect(page.getByLabel("Contact damage")).toHaveValue("1");
  // Hold the windup so the fight is about the sword, not dodging.
  await api(page, [{ name: "updateBehavior", input: { characterId: "charger", stateId: "windup", transitions: [{ index: 0, when: { seconds: 30 } }] } }]);

  await play(page);
  const healths: number[] = [];
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = await runtimeState(page);
    const player = find(state, "player_1");
    const charger = find(state, "charger_1");
    healths.push(charger.health);
    if (charger.health === 0 || Date.now() > deadline) break;
    const gap = charger.x - player.x;
    if (gap > 85) await tap(page, "ArrowRight", Math.max(30, ((gap - 60) / 320) * 1000));
    else {
      await tap(page, "KeyX");
      await pause(380);
    }
  }
  expect(healths.at(-1)).toBe(0);
  expect([...new Set(healths)]).toEqual([4, 3, 2, 1, 0]);
  await page.screenshot({ path: "test-results/combat-1-charger-dead.png" });
  await stop(page);
  expect(consoleErrors).toEqual([]);
});

test("up swing, pogo off an enemy, player health and the restart on death", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByTestId("character-player").click();
  await expect(page.getByLabel("Health")).toHaveValue("5");
  await commitField(page, page.getByLabel("Attack cooldown"), "0.1");

  const wait = { type: "wait" };
  const enemy = (id: string, movement: string, stats: object, states: object = { idle: { action: wait, transitions: [] } }) => ({
    id,
    kind: "enemy",
    name: id,
    color: "#a05050",
    size: { width: 32, height: 32 },
    movement,
    stats: { knockback: 0, contactDamage: 0, ...stats },
    behavior: { initial: "idle", states },
  });
  const flinchThenEnrage = {
    idle: {
      action: wait,
      transitions: [
        { when: { type: "healthBelow", fraction: 0.6 }, to: "enraged" },
        { when: { type: "wasHit" }, to: "flinch" },
      ],
    },
    flinch: { action: wait, transitions: [{ when: { type: "after", seconds: 0.2 }, to: "idle" }] },
    enraged: { action: wait, transitions: [] },
  };
  await api(page, [
    { name: "removeSpawn", input: { spawnId: "charger_1" } },
    { name: "removeSpawn", input: { spawnId: "crawler_1" } },
    { name: "createCharacter", input: { character: enemy("sword_bat", "flying", { health: 1 }) } },
    { name: "addSpawn", input: { characterId: "sword_bat", spawnId: "sword_bat_1", x: 160, y: 600 } },
    { name: "createCharacter", input: { character: enemy("sword_dummy", "ground", { health: 4 }, flinchThenEnrage) } },
    { name: "addSpawn", input: { characterId: "sword_dummy", spawnId: "sword_dummy_1", x: 700, y: FLOOR } },
  ]);

  // Up swing: the bat hovering just overhead dies.
  await play(page);
  await page.keyboard.down("ArrowUp");
  await tap(page, "KeyX");
  await page.keyboard.up("ArrowUp");
  await expect.poll(async () => find(await runtimeState(page), "sword_bat_1").health).toBe(0);
  await stop(page);

  // Pogo: drop onto the dummy holding down and swinging; each hit bounces the player up.
  // The dummy flinches on the first hit (wasHit) and enrages below 60% health (healthBelow).
  await api(page, [{ name: "moveSpawn", input: { spawnId: "player_1", x: 700, y: 250 } }]);
  await play(page);
  await page.keyboard.down("ArrowDown");
  const sampling = sample(page, 2600);
  for (let i = 0; i < 24; i++) {
    await tap(page, "KeyX", 30);
    await pause(30);
  }
  await page.keyboard.up("ArrowDown");
  const samples = await sampling;
  const hitAt = samples.findIndex((s) => find(s, "sword_dummy_1").health < 4);
  expect(hitAt).toBeGreaterThan(0);
  const playerYs = samples.slice(hitAt).map((s) => find(s, "player_1").y);
  expect(Math.min(...playerYs)).toBeLessThan(playerYs[0]! - 50);
  expect(samples.some((s) => find(s, "player_1").behaviorState === "slash_down")).toBe(true);
  const dummyStates = samples.map((s) => find(s, "sword_dummy_1").behaviorState);
  expect(dummyStates).toContain("flinch");
  expect(dummyStates.at(-1)).toBe("enraged");
  await page.screenshot({ path: "test-results/combat-2-pogo.png" });
  await stop(page);

  // Health: one touch of a damaging enemy kills a 1-health player; the run restarts at full health.
  await api(page, [
    { name: "updateCharacter", input: { characterId: "player", changes: { stats: { health: 1 } } } },
    { name: "updateCharacter", input: { characterId: "sword_dummy", changes: { stats: { contactDamage: 1 } } } },
  ]);
  await play(page);
  await expect.poll(async () => (await runtimeState(page)).deaths, { timeout: 5000 }).toBeGreaterThan(0);
  const restarted = find(await runtimeState(page), "player_1");
  expect(restarted.health).toBe(1);
  expect(restarted.y).toBeLessThan(FLOOR - 50);
  await stop(page);
  expect((await runtimeState(page)).deaths).toBe(0);
  expect(consoleErrors).toEqual([]);
});
