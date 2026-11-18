import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, resetProject } from "./helpers.ts";

// The studio fills in as the creator designs (packages/server/src/live): the director's character pages
// become game characters with art, and its progression becomes rooms, in the background.

const setLive = (page: Page, settings: { cast?: boolean; rooms?: boolean }) => page.evaluate((s) => window.studio!.setLive(s), settings);

test.afterEach(async ({ page }) => {
  await page.context().request.post("/api/live", { data: { cast: false, rooms: false } });
  await resetProject(page);
});

test("the director drafts characters: they join the cast and get drawn while the creator keeps editing the wiki", async ({ page }) => {
  test.setTimeout(400_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await setLive(page, { cast: true });
  await expect(page.getByTestId("live-status")).toContainText("Auto-build on");
  const article = page.getByTestId("wiki-article");

  await page.getByRole("tab", { name: "Wiki" }).click();
  await page.getByLabel("Message").fill("Draft the cast: the lamplighter and what they fight.");
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByTestId("chat-reply").last()).toContainText("Drafted the Lamplighter, two enemies and the Old Sage.");

  // The pages link to their new characters a moment later; the story-only sage stays out of the game.
  await page.getByTestId("wiki-page-moth_knight").click();
  await expect(article.getByRole("button", { name: "Moth Knight →" })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("wiki-page-lamplighter").click();
  await expect(article.getByRole("button", { name: "The Lamplighter →" })).toBeVisible();

  // Art runs in the background: the creator keeps editing the wiki meanwhile (nothing is locked).
  await expect(page.getByTestId("live-status")).toContainText("drawing", { timeout: 30_000 });
  await expect(page.getByTestId("runtime-status")).not.toHaveText("AI is editing…");
  await page.getByTestId("wiki-page-old_sage").click();
  await article.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Summary").fill("Remembers the flood, and the bell before it.");
  await page.getByRole("button", { name: "Save as canon" }).click();
  await expect(article).toContainText("Remembers the flood, and the bell before it.");
  await expect(article.getByText("Canon", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "+ Page" }).click();
  await page.getByLabel("Title").fill("The Bell");
  await page.getByLabel("Body").fill("Guarded by [[moth_knight]].");
  await page.getByRole("button", { name: "Save as canon" }).click();
  await expect(article.getByRole("heading", { level: 1 })).toHaveText("The Bell");

  // On the Characters tab: the new enemies, each with its art progressing; the sage isn't there.
  await page.getByRole("tab", { name: "Characters" }).click();
  await expect(page.getByTestId("character-moth_knight")).toContainText("Moth Knight");
  await expect(page.getByTestId("character-lamp_grub")).toContainText("Lamp Grub");
  await expect(page.getByTestId("character-old_sage")).toHaveCount(0);
  await expect(page.getByTestId("character-player")).toContainText("The Lamplighter");
  // Each one's art lands in turn: its picture replaces the colored swatch in the list (a tag says what is being drawn meanwhile).
  for (const id of ["player", "moth_knight", "lamp_grub"]) {
    await expect(page.getByTestId(`character-${id}`).locator("img.swatch-img")).toBeVisible({ timeout: 120_000 });
  }
  await expect(page.locator("[data-testid^=character-work-]")).toHaveCount(0);
  // The new enemies have the behavior the build assistant wrote from their pages.
  const behavior = await page.evaluate(() => window.studio!.getProject().characters.find((c) => c.id === "moth_knight"));
  expect(behavior).toMatchObject({ behavior: { initial: "prowl" }, size: { width: 40, height: 36 } });

  expect(consoleErrors).toEqual([]);
});

test("the director drafts the progression: rooms for its regions appear on the Rooms tab", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await setLive(page, { rooms: true });

  await page.getByRole("tab", { name: /Progression/ }).click();
  await page.getByLabel("Message").fill("Design the structure: four regions, two abilities.");
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByTestId("chat-reply").last()).toContainText("Should the Lamp Key come from a boss instead?");

  await page.getByRole("tab", { name: "Rooms" }).click();
  await expect(page.getByTestId("room-gate_1")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("rooms-live")).toContainText(/built \d+ of \d+ room\(s\) from the progression/);
  for (const id of ["gate_1", "city_1", "tower_1", "deep_1"]) await expect(page.getByTestId(`room-${id}`)).toBeVisible();
  await expect(page.getByTestId("room-gate_1")).toContainText("start");
  // The rooms are the Architect's plan, its own stages still to run.
  await page.getByRole("tab", { name: "Architect" }).click();
  await expect(page.getByTestId("stage-chip-geometry")).toHaveText("done");
  await expect(page.getByTestId("stage-chip-plan")).toHaveText("pending");

  // A progression edit rebuilds them: The Deep shrinks to one room.
  await page.getByRole("tab", { name: /Progression/ }).click();
  await page.evaluate(() => window.studio!.applyOperation("updateRegion", { regionId: "deep", changes: { rooms: 1 } }));
  await page.getByRole("tab", { name: "Rooms" }).click();
  await expect(page.getByTestId("room-deep_2")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("room-deep_1")).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
