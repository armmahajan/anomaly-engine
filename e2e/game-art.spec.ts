import { expect, test, type Page } from "@playwright/test";
import type { ArtState, ProjectSpec } from "@anomaly/core";
import { collectConsoleErrors, openStudio, resetProject, runtimeState, waitForRuntimeAfter } from "./helpers.ts";

// Game art buttons with scripted models (STUDIO_ART_BACKEND=fake): a room's
// props drawn with its biome's kit (one piece painted into it), item icons
// cut from one sheet, and a modal's illustration.

test.afterEach(async ({ page }) => resetProject(page));

const project = (page: Page) => page.evaluate(() => window.studio!.getProject()) as Promise<ProjectSpec>;
const artIdle = async (page: Page) => ((await (await page.request.get("/api/art")).json()) as ArtState).running === null;

test("game art: draw a room's props, item icons and a modal's image from the studio", async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors = collectConsoleErrors(page);
  const r0 = await openStudio(page);

  // Setup through the API: props, items and a modal; then a biome that dresses the arena.
  const setup = await page.request.post("/api/batch", {
    data: {
      baseRevision: r0,
      operations: [
        { name: "createItem", input: { name: "Ember", color: "#ff7733" } },
        { name: "createItem", input: { name: "Feather" } },
        { name: "createModal", input: { title: "The Deep", body: "Water drips somewhere far below." } },
        { name: "addProp", input: { roomId: "arena", name: "Gate", x: 800, y: 544, width: 32, height: 96, solid: true, handlers: [{ on: { type: "interact" }, do: [{ type: "takeItem", item: "ember" }] }] } },
        { name: "addProp", input: { roomId: "arena", name: "Ember pile", x: 400, y: 624, width: 24, height: 16, handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "ember" }] }] } },
      ],
    },
  });
  expect(setup.ok()).toBe(true);
  await waitForRuntimeAfter(page, r0);
  const kit = await page.request.post("/api/art/jobs", { data: { stage: "worldKit", brief: "a fungal cathedral", dressRoom: "arena" } });
  expect(kit.ok()).toBe(true);
  await expect.poll(async () => (await project(page)).world.rooms[0]!.dressing !== null && (await artIdle(page)), { timeout: 120_000 }).toBe(true);

  // Props: one job draws both (the first with a piece painted into the kit).
  await page.getByRole("tab", { name: "Rooms" }).click();
  await page.getByRole("button", { name: "🎨 Draw props (2)" }).click();
  await expect.poll(async () => (await project(page)).world.rooms[0]!.props.every((p) => p.art), { timeout: 60_000 }).toBe(true);
  const biome = (await project(page)).art.assets.find((a) => a.kind === "biome");
  expect(biome?.kind === "biome" && biome.kit!.pieces.some((p) => p.id.startsWith("prop_"))).toBe(true);
  await expect(page.getByTestId("prop-art")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "🎨 Draw props (0)" })).toBeDisabled();

  // Item icons: one sheet for both.
  await page.getByRole("tab", { name: "Game" }).click();
  await expect.poll(() => artIdle(page)).toBe(true);
  await page.getByRole("button", { name: "🎨 Draw icons (2)" }).click();
  await expect(page.getByTestId("item-icon-ember")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("item-icon-feather")).toBeVisible();

  // A modal's illustration, shown in the runtime's preview.
  await expect.poll(() => artIdle(page)).toBe(true);
  const modals = page.getByTestId("modals-panel");
  await modals.getByRole("button", { name: "🎨 Illustrate" }).click();
  await expect(modals.getByTestId("modal-image")).toBeVisible({ timeout: 60_000 });
  expect((await project(page)).world.modals[0]!.image).toBeTruthy();
  await modals.getByRole("button", { name: "Preview" }).click();
  await expect.poll(async () => (await runtimeState(page)).modal).toBe("the_deep");
  await modals.getByRole("button", { name: "Hide preview" }).click();

  // Each job is one undoable change.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(async () => (await project(page)).world.modals[0]!.image).toBeNull();
  expect((await project(page)).world.items.every((i) => i.icon)).toBe(true);
  expect(consoleErrors).toEqual([]);
});
