import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject, runtimeState, waitForRuntimeAfter } from "./helpers.ts";
import { loadAnimatedFixture } from "./animatedFixture.ts";

// The animation target end to end (README "Animation in play"): an object made and drawn in the
// studio (scripted art models) goes on a prop and plays in the game, its clip's marker hurting the
// player; an enemy's windup projectile forms above it, charges, then flies; and a projectile with no
// look still leaves from the shooter's centre at once, as before.

test.afterEach(({ page }) => resetProject(page));

type Projectile = { x: number; y: number; charging: boolean; object: string | null; owner: string };
type PlayState = Awaited<ReturnType<typeof runtimeState>> & {
  props: { id: string; playing: string | null }[];
  markers: { name: string; from: string }[];
  projectiles: Projectile[];
};
const state = (page: Page) => runtimeState(page) as Promise<PlayState>;
const player = async (page: Page) => (await state(page)).entities.find((e) => e.characterId === "player")!;


async function batch(page: Page, operations: { name: string; input: unknown }[]) {
  const before = await projectRevision(page);
  const result = await page.evaluate((calls) => window.studio!.applyBatch(calls), operations);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await waitForRuntimeAfter(page, before);
}

async function play(page: Page) {
  await page.getByRole("button", { name: "▶ Play", exact: true }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
}

test("an object drawn in the studio goes on a prop: touching it plays its clip, and the clip's marker hurts the player", async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);

  // The object, made in the Characters tab.
  await page.getByRole("tab", { name: "Characters" }).click();
  const objects = page.getByTestId("object-list");
  await objects.getByRole("button", { name: "+ Object" }).click();
  await objects.getByLabel("object name").fill("Jaw Trap");
  await objects.getByLabel("object brief").fill("a spring-loaded jaw trap set into the floor");
  await objects.getByRole("button", { name: "Create" }).click();
  await expect(objects.getByTestId("object-jaw_trap")).toHaveAttribute("aria-current", "true");

  // A trap prop under the player's start, drawn with it: touching it snaps, and the snap's strike hurts.
  // No enemies, so only the trap can hurt the player.
  const floor = (await page.evaluate(() => window.studio!.getProject().world.playtest.y)) as number;
  await batch(page, [
    ...["crawler_1", "charger_1"].map((spawnId) => ({ name: "removeRoomSpawn", input: { roomId: "arena", spawnId } })),
    {
      name: "addProp",
      input: {
        roomId: "arena",
        id: "trap",
        name: "Trap",
        x: 136,
        y: floor - 24,
        width: 48,
        height: 24,
        art: { object: "jaw_trap", idle: "idle" },
        handlers: [
          { on: { type: "touch" }, do: [{ type: "playAnimation", target: { kind: "self" }, clip: "snap" }] },
          { on: { type: "marker", name: "strike" }, do: [{ type: "damage", amount: 1 }] },
        ],
      },
    },
  ]);

  // Drawn in one go: the pipeline writes the clips the project uses, with the marker its handler hears.
  const panel = page.getByTestId("art-panel");
  await panel.getByLabel("Auto").check();
  await panel.getByRole("button", { name: "Generate everything" }).click();
  const clips = () =>
    page.evaluate(() => {
      const asset = window.studio!.getProject().art.assets.find((a) => a.id === "jaw_trap") as { clips?: Record<string, { markers: { name: string; t: number }[] }> } | undefined;
      return asset?.clips ?? {};
    });
  await expect.poll(async () => Object.keys(await clips()).sort(), { timeout: 150_000, intervals: [1000] }).toEqual(expect.arrayContaining(["idle", "snap"]));
  const strike = (await clips()).snap!.markers.find((m) => m.name === "strike");
  expect(strike, "the snap clip has the strike marker").toBeDefined();
  expect(strike!.t).toBeGreaterThan(0);
  expect(strike!.t).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  await expect.poll(async () => (await state(page)).props.find((p) => p.id === "trap")).toBeDefined();

  // In play: the trap snaps under the player, the strike marker fires from it, and the player is hurt.
  await play(page);
  const start = (await player(page)).health;
  await expect.poll(async () => (await state(page)).markers, { timeout: 10_000 }).toContainEqual({ name: "strike", from: "prop:trap" });
  await expect.poll(async () => (await player(page)).health).toBeLessThan(start);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  expect(consoleErrors).toEqual([]);
});

