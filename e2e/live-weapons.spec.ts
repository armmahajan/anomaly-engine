import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, resetProject } from "./helpers.ts";

// Weapons from the wiki (packages/server/src/live): the director's weapon page becomes a game weapon, linked to
// the page, with attacks the build assistant writes from it, in the background.

test.afterEach(async ({ page }) => {
  await page.context().request.post("/api/live", { data: { cast: false, rooms: false } });
  await resetProject(page);
});

test("the director drafts a weapon page: it becomes a weapon in the project, with attacks, and the live menu says so", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.evaluate(() => window.studio!.setLive({ cast: true }));
  await expect(page.getByTestId("live-status")).toContainText("Auto-build on");

  await page.getByRole("tab", { name: "Wiki" }).click();
  await page.getByLabel("Message").fill("Draft the hero's weapon.");
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByTestId("chat-reply").last()).toContainText("Drafted the Ember Hook.");
  await expect(page.getByTestId("wiki-page-ember_hook")).toBeVisible();

  // A moment later the weapon is in the project, linked to its page, with the attacks written from it.
  await expect
    .poll(async () => page.evaluate(() => window.studio!.getProject().weapons.list.find((w) => w.id === "ember_hook")?.attacks.map((a) => a.id) ?? []), { timeout: 30_000 })
    .toEqual(["sweep", "jab"]);
  const project = await page.evaluate(() => window.studio!.getProject());
  expect(project.weapons.list.find((w) => w.id === "ember_hook")).toMatchObject({ name: "Ember Hook", description: "A lamplighter's hook, still warm.", art: { brief: "a brass hook glowing at the tip" } });
  expect(project.wiki.pages.find((p) => p.id === "ember_hook")).toMatchObject({ weaponId: "ember_hook" });
  expect(project.characters.some((c) => c.id === "ember_hook")).toBe(false);

  await page.getByTestId("live-status").getByRole("button").click();
  await expect(page.getByRole("dialog", { name: "Auto-build" })).toContainText("made the weapon(s) ember_hook");

  expect(consoleErrors).toEqual([]);
});
