import { expect, test } from "@playwright/test";
import { collectConsoleErrors, confirmInPage, openStudio, projectMenu, projectRevision, resetProject } from "./helpers.ts";

// The studio shell: grouped tabs, the project menu (rename, example, start over
// behind an in-page confirmation), save status, what ▶ Play plays, and the
// side panel's list parts (collapsible sections, filter, keyboard, resize).

test.afterEach(async ({ page }) => resetProject(page));

const projectName = (page: import("@playwright/test").Page) => page.evaluate(() => window.studio!.getProject().name);

test("tabs follow the creator's flow in groups: design, build, play; arrows move between them", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText(["Wiki", "Progression", "Architect", "Rooms", "Scenery", "Characters", "Game", "Playtest"]);
  for (const [group, names] of [
    ["design", ["Wiki", "Progression", "Architect"]],
    ["build", ["Rooms", "Scenery", "Characters", "Game"]],
    ["play", ["Playtest"]],
  ] as const) {
    const box = page.locator(`.tab-group[data-group="${group}"]`);
    await expect(box.locator(".tab-group-label")).toHaveText(group, { ignoreCase: true });
    await expect(box.getByRole("tab")).toHaveText([...names]);
  }

  // Playtest is open; only the open tab is in the Tab order.
  const playtest = page.getByRole("tab", { name: "Playtest" });
  await expect(playtest).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  // ← moves the focus without opening; Enter opens.
  await playtest.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Game" })).toBeFocused();
  await expect(playtest).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Game" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: /Wiki/ })).toBeFocused();

  // The studio reopens on the tab it was left on.
  await page.reload();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing", { timeout: 30_000 });
  await expect(page.getByRole("tab", { name: "Game" })).toHaveAttribute("aria-selected", "true");
  expect(consoleErrors).toEqual([]);
});

