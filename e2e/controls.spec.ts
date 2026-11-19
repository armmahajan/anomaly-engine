import { expect, test, type Page } from "@playwright/test";
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
  await expect(page.getByTestId("control-attack").locator("kbd")).toHaveText(["X", "J", "Left click"]);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(before + 1);
  // (The runtime reports its keyboard keys; mouse buttons are its own business.)
  expect((await runtimeState(page)).controls).toMatchObject({ jump: ["L"], attack: expect.arrayContaining(["X", "J"]) });

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

/** Browser context menus the page let through (counted from now). */
const countMenus = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { menusShown: number };
    w.menusShown = 0;
    window.addEventListener("contextmenu", (e) => void (e.defaultPrevented || w.menusShown++));
  });
const menusShown = (page: Page) => page.evaluate(() => (window as unknown as { menusShown: number }).menusShown);

test("a mouse button binds like a key; the game aims with the mouse or with keys only", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Game" }).click();
  const controls = page.getByTestId("controls-settings");
  const message = page.getByTestId("controls-message");
  const attack = page.getByTestId("control-attack");
  await expect(attack.locator("kbd")).toHaveText(["X", "J", "Left click"]);
  await countMenus(page);

  // Change ▸ right click on the waiting row: Attack is the right button only, with no browser menu.
  // Alt attack (unused by this game, so not listed) gives its right click up in the same undo step.
  const before = await projectRevision(page);
  await controls.getByRole("button", { name: "Change Attack" }).click();
  await attack.getByTestId("controls-capture").click({ button: "right" });
  await expect(message).toHaveText("Attack: Right click (taken from Alt attack, unused in this game)");
  await expect(attack.locator("kbd")).toHaveText(["Right click"]);
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
  expect(await menusShown(page)).toBe(0);
  expect(await page.evaluate(() => window.studio!.getProject().controls.bindings)).toMatchObject({ attack: ["MouseRight"], alt_attack: ["V", "N"] });
  // + Key ▸ left click adds the left button beside it.
  await controls.getByRole("button", { name: "Add a key to Attack" }).click();
  await attack.getByTestId("controls-capture").click();
  await expect(attack.locator("kbd")).toHaveText(["Right click", "Left click"]);

  // Aim: toward the mouse by default; Keys only and back, each an undoable edit.
  const mouse = controls.getByRole("radio", { name: "Mouse (toward the cursor; aim keys still work)" });
  const keysOnly = controls.getByRole("radio", { name: "Keys only" });
  await expect(mouse).toBeChecked();
  const aimed = await projectRevision(page);
  await keysOnly.click();
  await expect(message).toHaveText("Aim: with the aim keys only");
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().controls.aim)).toBe("keys");
  expect(await projectRevision(page)).toBe(aimed + 1);
  await page.getByRole("button", { name: /Undo/ }).click();
  await expect(mouse).toBeChecked();
  await keysOnly.click();
  await expect(keysOnly).toBeChecked();
  await mouse.click();
  await expect(message).toHaveText("Aim: toward the mouse (the aim keys still work)");
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().controls.aim)).toBe("mouse");

  // Right click over the game frame opens no browser menu either.
  const prevented = await page.frameLocator("iframe.game-frame").locator("body").evaluate((body) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  expect(consoleErrors).toEqual([]);
});
