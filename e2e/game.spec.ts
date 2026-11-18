import { expect, test } from "@playwright/test";
import { collectConsoleErrors, loadExample, openStudio, resetProject, runtimeState } from "./helpers.ts";

test.afterEach(async ({ page }) => resetProject(page));

const project = (page: import("@playwright/test").Page) => page.evaluate(() => window.studio!.getProject());

test("Game tab: rules are presets, and a game handler built in the editor runs in play", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Game" }).click();
  const panel = page.getByTestId("game-panel");

  await panel.getByLabel("On death, back to").selectOption("checkpoint");
  await expect.poll(async () => (await project(page)).world.rules.onDeath).toBe("checkpoint");

  // + Handler starts as "on gameStarted do setFlag flag_name"; rename the flag.
  await panel.getByRole("button", { name: "+ Handler" }).click();
  await expect.poll(async () => (await project(page)).world.handlers).toHaveLength(1);
  const flag = panel.getByLabel("world 0 effect 0 flag");
  await flag.fill("began");
  await flag.press("Enter");
  await expect.poll(async () => (await project(page)).world.handlers[0]).toEqual({ on: { type: "gameStarted" }, when: [], do: [{ type: "setFlag", flag: "began", value: true }] });

  // A condition that never holds blocks a second handler.
  await panel.getByRole("button", { name: "+ Handler" }).click();
  await expect.poll(async () => (await project(page)).world.handlers).toHaveLength(2);
  await panel.getByLabel("world 1 effect 0 flag").fill("blocked");
  await panel.getByLabel("world 1 effect 0 flag").press("Enter");
  await panel.getByRole("button", { name: "add world 1 condition" }).click();
  await panel.getByLabel("world 1 condition 0 flag").fill("never_set");
  await panel.getByLabel("world 1 condition 0 flag").press("Enter");
  await expect.poll(async () => (await project(page)).world.handlers[1]?.when).toEqual([{ type: "flag", flag: "never_set", is: true }]);

  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).flags).toEqual(["began"]);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  expect((await runtimeState(page)).flags).toEqual([]);

  // Rooms have their own handlers.
  await page.getByRole("tab", { name: "Rooms" }).click();
  await expect(page.getByTestId("handlers-room arena")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("Load the example game loads it, and ▶ Play starts it on its title", async ({ page }) => {
  await openStudio(page);
  await loadExample(page);
  await expect.poll(async () => (await project(page)).world.rooms.map((r) => r.id)).toContain("summit");
  await expect.poll(async () => (await runtimeState(page)).room).toBe("entrance");
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).modal).toBe("title");
  await page.getByRole("button", { name: "■ Stop" }).click();
});