test("project menu: rename the game in place (Undo restores it); start over asks in the page first", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  // The rare, destructive actions are no longer toolbar buttons.
  await expect(page.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Example/ })).toHaveCount(0);

  await expect(projectMenu(page)).toHaveText("Untitled Game");
  await projectMenu(page).click();
  await page.getByRole("menuitem", { name: "Rename game" }).click();
  const field = page.getByLabel("Game name");
  await expect(field).toBeFocused();
  await field.fill("Neon Echoes");
  await field.press("Enter");
  await expect.poll(() => projectName(page)).toBe("Neon Echoes");
  await expect(projectMenu(page)).toHaveText("Neon Echoes");

  // Double-click renames too; Escape cancels.
  await projectMenu(page).dblclick();
  await page.getByLabel("Game name").fill("Something else");
  await page.getByLabel("Game name").press("Escape");
  await expect(projectMenu(page)).toHaveText("Neon Echoes");

  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(() => projectName(page)).toBe("Untitled Game");

  // Start over: Cancel (or Escape) leaves the project alone; confirming resets it.
  await page.getByRole("button", { name: "+ Enemy" }).click();
  await expect.poll(async () => (await page.evaluate(() => window.studio!.getProject().characters.length))).toBe(4);
  const revision = await projectRevision(page);
  await projectMenu(page).click();
  await page.getByRole("menuitem", { name: /Start over/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Start over?");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused(); // destructive: the safe choice has the focus
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await projectMenu(page).click();
  await page.getByRole("menuitem", { name: /Start over/ }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await projectRevision(page)).toBe(revision);

  await projectMenu(page).click();
  await page.getByRole("menuitem", { name: /Start over/ }).click();
  await confirmInPage(page, "Start over");
  await expect.poll(async () => (await page.evaluate(() => window.studio!.getProject().characters.length))).toBe(3);

  // Start from scratch: the player alone in an empty arena.
  await projectMenu(page).click();
  await page.getByRole("menuitem", { name: /Start from scratch/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("just the player in an empty arena");
  await confirmInPage(page, "Start from scratch");
  await expect.poll(async () => (await page.evaluate(() => window.studio!.getProject().characters.map((c) => c.kind)))).toEqual(["player"]);
  const blank = await page.evaluate(() => window.studio!.getProject().world.rooms);
  expect(blank.map((r) => [r.id, r.spawns.length, r.props.length])).toEqual([["arena", 0, 0]]);
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  expect(consoleErrors).toEqual([]);
});

test("toolbar: saved status instead of a revision, what ▶ Play plays, and the auto-build menu explained", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  const saved = page.getByTestId("save-status");
  await expect(saved).toHaveText("Saved");
  await expect(saved).toHaveAttribute("title", /saved on the project server/);
  await expect(page.locator(".toolbar")).not.toContainText(/\brev \d/);

  // The chip beside ▶ Play names the playtest room and offers the game from its start.
  const target = page.getByRole("button", { name: /What Play tests/ });
  await expect(target).toContainText("Arena");
  await target.click();
  const panel = page.getByRole("dialog", { name: "What Play tests" });
  await expect(panel).toContainText("Arena, from the playtest spot, with no abilities");
  await panel.getByRole("button", { name: /Play the game from its start/ }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect(page.getByRole("tab", { name: "Rooms" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");

  // In the Playtest tab, a small note says what the stage shows.
  await page.getByRole("tab", { name: "Playtest" }).click();
  await expect(page.getByTestId("edit-badge")).toHaveText("Editing Arena · ▶ Play to try it");

  // Auto-build: says what it is and what each switch does; a click outside closes it.
  await page.getByTestId("live-status").getByRole("button").click();
  const menu = page.getByRole("dialog", { name: "Auto-build" });
  await expect(menu).toContainText("never locks editing");
  await expect(menu.getByLabel("live cast")).not.toBeChecked();
  await expect(menu).toContainText("Nothing running.");
  await page.getByTestId("save-status").click();
  await expect(menu).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("side panel: the character list collapses (remembered), filters and groups a long cast, arrows move through it, and the panel resizes", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  const list = page.getByTestId("character-list");
  const toggle = list.getByRole("button", { name: /Characters/ }).first();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toContainText("3");

  // Collapse: the list hides, the inspector below stays; the choice survives a reload.
  await toggle.click();
  await expect(page.getByTestId("character-crawler")).toBeHidden();
  await expect(page.getByLabel("patrol speed")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing", { timeout: 30_000 });
  await expect(page.getByTestId("character-crawler")).toBeHidden();
  await page.getByTestId("character-list").getByRole("button", { name: /Characters/ }).first().click();
  await expect(page.getByTestId("character-crawler")).toBeVisible();

  // Short cast: no filter. A long one (9) gets a filter and player/enemy groups.
  await expect(page.getByLabel("Filter characters")).toHaveCount(0);
  for (let i = 0; i < 6; i++) {
    const before = await projectRevision(page);
    await page.getByRole("button", { name: "+ Enemy" }).click();
    await expect.poll(() => projectRevision(page)).toBe(before + 1);
  }
  const filter = page.getByLabel("Filter characters");
  await expect(filter).toBeVisible();
  await expect(list.locator(".list-section.level-2 .list-section-title")).toHaveText(["Player", "Enemies"]);
  await filter.fill("charg");
  await expect(list.getByRole("listitem")).toHaveText(["Charger"]);
  await expect(list.locator(".list-filter-count")).toHaveText("1 of 9");
  await filter.fill("nothing like this");
  await expect(list).toContainText("No character matches");
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(list.getByRole("listitem")).toHaveCount(9);

  // ↓ from the filter enters the list; ↓/↑ move; Enter selects.
  await filter.press("ArrowDown");
  await expect(page.getByTestId("character-player")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("character-charger")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("character-crawler")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("character-crawler")).toHaveClass(/selected/);

  // Resize from the keyboard (← widens), double-click resets.
  const panel = page.locator(".sidebar");
  const handle = page.getByRole("separator", { name: "Resize the side panel" });
  const width = async () => (await panel.boundingBox())!.width;
  const start = await width();
  await handle.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(width).toBeGreaterThan(start + 50);
  await handle.dblclick();
  await expect.poll(width).toBeCloseTo(320, -1);
  expect(consoleErrors).toEqual([]);
});
