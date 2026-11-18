import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, resetProject, runtimeState } from "./helpers.ts";

// The creator's whole journey through the studio, with the scripted chat and art backends:
// pitch -> the director's wiki and progression -> the build assistant builds from them ->
// Make the art -> Check the game -> play from the title to the ending.

test.afterEach(async ({ page }) => resetProject(page));

const project = (page: Page) => page.evaluate(() => window.studio!.getProject());
async function chat(page: Page, message: string) {
  const replies = page.getByTestId("chat-reply");
  const before = await replies.count();
  await page.getByLabel("Message").fill(message);
  await page.getByLabel("Message").press("Enter");
  await expect(replies).toHaveCount(before + 1, { timeout: 30_000 });
}
async function hold(page: Page, key: string, ms: number) {
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe.game-frame")!;
    frame.contentWindow!.focus();
    frame.contentDocument!.getElementById("canvas")!.focus();
  });
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

test("pitch to played game: design, build from the design, art, check, play to the ending", async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);

  // The director drafts the wiki and the progression.
  await page.getByRole("tab", { name: "Wiki" }).click();
  await chat(page, "A flooded kingdom; the player is the last lamplighter.");
  await page.getByRole("tab", { name: "Progression" }).click();
  await chat(page, "Design the structure: four regions, two abilities.");
  expect((await project(page)).progression.regions.map((r) => r.id)).toEqual(expect.arrayContaining(["gate", "city"]));

  // The build assistant builds from the documents.
  await page.getByRole("tab", { name: "Playtest" }).click();
  await chat(page, "Build from the design: the gate and the city.");
  const built = await project(page);
  expect(built.world.rooms.filter((r) => r.regionId).map((r) => [r.id, r.regionId])).toEqual([
    ["gate_hall", "gate"],
    ["city_steps", "city"],
  ]);

  // Make the art draws everything the game needs.
  await page.getByRole("tab", { name: "Game" }).click();
  await expect(page.getByTestId("game-art")).toContainText("steps to draw the whole game");
  await page.getByRole("button", { name: "Make the art" }).click();
  await expect(page.getByTestId("game-art-last")).toContainText("committed", { timeout: 180_000 });
  const drawn = await project(page);
  expect(drawn.world.rooms.filter((r) => r.regionId).every((r) => r.dressing)).toBe(true);
  expect(drawn.world.modals.every((m) => m.image)).toBe(true);

  // Check the game proves it can be finished.
  await page.getByRole("button", { name: "Check the game", exact: true }).click();
  await expect(page.getByTestId("check-verdict")).toContainText("✓ Beatable, no dead ends", { timeout: 60_000 });

  // Play from the title to the ending.
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).modal, { timeout: 20_000 }).toBe("title");
  await hold(page, "Enter", 80);
  await expect.poll(async () => (await runtimeState(page)).modal).toBeNull();
  await page.waitForTimeout(400);
  // Walk right until the lamp ends the game (headless rendering can be slow, so hold until it happens).
  await hold(page, "ArrowRight", 0);
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await runtimeState(page)).modal, { timeout: 90_000, intervals: [500] }).toBe("ending");
  await page.keyboard.up("ArrowRight");
  expect((await runtimeState(page)).visited).toEqual(["gate_hall", "city_steps"]);
  expect(consoleErrors).toEqual([]);
});
