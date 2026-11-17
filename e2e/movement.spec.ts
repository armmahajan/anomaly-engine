import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, entity, openStudio, projectRevision, runtimeState } from "./helpers.ts";

const bat = {
  id: "bat",
  kind: "enemy",
  name: "Bat",
  color: "#6b5b95",
  size: { width: 30, height: 20 },
  movement: "flying",
  stats: { knockback: 300 },
  behavior: {
    initial: "bob",
    states: {
      bob: { action: { type: "hover", amplitude: 20, period: 1 }, transitions: [{ when: { type: "playerWithin", distance: 300 }, to: "dive" }] },
      dive: { action: { type: "charge", speed: 500, direction: "towardPlayer" }, transitions: [{ when: { type: "actionDone" }, to: "bob" }] },
    },
  },
};

const crawlerPatrol = (page: Page) =>
  page.evaluate(() => {
    const crawler = window.studio!.getProject().characters.find((c) => c.id === "crawler");
    return crawler?.kind === "enemy" ? crawler.behavior.states.patrol!.action : null;
  });

test("flying enemies, new setting controls, and replaying a run's seed", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const r0 = await openStudio(page);
  const status = page.getByTestId("runtime-status");

  const created = await page.request.post("/api/batch", {
    data: {
      baseRevision: r0,
      operations: [
        { name: "createCharacter", input: { character: bat } },
        { name: "addRoomSpawn", input: { roomId: "arena", characterId: "bat", x: 1000, y: 300 } },
      ],
    },
  });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 1);

  await page.getByTestId("character-bat").click();
  await expect(page.getByLabel("Movement")).toHaveValue("flying");
  await expect(page.getByLabel("dive direction")).toHaveValue("towardPlayer");

  await page.getByTestId("character-crawler").click();
  await page.getByLabel("patrol turnAtLedge").check();
  await expect.poll(() => crawlerPatrol(page)).toMatchObject({ turnAtLedge: true });
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(await projectRevision(page));

  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(status).toHaveText("Playing");
  const seed = (await runtimeState(page)).seed;
  expect(seed).not.toBeNull();
  await page.waitForTimeout(800);
  const hovering = await entity(page, "bat");
  expect(hovering).toMatchObject({ behaviorState: "bob" });
  expect(Math.abs(hovering.y - 300)).toBeLessThan(25);

  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(status).toHaveText("Editing");
  await page.getByRole("button", { name: `⟲ Seed ${seed}` }).click();
  await expect(status).toHaveText("Playing");
  expect((await runtimeState(page)).seed).toBe(seed);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(status).toHaveText("Editing");

  await page.getByLabel("patrol turnAtLedge").uncheck();
  await expect.poll(() => crawlerPatrol(page)).toMatchObject({ turnAtLedge: false });
  const cleanup = await page.request.post("/api/ops", {
    data: { name: "deleteCharacter", input: { characterId: "bat" }, baseRevision: await projectRevision(page) },
  });
  expect(cleanup.ok()).toBe(true);
  expect(consoleErrors).toEqual([]);
});
