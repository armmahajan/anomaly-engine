import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, runtimeState } from "./helpers.ts";

// Scripted art models (STUDIO_ART_BACKEND=fake): every stage answers with the
// example beetle rig and clips; renders still go through the real runtime.

// Leave the shared e2e project as we found it: rig-drawn characters cost
// software-rendered frames, which skews the real-time gameplay tests.
test.afterEach(async ({ page }) => {
  await page.request.post("/api/reset", { data: { baseRevision: await projectRevision(page) } });
});

test("art: concepts -> pick -> rig -> animate in the Characters workbench, then the charger plays with its rig", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByTestId("character-charger").click();
  await page.getByRole("tab", { name: "Characters" }).click();
  const panel = page.getByTestId("art-panel");
  const bench = page.getByTestId("character-bench");
  await expect.poll(async () => (await runtimeState(page)).stage).toBe("character");

  await panel.getByLabel("What should Charger look like?").fill("a horned beetle that charges");
  await panel.getByRole("button", { name: "Generate concepts" }).click();
  await expect(bench.getByTestId("sheet-0")).toBeVisible({ timeout: 30_000 });
  await expect(bench.getByText("AI pick", { exact: true })).toBeVisible();

  // Choosing a design moves the workbench to the rig step.
  await bench.getByRole("button", { name: "design 2 of sheet 1" }).click();
  await expect(bench.getByRole("img", { name: "chosen design" })).toBeVisible({ timeout: 30_000 });

  await panel.getByRole("button", { name: "Build rig" }).click();
  await expect(bench.getByTestId("rig-preview")).toBeAttached({ timeout: 60_000 });
  await expect(bench.getByText(/critic \d+\/10 · 9 parts/)).toBeVisible();
  await bench.getByLabel("onion skin").fill("0.8");

  await panel.getByRole("button", { name: "Animate" }).click();
  await expect(bench.getByTestId("clip-walk")).toBeVisible({ timeout: 60_000 });
  await expect(bench.getByTestId("clip-walk").getByRole("img")).toBeVisible();

  // Select a clip and scrub the timeline: the live rig on the stage follows.
  await bench.getByTestId("clip-windup").getByRole("button").click();
  await expect(bench.getByTestId("clip-windup").getByRole("button")).toHaveText(/■ windup/);
  await page.getByLabel("clip time").fill("0.3");
  await expect(page.getByRole("button", { name: "Play clip" })).toBeVisible();

  // Behavior still runs with art: Play returns to the arena.
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).entities.find((e) => e.characterId === "charger")?.behaviorState).toBeTruthy();
  await page.getByRole("button", { name: "■ Stop" }).click();
  await page.getByRole("tab", { name: "Characters" }).click();

  await expect(page.getByTestId("art-job")).toContainText("committed");
  expect(consoleErrors).toEqual([]);
});

test("art: auto runs every stage in one go", async ({ page }) => {
  await openStudio(page);
  await page.getByTestId("character-crawler").click();
  await page.getByRole("tab", { name: "Characters" }).click();
  const panel = page.getByTestId("art-panel");
  await panel.getByLabel("What should Crawler look like?").fill("a pale grub");
  await panel.getByLabel("Auto").check();
  await panel.getByRole("button", { name: "Generate everything" }).click();
  await expect(page.getByTestId("character-bench").getByTestId("clip-idle")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("character-crawler").locator("img")).toBeVisible();
});
