import { expect, test, type Page } from "@playwright/test";
import { borderedGrid, fillTiles, TILE, type ArtState, type ProjectSpec } from "@anomaly/core";
import { collectConsoleErrors, openStudio, resetProject, runtimeState, waitForRuntimeAfter } from "./helpers.ts";

// The play camera and depth in the browser: a dressed room bigger than the view (layered kit from
// the scripted models), played from three spots. The camera follows on both axes and the frames
// differ; shaders compile (no console errors). Screenshots go to the test's output folder, or to
// DEPTH_SHOTS if set.

test.afterEach(async ({ page }) => resetProject(page));

const project = (page: Page) => page.evaluate(() => window.studio!.getProject()) as Promise<ProjectSpec>;
const artIdle = async (page: Page) => ((await (await page.request.get("/api/art")).json()) as ArtState).running === null;

const COLS = 80;
const ROWS = 40;
const FLOOR = (ROWS - 1) * TILE;
const SHELF_ROW = 12;
const GRID = fillTiles(borderedGrid(COLS, ROWS), { col: 40, row: SHELF_ROW, cols: 36, rows: 1 }, "solid");

async function playFrom(page: Page, x: number, y: number) {
  const status = page.getByTestId("runtime-status");
  if ((await status.textContent()) === "Playing") {
    await page.getByRole("button", { name: "■ Stop" }).click();
    await expect(status).toHaveText("Editing");
  }
  const base = (await project(page)).revision;
  const set = await page.request.post("/api/batch", { data: { baseRevision: base, operations: [{ name: "setPlaytest", input: { roomId: "depth_hall", x, y } }] } });
  expect(set.ok()).toBe(true);
  await waitForRuntimeAfter(page, base);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(status).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).dressed).toBe(true);
  await page.waitForTimeout(1200); // the player lands, the camera settles
  return (await runtimeState(page)).camera!;
}

test("depth: a dressed room bigger than the view scrolls on both axes with layered planes", async ({ page }, info) => {
  test.setTimeout(240_000);
  const consoleErrors = collectConsoleErrors(page);
  const r0 = await openStudio(page);
  const setup = await page.request.post("/api/batch", {
    data: { baseRevision: r0, operations: [{ name: "createWorldRoom", input: { name: "Depth hall", id: "depth_hall", grid: GRID } }, { name: "setPlaytest", input: { roomId: "depth_hall", x: 200, y: FLOOR } }] },
  });
  expect(setup.ok()).toBe(true);
  await waitForRuntimeAfter(page, r0);
  const kit = await page.request.post("/api/art/jobs", { data: { stage: "worldKit", brief: "a drowned cathedral", dressRoom: "depth_hall" } });
  expect(kit.ok()).toBe(true);
  await expect.poll(async () => (await project(page)).world.rooms.find((r) => r.id === "depth_hall")!.dressing !== null && (await artIdle(page)), { timeout: 150_000 }).toBe(true);
  const biome = (await project(page)).art.assets.find((a) => a.kind === "biome");
  expect(biome?.kind === "biome" && biome.kit!.backgrounds!.map((p) => p.name)).toEqual(["sky", "far", "near"]);

  const frame = page.locator("iframe.game-frame");
  const dir = process.env.DEPTH_SHOTS;
  const shot = async (name: string) => frame.screenshot({ path: dir ? `${dir}/${name}.png` : info.outputPath(`${name}.png`) });
  const spots = [
    ["bottom-left", 200, FLOOR],
    ["bottom-right", (COLS - 4) * TILE, FLOOR],
    ["shelf", 60 * TILE, SHELF_ROW * TILE],
  ] as const;
  const cameras = [];
  const shots = [];
  for (const [name, x, y] of spots) {
    cameras.push(await playFrom(page, x, y));
    shots.push(await shot(name));
  }
  const [low, right, high] = cameras;
  expect(right!.x - low!.x).toBeGreaterThan(1000);
  expect(Math.abs(right!.y - low!.y)).toBeLessThan(2);
  expect(low!.y - high!.y).toBeGreaterThan(400);
  expect(shots[0]!.equals(shots[1]!)).toBe(false);
  expect(shots[1]!.equals(shots[2]!)).toBe(false);
  await page.getByRole("button", { name: "■ Stop" }).click();
  expect(consoleErrors).toEqual([]);
});
