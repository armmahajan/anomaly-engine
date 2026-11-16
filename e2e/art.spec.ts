import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, runtimeState } from "./helpers.ts";

// Scripted art models (STUDIO_ART_BACKEND=fake): every stage answers with the
// example beetle rig and clips; renders still go through the real runtime.

// Leave the shared e2e project as we found it: rig-drawn characters cost
// software-rendered frames, which skews the real-time gameplay tests.
test.afterEach(async ({ page }) => {
  await page.request.post("/api/reset", { data: { baseRevision: await projectRevision(page) } });
});

test("art: concepts -> pick -> rig -> animate, then the charger is drawn by its rig", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByTestId("character-charger").click();
  await page.getByRole("tab", { name: "Art" }).click();
  const panel = page.getByTestId("art-panel");

  await panel.getByLabel("What should Charger look like?").fill("a horned beetle that charges");
  await panel.getByRole("button", { name: "Generate concepts" }).click();
  await expect(panel.getByTestId("sheet-0")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("AI pick")).toBeVisible();

  await panel.getByRole("button", { name: "design 2 of sheet 1" }).click();
  await expect(panel.getByText("chosen", { exact: true })).toBeVisible({ timeout: 30_000 });

  await panel.getByRole("button", { name: "Build rig" }).click();
  await expect(panel.getByTestId("rig-preview")).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/rig · \d+\/10 · 9 parts/)).toBeVisible();

  await panel.getByRole("button", { name: "Animate" }).click();
  await expect(panel.getByTestId("clip-walk")).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByTestId("clip-walk").getByRole("img")).toBeVisible();

  // The runtime now draws the charger with its rig and animates it: preview a clip in edit mode.
  await panel.getByTestId("clip-windup").getByRole("button").click();
  await expect(panel.getByTestId("clip-windup").getByRole("button")).toHaveText(/■ windup/);

  // Behavior still runs with art: play, and the charger reaches its windup when the player is near.
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).entities.find((e) => e.characterId === "charger")?.behaviorState).toBeTruthy();
  await page.getByRole("button", { name: "■ Stop" }).click();

  const last = page.getByTestId("art-job");
  await expect(last).toContainText("committed");
  expect(consoleErrors).toEqual([]);
});

test("art: auto runs every stage in one go", async ({ page }) => {
  await openStudio(page);
  await page.getByTestId("character-crawler").click();
  await page.getByRole("tab", { name: "Art" }).click();
  const panel = page.getByTestId("art-panel");
  await panel.getByLabel("What should Crawler look like?").fill("a pale grub");
  await panel.getByLabel("Auto").check();
  await panel.getByRole("button", { name: "Generate everything" }).click();
  await expect(panel.getByTestId("clip-idle")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("character-crawler").locator("img")).toBeVisible();
});
