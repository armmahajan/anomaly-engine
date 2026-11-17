import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, runtimeState } from "./helpers.ts";

// The studio's modes: one window, the game runtime stays mounted and is
// switched between stages; panels resize and collapse.

test("modes switch the runtime's stage, stop playtests, and keep the layout adjustable", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  const stage = async () => (await runtimeState(page)).stage;
  await expect.poll(stage).toBe("game");

  // Characters mode: the runtime shows one character on its own stage; the art controls are in the sidebar.
  await page.getByTestId("character-charger").click();
  await page.getByRole("tab", { name: "Characters" }).click();
  await expect.poll(stage).toBe("character");
  await expect(page.getByTestId("art-panel")).toBeVisible();

  // Entering a workbench mode stops a playtest; Play brings the arena back.
  await page.getByRole("tab", { name: "Playtest" }).click();
  await expect.poll(stage).toBe("game");
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await page.getByRole("tab", { name: "Characters" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  await expect.poll(stage).toBe("character");
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("tab", { name: "Playtest" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(stage).toBe("game");
  await page.getByRole("button", { name: "■ Stop" }).click();

  // The chat collapses to a strip and back.
  await page.getByRole("button", { name: "Collapse chat" }).click();
  await expect(page.getByLabel("Message")).toHaveCount(0);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByLabel("Message")).toBeVisible();

  // The sidebar resizes by dragging its left edge, and remembers it.
  const sidebar = page.locator(".sidebar");
  const before = (await sidebar.boundingBox())!.width;
  const handle = (await page.locator(".side-resize").boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 120, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(before + 100);
  await page.reload();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing", { timeout: 30_000 });
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(before + 100);

  expect(consoleErrors).toEqual([]);
});
