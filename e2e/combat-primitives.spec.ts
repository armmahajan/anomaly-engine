import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject, runtimeState, waitForRuntimeAfter } from "./helpers.ts";

test.afterEach(({ page }) => resetProject(page));

const project = (page: Page) => page.evaluate(() => window.studio!.getProject());
const spawn = async (page: Page, id: string) => (await project(page)).world.rooms[0]!.spawns.find((s) => s.id === id)!;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a spawn's health bar and kill handler, set in Rooms, show and run in play", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  // A one-hit crawler standing near the player; no charger in the way.
  const base = await projectRevision(page);
  const res = await page.request.post("/api/batch", {
    data: {
      baseRevision: base,
      operations: [
        { name: "removeRoomSpawn", input: { roomId: "arena", spawnId: "charger_1" } },
        { name: "moveRoomSpawn", input: { roomId: "arena", spawnId: "crawler_1", x: 300 } },
        { name: "updateCharacter", input: { characterId: "crawler", changes: { stats: { health: 1 } } } },
        { name: "updateBehavior", input: { characterId: "crawler", stateId: "patrol", action: { speed: 0 } } },
      ],
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await waitForRuntimeAfter(page, base);

  await page.getByRole("tab", { name: "Rooms" }).click();
  const details = page.getByTestId("spawn-details-crawler_1");
  await details.locator("summary").click();
  await details.getByLabel("crawler_1 health bar", { exact: true }).click(); // checked once the server accepts it
  await expect.poll(async () => (await spawn(page, "crawler_1")).healthBar).toEqual({ title: "Crawler" });
  const title = details.getByLabel("crawler_1 health bar title");
  await title.fill("The Crawler");
  await title.press("Enter");
  await expect.poll(async () => (await spawn(page, "crawler_1")).healthBar).toEqual({ title: "The Crawler" });

  // + Handler on a spawn starts as "on enemyKilled do setFlag flag_name".
  await details.getByRole("button", { name: "+ Handler" }).click();
  await expect.poll(async () => (await spawn(page, "crawler_1")).handlers).toHaveLength(1);
  const flag = details.getByLabel("crawler_1 0 effect 0 flag");
  await flag.fill("crawler_down");
  await flag.press("Enter");
  await details.getByRole("button", { name: "add crawler_1 0 effect" }).click();
  await expect.poll(async () => (await spawn(page, "crawler_1")).handlers[0]?.do).toHaveLength(2);
  await details.getByLabel("crawler_1 0 effect 1", { exact: true }).selectOption("shake");
  await expect.poll(async () => (await spawn(page, "crawler_1")).handlers[0]).toEqual({
    on: { type: "enemyKilled" },
    when: [],
    do: [
      { type: "setFlag", flag: "crawler_down", value: true },
      { type: "shake", strength: 8, seconds: 0.3 },
    ],
  });

  await page.getByRole("button", { name: "▶ Play", exact: true }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).healthBars).toEqual(["crawler_1"]);
  await page.screenshot({ path: "test-results/combat-primitives-1-health-bar.png" });

  // Walk up to it and swing until it dies.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await runtimeState(page);
    const crawler = state.entities.find((e) => e.spawnId === "crawler_1")!;
    const player = state.entities.find((e) => e.spawnId === "player")!;
    if (crawler.health === 0 || Date.now() > deadline) break;
    if (crawler.x - player.x > 80) {
      await page.keyboard.down("ArrowRight");
      await pause(60);
      await page.keyboard.up("ArrowRight");
    } else {
      await page.keyboard.down("KeyX");
      await pause(40);
      await page.keyboard.up("KeyX");
      await pause(380);
    }
  }
  await expect.poll(async () => (await runtimeState(page)).flags).toEqual(["crawler_down"]);
  expect((await runtimeState(page)).healthBars).toEqual([]);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  expect(consoleErrors).toEqual([]);
});
