import { expect, test } from "@playwright/test";
import { decodePng } from "@anomaly/art";
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

test("art: a cutout rig is the design itself, drawn by the runtime on the stage and in play", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByTestId("character-charger").click();
  await page.getByRole("tab", { name: "Characters" }).click();
  const panel = page.getByTestId("art-panel");
  const bench = page.getByTestId("character-bench");
  await panel.getByLabel("What should Charger look like?").fill("a stout beast with a pale head");
  await panel.getByRole("button", { name: "Generate concepts" }).click();
  await expect(bench.getByTestId("sheet-0")).toBeVisible({ timeout: 30_000 });
  await bench.getByRole("button", { name: "design 1 of sheet 1" }).click();
  await expect(bench.getByRole("img", { name: "chosen design" })).toBeVisible({ timeout: 30_000 });

  // The fake critic scores 8 and keeps the plan: the creature's body, head and legs, cut from the design.
  await panel.getByRole("radio", { name: "Cutout" }).check();
  await panel.getByRole("button", { name: "Build rig" }).click();
  await expect(bench.getByTestId("rig-preview")).toBeAttached({ timeout: 60_000 });
  await expect(bench.getByText(/critic 8\/10 · \d+ parts · cutout/)).toBeVisible();
  await expect(bench.getByTestId("rig-match")).toHaveText(/match (9\d|100)% shape, (9\d|100)% color/);
  const rig = await page.evaluate(() => window.studio?.getProject().art.assets.flatMap((a) => (a.kind === "character" ? [a.rig] : []))[0]);
  expect(rig?.mode).toBe("cutout");

  // The live rig on the stage is the design's pixels (onion skin off): its brown body shows.
  await bench.getByLabel("onion skin").fill("0");
  const body = [107, 79, 58];
  await expect.poll(async () => colorCount(await page.locator("iframe.game-frame").screenshot(), body), { timeout: 15_000 }).toBeGreaterThan(300);
  await page.screenshot({ path: "test-results/art-cutout-stage.png" });

  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).entities.find((e) => e.characterId === "charger")?.behaviorState).toBeTruthy();
  await expect.poll(async () => colorCount(await page.locator("iframe.game-frame").screenshot(), body), { timeout: 15_000 }).toBeGreaterThan(10);
  await page.getByRole("button", { name: "■ Stop" }).click();
  expect(consoleErrors).toEqual([]);
});

/** Pixels of a screenshot near the color `rgb`. */
function colorCount(png: Buffer, rgb: number[]): number {
  const { data } = decodePng(png);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.hypot(data[i]! - rgb[0]!, data[i + 1]! - rgb[1]!, data[i + 2]! - rgb[2]!) < 18) n++;
  return n;
}
