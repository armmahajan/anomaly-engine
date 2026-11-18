import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, resetProject } from "./helpers.ts";

test.afterEach(async ({ page }) => resetProject(page));

test("rename an enemy in place: the list and the inspector follow, Escape cancels, Undo restores", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByTestId("character-charger").click();
  const name = page.getByLabel("Character name");
  await expect(name).toHaveValue("Charger");

  await name.fill("Tide Ram");
  await name.press("Enter");
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().characters.find((c) => c.id === "charger")?.name)).toBe("Tide Ram");
  await expect(page.getByTestId("character-charger")).toContainText("Tide Ram");
  await expect(page.getByLabel("Character name")).toHaveValue("Tide Ram");

  // Escape reverts an edit without saving.
  await page.getByLabel("Character name").fill("Something else");
  await page.getByLabel("Character name").press("Escape");
  await expect(page.getByLabel("Character name")).toHaveValue("Tide Ram");

  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().characters.find((c) => c.id === "charger")?.name)).toBe("Charger");
  await expect(page.getByLabel("Character name")).toHaveValue("Charger");
  expect(consoleErrors).toEqual([]);
});
