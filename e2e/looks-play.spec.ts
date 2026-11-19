import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { decodePng } from "@anomaly/art";
import { collectConsoleErrors, openStudio, projectRevision, resetProject, runtimeState, waitForRuntimeAfter } from "./helpers.ts";
import { loadAnimatedFixture } from "./animatedFixture.ts";

// Looks in the web export, proven by pixels (README "Looks and effects"): a behavior state's look (a red
// aura and rising embers) on the drawn charger, a prop dissolving out with a green edge, particles at a
// point, and a camera punch. The headless tests (game/test/looks.test.ts) prove the rest through state.

const SHOTS = process.env.LOOK_SHOTS ?? "test-results/looks";

test.afterEach(({ page }) => resetProject(page));

type PlayState = Awaited<ReturnType<typeof runtimeState>> & {
  props: { id: string; look: string[] | null; dissolved: boolean }[];
  entities: { spawnId: string; look: string[] | null }[];
  emitters: number;
};
const state = (page: Page) => runtimeState(page) as Promise<PlayState>;

async function batch(page: Page, operations: { name: string; input: unknown }[]) {
  const before = await projectRevision(page);
  const result = await page.evaluate((calls) => window.studio!.applyBatch(calls), operations);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await waitForRuntimeAfter(page, before);
}

const shot = (page: Page) => page.locator("iframe.game-frame").screenshot();

/** Pixels of a screenshot passing `test` (r, g, b). */
function count(png: Buffer, test: (r: number, g: number, b: number) => boolean): number {
  const { data } = decodePng(png);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (test(data[i]!, data[i + 1]!, data[i + 2]!)) n++;
  return n;
}
const red = (r: number, g: number, b: number) => r > 150 && g < 90 && b < 90;
const green = (r: number, g: number, b: number) => g > 170 && r < 120 && b < 120;
const cyan = (r: number, g: number, b: number) => g > 170 && b > 170 && r < 120;

test("looks draw in the web export: a state's aura and embers, a dissolve's edge, particles, a camera punch", async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await loadAnimatedFixture(page);
  const floor = (await page.evaluate(() => window.studio!.getProject().world.playtest.y)) as number;
  await batch(page, [
    { name: "removeRoomSpawn", input: { roomId: "arena", spawnId: "crawler_1" } },
    {
      name: "setBehavior",
      input: {
        characterId: "charger",
        behavior: {
          initial: "burn",
          states: {
            burn: {
              action: { type: "wait" },
              transitions: [],
              look: {
                aura: { color: "#ff1a00", size: 14, pulse: 0 },
                emitter: { shape: "dot", color: "#ffd000", colorEnd: "#ff2000", rate: 60, speed: 70, spread: 60, direction: -90, size: 5, lifetime: 0.8 },
              },
            },
          },
          interrupts: [],
        },
      },
    },
    {
      name: "addHandler",
      input: {
        roomId: "arena",
        handler: {
          on: { type: "roomSettled" },
          do: [
            { type: "dissolve", target: { kind: "prop", prop: "door" }, to: "out", seconds: 4, color: "#00ff00" },
            { type: "emit", at: { kind: "point", x: 140, y: floor - 140 }, emitter: { shape: "star", color: "#00ffff", rate: 120, speed: 40, size: 10, lifetime: 1, additive: false }, seconds: 30 },
            { type: "cameraZoom", amount: 1.3, seconds: 2 },
          ],
        },
      },
    },
  ]);

  // Editing: none of it shows.
  const before = await shot(page);
  expect(count(before, green)).toBeLessThan(20);
  expect(count(before, cyan)).toBeLessThan(20);
  expect(count(before, red)).toBeLessThan(30);

  await page.getByRole("button", { name: "▶ Play", exact: true }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  // The camera punches in (on the first safe ground), then eases back: the most it was zoomed in the first moments.
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    peak = Math.max(peak, (await state(page)).camera?.zoom ?? 0);
    await page.waitForTimeout(80);
  }
  await expect.poll(async () => (await state(page)).entities.find((e) => e.spawnId === "charger_1")?.look ?? null).toEqual(["aura", "emitter"]);
  mkdirSync(SHOTS, { recursive: true });

  // The door dissolving: its bright green edge eats into it.
  await expect.poll(async () => count(await shot(page), green), { timeout: 10_000 }).toBeGreaterThan(60);
  await page.locator("iframe.game-frame").screenshot({ path: `${SHOTS}/dissolve.png` });

  // The charger's state look: a red glow around its silhouette and embers rising.
  await expect.poll(async () => count(await shot(page), red), { timeout: 10_000 }).toBeGreaterThan(150);
  expect((await state(page)).emitters).toBeGreaterThanOrEqual(2);
  await page.locator("iframe.game-frame").screenshot({ path: `${SHOTS}/look.png` });

  // The emitted stars.
  await expect.poll(async () => count(await shot(page), cyan), { timeout: 10_000 }).toBeGreaterThan(60);
  await page.locator("iframe.game-frame").screenshot({ path: `${SHOTS}/emitter.png` });

  // Dissolved out: the door is gone (its colour and its edge), though still a prop of the room.
  await expect.poll(async () => (await state(page)).props.find((p) => p.id === "door")?.dissolved, { timeout: 10_000 }).toBe(true);
  expect(count(await shot(page), green)).toBeLessThan(20);
  const settled = (await state(page)).camera!.zoom;
  expect(peak).toBeGreaterThan(settled * 1.1);

  await page.getByRole("button", { name: "■ Stop" }).click();
  expect(consoleErrors).toEqual([]);
});
