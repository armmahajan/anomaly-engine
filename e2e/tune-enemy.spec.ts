import { expect, test } from "@playwright/test";
import { collectConsoleErrors, entity, patrolSpeedField, openStudio, runtimeState, setPatrolSpeed } from "./helpers.ts";

// The first acceptance test: tune the enemy in the studio, playtest,
// stop, tune again, all against the real Godot runtime in the browser.

test("tune the enemy, playtest, reset, tune again", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);

  const r0 = await openStudio(page);
  const status = page.getByTestId("runtime-status");

  // Edit while stopped -> runtime rebuilds the scene from the new revision.
  await setPatrolSpeed(page, "300");
  await expect(page.getByText(`rev ${r0 + 1}`)).toBeVisible();
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 1);

  // In edit mode the world is frozen.
  const frozen = await entity(page, "crawler");
  await page.waitForTimeout(300);
  expect((await entity(page, "crawler")).x).toBe(frozen.x);
  await page.screenshot({ path: "test-results/1-edit-mode.png" });

  // Play: the enemy patrols at the new speed.
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(status).toHaveText("Playing");
  await expect.poll(async () => Math.abs((await entity(page, "crawler")).velocityX)).toBe(300);
  const a = await entity(page, "crawler");
  await page.waitForTimeout(400);
  const b = await entity(page, "crawler");
  expect(Math.abs(b.x - a.x)).toBeGreaterThan(50);

  // The player responds to the keyboard inside the iframe.
  const start = await entity(page, "player");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(400);
  await page.keyboard.up("ArrowRight");
  expect((await entity(page, "player")).x).toBeGreaterThan(start.x + 50);
  await page.keyboard.down("Space");
  await expect.poll(async () => (await entity(page, "player")).y, { timeout: 2000 }).toBeLessThan(start.y - 40);
  await page.keyboard.up("Space");
  await page.screenshot({ path: "test-results/2-playing.png" });

  // No edits while playing, from the UI or the API.
  await expect(patrolSpeedField(page)).toBeDisabled();
  const locked = await page.evaluate(() =>
    window.studio!.applyOperation("updateBehavior", { characterId: "crawler", stateId: "patrol", action: { speed: 10 } }),
  );
  expect(locked).toMatchObject({ ok: false, error: { code: "locked" } });

  // Stop resets everything to spawn positions.
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(status).toHaveText("Editing");
  const reset = await runtimeState(page);
  expect(reset.mode).toBe("edit");
  expect(reset.entities.find((e) => e.characterId === "player")).toMatchObject({ x: 160, y: 660 });
  expect(reset.entities.find((e) => e.characterId === "crawler")).toMatchObject({ x: 1150, y: 660 });
  expect(reset.entities.find((e) => e.characterId === "charger")).toMatchObject({ x: 640, behaviorState: "patrol" });

  // Invalid values are rejected; project and game keep the last valid value.
  await setPatrolSpeed(page, "-5");
  await expect(page.getByRole("alert")).toContainText(">=0");
  await setPatrolSpeed(page, "fast");
  await expect(page.getByRole("alert")).toHaveText("Enter a number");
  await expect(page.getByText(`rev ${r0 + 1}`)).toBeVisible();
  expect((await runtimeState(page)).revision).toBe(r0 + 1);
  await page.screenshot({ path: "test-results/3-invalid.png" });

  // Second change, no rebuild or reload.
  await setPatrolSpeed(page, "80");
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 2);

  // The API rejects garbage without breaking anything.
  const bad = await page.evaluate(() => window.studio!.updateCharacter({ nope: true }));
  expect(bad).toMatchObject({ ok: false, error: { code: "invalid_input" } });

  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect.poll(async () => Math.abs((await entity(page, "crawler")).velocityX)).toBe(80);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(status).toHaveText("Editing");

  expect(consoleErrors).toEqual([]);
});
