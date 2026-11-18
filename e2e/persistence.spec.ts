import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_DATA_DIR } from "./paths.ts";
import { collectConsoleErrors, entity, patrolSpeedField, openStudio, projectRevision, runtimeState, setPatrolSpeed } from "./helpers.ts";

// Second target: the project lives on the server (disk), survives reloads,
// can be undone, and can be edited from outside the UI (the AI's path).

async function diskSpeed(): Promise<number> {
  const project = JSON.parse(await readFile(join(E2E_DATA_DIR, "project.json"), "utf8"));
  return project.characters.find((c: { id: string }) => c.id === "crawler").behavior.states.patrol.action.speed;
}

const speedOp = (speed: number, baseRevision: number) => ({
  name: "updateBehavior",
  input: { characterId: "crawler", stateId: "patrol", action: { speed } },
  baseRevision,
  author: "ai",
});

test("edits persist, undo works, and outside edits reach the studio", async ({ page }) => {
  const request = page.request; // shares the page's auth cookie
  const consoleErrors = collectConsoleErrors(page);

  const r0 = await openStudio(page);
  const speedField = patrolSpeedField(page);
  const before = Number(await speedField.inputValue());

  // Edit -> written to disk.
  await setPatrolSpeed(page, "222");
  await expect(page.getByTestId("save-status")).toHaveAttribute("title", new RegExp(`change #${r0 + 1}\\)`)); // saved as that revision
  expect(await diskSpeed()).toBe(222);

  // Reload -> still there, and the runtime is rebuilt from it.
  await page.reload();
  await openStudio(page);
  await expect(speedField).toHaveValue("222");

  // Undo via the button -> previous value, recorded as a new revision.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect(speedField).toHaveValue(String(before));
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 2);
  expect(await diskSpeed()).toBe(before);

  // Undo via keyboard after another edit.
  await setPatrolSpeed(page, "250");
  await expect(speedField).toHaveValue("250");
  // Leave the text field (and stay out of the game iframe) so Ctrl+Z means project undo.
  await page.getByRole("heading", { name: "Characters" }).click();
  await page.keyboard.press("Control+z");
  await expect(speedField).toHaveValue(String(before));
  const r1 = await projectRevision(page);

  // Outside edit over plain HTTP (the AI's path) shows up in the open studio.
  const res = await request.post("/api/ops", { data: speedOp(333, r1) });
  expect(res.status()).toBe(200);
  await expect(speedField).toHaveValue("333");
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r1 + 1);

  // An edit based on an old revision is rejected.
  const stale = await request.post("/api/ops", { data: speedOp(444, r1) });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "stale_revision" } });

  // During a playtest the server rejects outside edits too.
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  const locked = await request.post("/api/ops", { data: speedOp(444, r1 + 1) });
  expect(locked.status()).toBe(409);
  expect(await locked.json()).toMatchObject({ error: { code: "locked" } });
  await expect.poll(async () => Math.abs((await entity(page, "crawler")).velocityX)).toBe(333);

  // After stopping, outside edits work again.
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  await expect
    .poll(async () => (await request.post("/api/ops", { data: speedOp(90, r1 + 1) })).status())
    .toBe(200);
  await expect(speedField).toHaveValue("90");

  // History records who did what.
  const history = (await (await request.get("/api/history")).json()).entries as {
    revision: number;
    author: string;
    summary: string;
  }[];
  expect(history.slice(-6).map((e) => `${e.revision} ${e.author}: ${e.summary}`)).toEqual([
    `${r0 + 1} user: updateBehavior`,
    `${r0 + 2} user: undo revision ${r0 + 1}`,
    `${r0 + 3} user: updateBehavior`,
    `${r0 + 4} user: undo revision ${r0 + 3}`,
    `${r0 + 5} ai: updateBehavior`,
    `${r0 + 6} ai: updateBehavior`,
  ]);

  expect(consoleErrors).toEqual([]);
});