test("an enemy's windup projectile forms above it and charges through the windup, then flies", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await loadAnimatedFixture(page);
  await batch(page, [{ name: "removeRoomSpawn", input: { roomId: "arena", spawnId: "charger_1" } }]);

  await play(page);
  // Charging: the bolt sits at its origin, 60 px above the crawler, playing its charge clip.
  let charging: { bolt: Projectile; from: { x: number; y: number } } | undefined;
  await expect
    .poll(
      async () => {
        const s = await state(page);
        const bolt = s.projectiles.find((p) => p.owner === "crawler_1" && p.charging);
        const c = s.entities.find((e) => e.spawnId === "crawler_1");
        if (bolt && c) charging = { bolt, from: { x: c.x, y: c.y } };
        return Boolean(charging);
      },
      { timeout: 10_000, intervals: [50] },
    )
    .toBe(true);
  expect(charging!.bolt.object).toBe("bolt");
  expect(Math.abs(charging!.bolt.x - charging!.from.x)).toBeLessThan(4);
  // The origin is from the crawler's centre: its feet (entity y) less half its 28 px height.
  expect(Math.abs(charging!.bolt.y - (charging!.from.y - 14 - 60))).toBeLessThan(4);

  // Then it launches: no longer charging, and moving away from where it formed.
  await expect
    .poll(
      async () => {
        const bolt = (await state(page)).projectiles.find((p) => p.owner === "crawler_1" && !p.charging);
        return bolt ? Math.hypot(bolt.x - charging!.bolt.x, bolt.y - charging!.bolt.y) : 0;
      },
      { timeout: 5_000, intervals: [50] },
    )
    .toBeGreaterThan(20);
  await page.getByRole("button", { name: "■ Stop" }).click();
  expect(consoleErrors).toEqual([]);
});

test("a projectile with no look leaves from the shooter's centre at once, as before the animation target", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await batch(page, [
    { name: "removeRoomSpawn", input: { roomId: "arena", spawnId: "charger_1" } },
    {
      name: "setBehavior",
      input: {
        characterId: "crawler",
        behavior: {
          initial: "fire",
          states: { fire: { action: { type: "shoot", windup: 0.6, count: 1, speed: 420, aim: "player", lifetime: 3, damage: 1 }, transitions: [] } },
          interrupts: [],
        },
      },
    },
  ]);
  const project = await page.evaluate(() => window.studio!.getProject());
  // Written without a look, the shot gets the default one: today's shots.
  const shoot = (project.characters.find((c) => c.id === "crawler") as { behavior: { states: { fire: { action: { look: unknown } } } } }).behavior.states.fire.action;
  expect(shoot.look).toEqual({ origin: [0, 0], appear: "fire", art: null });

  await play(page);
  let first: { bolt: Projectile; from: { x: number; y: number } } | undefined;
  await expect
    .poll(
      async () => {
        const s = await state(page);
        const bolt = s.projectiles.find((p) => p.owner === "crawler_1");
        const c = s.entities.find((e) => e.spawnId === "crawler_1");
        if (bolt && c) first = { bolt, from: { x: c.x, y: c.y } };
        return Boolean(first);
      },
      { timeout: 10_000, intervals: [30] },
    )
    .toBe(true);
  // Never charging, no art, and fired from about the shooter's centre (it has moved a frame or two since).
  expect(first!.bolt).toMatchObject({ charging: false, object: null });
  expect(Math.hypot(first!.bolt.x - first!.from.x, first!.bolt.y - first!.from.y)).toBeLessThan(40);
  expect((await state(page)).props).toEqual([]);
  await page.getByRole("button", { name: "■ Stop" }).click();
  expect(consoleErrors).toEqual([]);
});
