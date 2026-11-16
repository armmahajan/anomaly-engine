import { expect, test, type Page } from "@playwright/test";
import type { BiomeAsset, ProjectSpec } from "@anomaly/core";
import { collectConsoleErrors, openStudio, projectRevision, runtimeState } from "./helpers.ts";

// Worlds mode with scripted models (STUDIO_ART_BACKEND=fake); images are
// still sliced and the room is drawn by the real runtime.

test.afterEach(async ({ page }) => {
  await page.request.post("/api/reset", { data: { baseRevision: await projectRevision(page) } });
});

const project = (page: Page) => page.evaluate(() => window.studio!.getProject()) as Promise<ProjectSpec>;
const biome = async (page: Page) => (await project(page)).art.assets.find((a) => a.kind === "biome") as BiomeAsset | undefined;

/** Pretend the runtime reported something (as a click or drag on the world stage would). */
async function fromRuntime(page: Page, message: unknown) {
  const frame = page.frameLocator("iframe.game-frame");
  await frame.locator("body").evaluate((_, m) => window.parent.postMessage(JSON.stringify({ source: "anomaly-runtime", message: m }), location.origin), message);
}

test("worlds: paint a kit, see the room, place and move pieces, accept a suggested layout, dress the arena", async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Worlds" }).click();
  const panel = page.getByTestId("world-panel");
  await expect(page.getByText(/Describe a place in the sidebar/)).toBeVisible();

  await panel.getByLabel("What is this place?").fill("a fungal cathedral");
  await panel.getByRole("button", { name: /Paint kit \+ first room/ }).click();
  await expect(page.getByTestId("piece-p0_lantern")).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole("button", { name: /fungal cathedral/i }).first()).toBeVisible();
  await expect.poll(async () => (await runtimeState(page)).stage).toBe("world");
  const first = (await biome(page))!;
  expect(first.rooms).toHaveLength(1);
  expect((await project(page)).sandbox.dressing).toEqual({ biome: first.id, room: first.rooms[0]!.id });

  // Layer, fog and exploded toggles just change the view.
  await page.getByLabel("Front layer").uncheck();
  await page.getByLabel("Exploded").check();
  await page.getByLabel("Exploded").uncheck();

  // Kit shelf: a click places the piece in the view.
  const before = first.rooms[0]!.composition.placements.length;
  await page.getByTestId("piece-p0_lantern").click();
  await expect.poll(async () => (await biome(page))!.rooms[0]!.composition.placements.length).toBe(before + 1);

  // Selecting and dragging in the runtime become ordinary edits.
  await fromRuntime(page, { type: "worldPick", placementId: "pl_1" });
  await expect(page.getByTestId("world-selection")).toBeVisible();
  await fromRuntime(page, { type: "worldMove", placementId: "pl_1", x: 777, y: 600 });
  await expect.poll(async () => (await biome(page))!.rooms[0]!.composition.placements.find((p) => p.id === "pl_1")?.x).toBe(777);
  await page.getByLabel("piece layer").selectOption("back");
  await expect.poll(async () => (await biome(page))!.rooms[0]!.composition.placements.find((p) => p.id === "pl_1")?.layer).toBe("back");

  // A second room with a suggested layout: nothing changes until it is accepted.
  const platforms = (await project(page)).sandbox.platforms;
  await panel.getByLabel("Suggest layout").check();
  await panel.getByRole("button", { name: /Compose room/ }).click();
  await expect(page.getByText("This room suggests a new platform layout.")).toBeVisible({ timeout: 30_000 });
  expect((await project(page)).sandbox.platforms).toEqual(platforms);
  await page.getByLabel("Preview it").check();
  await page.getByRole("button", { name: "Use this layout in the arena" }).click();
  await expect.poll(async () => (await project(page)).sandbox.platforms).not.toEqual(platforms);
  await expect(page.getByText("This room suggests a new platform layout.")).toHaveCount(0);

  // Undo puts the arena back.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(async () => (await project(page)).sandbox.platforms).toEqual(platforms);

  // The arena is drawn with the room, and the game still plays in it.
  await page.getByRole("tab", { name: "Arena" }).click();
  await expect.poll(async () => (await runtimeState(page)).dressed).toBe(true);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).entities.find((e) => e.characterId === "charger")?.behaviorState).toBeTruthy();
  expect((await runtimeState(page)).dressed).toBe(true);
  await page.getByRole("button", { name: "■ Stop" }).click();

  expect(consoleErrors).toEqual([]);
});

test("worlds: the build assistant queues a world from chat; it appears in Worlds", async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  await page.getByRole("tab", { name: "Worlds" }).click();
  await page.getByLabel("Message").fill("world: a sunken garden of giant ferns");
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByTestId("chat-reply").last()).toContainText("queued: paint world");
  await expect(page.getByTestId("world-panel").getByRole("button", { name: /sunken garden/i }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("piece-p0_lantern")).toBeVisible({ timeout: 30_000 });
});
