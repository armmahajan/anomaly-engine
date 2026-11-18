import { expect, test } from "@playwright/test";
import { collectConsoleErrors, entity, openStudio, projectRevision, resetProject, runtimeState } from "./helpers.ts";

test.afterEach(({ page }) => resetProject(page));

test("the creator rebinds jump on the Controls page; the playtest jumps on the new key only", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Game" }).click();
  const controls = page.getByTestId("controls-settings");
  const message = page.getByTestId("controls-message");
  await expect(page.getByTestId("control-jump")).toContainText("Space");

  // Change ▸ press L: Jump is now L only (one undoable edit).
  const before = await projectRevision(page);
  await controls.getByRole("button", { name: "Change Jump" }).click();
  await expect(message).toHaveText("Press a key for Jump…");
  await page.keyboard.press("l");
  await expect(message).toHaveText("Jump: L");
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
  await expect(page.getByTestId("control-jump").locator("kbd")).toHaveText(["L"]);
  // A key another action uses at the same time is refused, saying why.
  await controls.getByRole("button", { name: "Change Attack" }).click();
  await page.keyboard.press("l");
  await expect(message).toHaveText("L is already Jump's key. Give Jump another key first.");
  await expect(page.getByTestId("control-attack").locator("kbd")).toHaveText(["X", "J"]);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(before + 1);
  expect((await runtimeState(page)).controls).toMatchObject({ jump: ["L"], attack: ["X", "J"] });

  // Playtest: Space no longer jumps, L does.
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await entity(page, "player")).velocityY).toBe(0); // on the floor
  const start = await entity(page, "player");
  await page.keyboard.down("Space");
  await page.waitForTimeout(400);
  await page.keyboard.up("Space");
  expect((await entity(page, "player")).y).toBeCloseTo(start.y, 0);
  await page.keyboard.down("l");
  await expect.poll(async () => (await entity(page, "player")).y, { timeout: 2000 }).toBeLessThan(start.y - 40);
  await page.keyboard.up("l");
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");

  // Reset gives Jump its default keys back (Play opened the Playtest tab).
  await page.getByRole("tab", { name: "Game" }).click();
  await controls.getByRole("button", { name: "Reset Jump" }).click();
  await expect(page.getByTestId("control-jump").locator("kbd")).toHaveText(["Space", "Z"]);
  expect(consoleErrors).toEqual([]);
});
