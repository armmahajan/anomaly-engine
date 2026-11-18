import { mkdirSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { borderedGrid, encodeStudioMessage, fillTiles, toRuntimeProject, type ProjectSpec, type StudioToRuntime, type TileGrid, type TileKind } from "@anomaly/core";
import { collectConsoleErrors, openStudio, projectRevision, runtimeState } from "./helpers.ts";

// Terrain screenshots for a look (kept in .e2e-data/terrain): the plain and the dressed arena,
// a Scenery-mode dressing, and a grid with every tile kind. Art is scripted (STUDIO_ART_BACKEND=fake).

const SHOTS = ".e2e-data/terrain";

test.afterEach(async ({ page }) => {
  await page.request.post("/api/reset", { data: { baseRevision: await projectRevision(page) } });
});

const project = (page: Page) => page.evaluate(() => window.studio!.getProject()) as Promise<ProjectSpec>;
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(600);
  await page.locator("iframe.game-frame").screenshot({ path: `${SHOTS}/${name}.png` });
};

/** Every tile kind in awkward company: steps, an overhang, a ledge on a block, one-ways by a pillar, breakables, spikes. */
function trickyGrid(): TileGrid {
  let grid = fillTiles(borderedGrid(50, 23), { col: 0, row: 21, cols: 50, rows: 1 }, "solid");
  const fills: [number, number, number, number, TileKind][] = [
    [6, 18, 6, 3, "solid"],
    [9, 15, 3, 3, "solid"],
    [6, 17, 3, 1, "ledge"],
    [16, 1, 8, 3, "solid"],
    [16, 4, 2, 4, "solid"],
    [13, 20, 5, 1, "hazard"],
    [26, 12, 2, 9, "solid"],
    [21, 15, 5, 1, "oneway"],
    [28, 15, 5, 1, "oneway"],
    [34, 13, 4, 2, "breakable"],
    [36, 15, 2, 2, "breakable"],
    [40, 21, 3, 1, "breakable"],
    [42, 10, 5, 1, "solid"],
    [44, 6, 4, 1, "ledge"],
    [46, 14, 3, 7, "solid"],
    [45, 16, 1, 4, "hazard"],
  ];
  for (const [col, row, cols, rows, kind] of fills) grid = fillTiles(grid, { col, row, cols, rows }, kind);
  return grid;
}

/** A stony RGB texture (the fake art's are flat), so seams between cells would show. */
function stonePng(size = 128): string {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(size * stride);
  const t = (2 * Math.PI) / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = Math.sin(x * t * 3 + Math.sin(y * t * 2) * 2) * 0.5 + Math.sin(y * t * 5 + x * t) * 0.3 + Math.sin((x + y) * t * 9) * 0.2;
      const crack = Math.abs(Math.sin(x * t * 2 + Math.cos(y * t * 3) * 1.5)) < 0.05 ? -60 : 0;
      const v = 120 + n * 40 + crack;
      raw.set([v * 0.95, v * 0.85, v * 0.7].map((c) => Math.max(0, Math.min(255, Math.round(c)))), y * stride + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

async function toRuntime(page: Page, message: StudioToRuntime) {
  const encoded = encodeStudioMessage(message);
  await page.evaluate((m) => document.querySelector<HTMLIFrameElement>("iframe.game-frame")!.contentWindow!.postMessage(m, location.origin), encoded);
}

/** Load a project into the runtime directly (no studio edit), e.g. a grid no operation makes yet. */
/** The project with its first room (the starter arena) re-tiled. */
const withArenaGrid = (spec: ProjectSpec, grid: TileGrid): ProjectSpec => ({
  ...spec,
  world: { ...spec.world, rooms: spec.world.rooms.map((r, i) => (i === 0 ? { ...r, grid } : r)) },
});

async function loadInRuntime(page: Page, spec: ProjectSpec) {
  await toRuntime(page, { type: "load", project: toRuntimeProject({ ...spec, revision: spec.revision + 1000 }) });
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(spec.revision + 1000);
}

async function playShot(page: Page, name: string) {
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await page.waitForTimeout(1200);
  await shot(page, name);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
}

test("terrain: plain and dressed arenas, a Scenery dressing, every tile kind", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await shot(page, "arena-plain");
  await playShot(page, "arena-plain-play");
  const plain = await project(page);
  await loadInRuntime(page, withArenaGrid(plain, trickyGrid()));
  await shot(page, "tricky-plain");

  await page.getByRole("tab", { name: "Scenery" }).click();
  const panel = page.getByTestId("world-panel");
  await panel.getByLabel("What is this place?").fill("a fungal cathedral");
  await panel.getByRole("button", { name: /Paint look \+ first dressing/ }).click();
  await expect.poll(async () => (await runtimeState(page)).stage, { timeout: 90_000 }).toBe("world");
  await shot(page, "room-worlds");

  await page.getByRole("tab", { name: "Playtest" }).click();
  await expect.poll(async () => (await runtimeState(page)).dressed).toBe(true);
  await shot(page, "arena-dressed");
  await playShot(page, "arena-dressed-play");
  const dressed = await project(page);
  const kit = dressed.art.assets.find((a) => a.kind === "biome")!.kit!;
  await toRuntime(page, { type: "images", images: { [kit.ground]: stonePng() } });
  await loadInRuntime(page, withArenaGrid(dressed, trickyGrid()));
  expect((await runtimeState(page)).dressed).toBe(true);
  await shot(page, "tricky-dressed");

  expect(consoleErrors).toEqual([]);
});
