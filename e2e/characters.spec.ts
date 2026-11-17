import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, commitField, openStudio, projectRevision, runtimeState } from "./helpers.ts";

// Items 1-4 of the pre-agent list: create / duplicate / delete characters,
// place / move / remove spawns, and atomic batches, all reaching the runtime.

const spawnIds = async (page: Page) => (await runtimeState(page)).entities.map((e) => e.spawnId);
const characterIds = (page: Page) => page.evaluate(() => window.studio!.getProject().characters.map((c) => c.id));

/** The runtime has rebuilt from the latest project revision. */
async function synced(page: Page) {
  const revision = await projectRevision(page);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(revision);
}

test("create, duplicate, place, move, remove and delete characters", async ({ page }) => {
  const request = page.request; // shares the page's auth cookie
  const consoleErrors = collectConsoleErrors(page);
  page.on("dialog", (dialog) => void dialog.accept()); // confirm deletions
  const r0 = await openStudio(page);
  const before = await characterIds(page);

  // + Enemy: one undoable change that creates the type and places it.
  await page.getByRole("button", { name: "+ Enemy" }).click();
  await expect.poll(async () => (await characterIds(page)).length).toBe(before.length + 1);
  const enemyId = (await characterIds(page)).at(-1)!;
  await expect(page.getByTestId(`character-${enemyId}`)).toHaveClass(/selected/);
  await synced(page);
  expect(await projectRevision(page)).toBe(r0 + 1);
  const enemy = (await runtimeState(page)).entities.find((e) => e.characterId === enemyId);
  expect(enemy).toMatchObject({ behaviorState: "patrol" });

  // Duplicate the Charger: a new type with the same behavior, placed beside it.
  await page.getByTestId("character-charger").click();
  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(page.getByTestId("character-charger_copy")).toHaveClass(/selected/);
  await synced(page);
  expect(await spawnIds(page)).toContain("charger_copy_1");

  // The copy is independent: editing it leaves the original alone.
  await commitField(page, page.getByLabel("charge speed"), "800");
  const speeds = await page.evaluate(() =>
    window.studio!.getProject().characters.flatMap((c) =>
      c.kind === "enemy" && c.behavior.states.charge ? [[c.id, (c.behavior.states.charge.action as { speed: number }).speed]] : [],
    ),
  );
  expect(Object.fromEntries(speeds)).toMatchObject({ charger: 520, charger_copy: 800 });

  // Place a second copy, move it, remove it.
  await page.getByRole("button", { name: "+ Add to room" }).click();
  await expect(page.getByTestId("spawn-charger_copy_2")).toBeVisible();
  await commitField(page, page.getByLabel("charger_copy_2 x"), "1300");
  expect((await runtimeState(page)).entities.find((e) => e.spawnId === "charger_copy_2")).toMatchObject({ x: 1300 });
  await page.screenshot({ path: "test-results/6-characters.png" });
  await page.getByRole("button", { name: "remove charger_copy_2" }).click();
  await expect(page.getByTestId("spawn-charger_copy_2")).toHaveCount(0);
  await synced(page);
  expect(await spawnIds(page)).not.toContain("charger_copy_2");

  // Delete the original Charger: gone from the project and the running game.
  await page.getByTestId("character-charger").click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("character-charger")).toHaveCount(0);
  await synced(page);
  expect((await runtimeState(page)).entities.some((e) => e.characterId === "charger")).toBe(false);

  // The game still plays without it.
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => Math.abs((await runtimeState(page)).entities.find((e) => e.characterId === "crawler")!.velocityX)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");

  // One undo brings the Charger and its spawn back.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect(page.getByTestId("character-charger")).toBeVisible();
  await synced(page);
  expect(await spawnIds(page)).toContain("charger_1");

  // Batches over HTTP (the agent's path): atomic failure, then success.
  const revision = await projectRevision(page);
  const lurker = {
    id: "lurker",
    kind: "enemy",
    name: "Lurker",
    color: "#3f7f7f",
    size: { width: 30, height: 30 },
    stats: { knockback: 300 },
    behavior: {
      initial: "idle",
      states: {
        idle: { action: { type: "wait" }, transitions: [{ when: { type: "playerWithin", distance: 200 }, to: "chase" }] },
        chase: { action: { type: "chase", speed: 140 }, transitions: [{ when: { type: "playerBeyond", distance: 350 }, to: "idle" }] },
      },
    },
  };
  const failing = await request.post("/api/batch", {
    data: {
      baseRevision: revision,
      author: "ai",
      operations: [
        { name: "createCharacter", input: { character: lurker } },
        { name: "addRoomSpawn", input: { roomId: "arena", characterId: "lurker", x: 1000, y: 660 } },
        { name: "updateBehavior", input: { characterId: "lurker", stateId: "chase", action: { speed: -5 } } },
      ],
    },
  });
  expect(failing.status()).toBe(422);
  expect((await failing.json()).error.message).toContain("batch step 3 (updateBehavior) failed");
  expect(await projectRevision(page)).toBe(revision);
  expect(await characterIds(page)).not.toContain("lurker");

  const succeeding = await request.post("/api/batch", {
    data: {
      baseRevision: revision,
      author: "ai",
      operations: [
        { name: "createCharacter", input: { character: lurker } },
        { name: "addRoomSpawn", input: { roomId: "arena", characterId: "lurker", x: 1000, y: 660 } },
      ],
    },
  });
  expect(succeeding.status()).toBe(200);
  await expect(page.getByTestId("character-lurker")).toBeVisible();
  await synced(page);
  expect((await runtimeState(page)).entities.find((e) => e.characterId === "lurker")).toMatchObject({
    spawnId: "lurker_1",
    behaviorState: "idle",
  });

  // Clean up so other tests see the default cast (one batch).
  const cleanup = await page.evaluate(
    (ids) => window.studio!.applyBatch(ids.map((characterId) => ({ name: "deleteCharacter", input: { characterId } }))),
    [enemyId, "charger_copy", "lurker"],
  );
  expect(cleanup.ok).toBe(true);
  expect(await characterIds(page)).toEqual(before);

  expect(consoleErrors).toEqual([]);
});
