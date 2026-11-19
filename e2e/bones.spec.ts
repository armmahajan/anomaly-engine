import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject } from "./helpers.ts";
import { rigTheCharger } from "./rigFixture.ts";

test.afterEach(({ page }) => resetProject(page));

type Bone = { id: string; parent: string | null; pivot: [number, number] };
const bones = async (page: Page) =>
  ((await page.evaluate(() => window.studio!.getProject())).art.assets.find((a) => a.id === "beetle") as { rig: { bones: Bone[] } }).rig.bones;
const pivot = async (page: Page, id: string) => (await bones(page)).find((b) => b.id === id)!.pivot;

/** Drag a handle on the stage by (dx, dy) screen px. */
async function drag(page: Page, handle: import("@playwright/test").Locator, dx: number, dy: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test("the bone editor: drag a joint (its drawing follows), turn a bone, pose test, undo restores", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await rigTheCharger(page, false);
  await page.getByTestId("character-charger").click();
  await page.getByRole("tab", { name: "Characters" }).click();
  await page.getByRole("button", { name: /② Rig/ }).click();
  await page.getByLabel("Edit bones").check();
  const editor = page.getByTestId("bone-editor");
  const overlay = page.getByTestId("bone-overlay");
  await expect(editor).toBeVisible();
  await expect(overlay.getByTestId("joint-head")).toBeVisible();

  // The handles sit on the joints: the head joint is up and to the right of the root (at the feet).
  const head = (await overlay.getByTestId("joint-head").boundingBox())!;
  const root = (await overlay.getByTestId("joint-root").boundingBox())!;
  expect(head.x).toBeGreaterThan(root.x);
  expect(head.y).toBeLessThan(root.y);

  // Drag the head's joint right: the pivot moves and the horn (its child) comes along.
  const headBefore = await pivot(page, "head");
  const hornBefore = await pivot(page, "horn");
  const before = await projectRevision(page);
  await drag(page, overlay.getByTestId("joint-head"), 40, 0);
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
  const headAfter = await pivot(page, "head");
  expect(headAfter[0]).toBeGreaterThan(headBefore[0] + 2);
  expect(headAfter[1]).toBeCloseTo(headBefore[1], 0);
  const hornAfter = await pivot(page, "horn");
  expect(hornAfter[0] - hornBefore[0]).toBeCloseTo(headAfter[0] - headBefore[0], 1);

  // Undo restores the rig.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(() => pivot(page, "head")).toEqual(headBefore);
  expect(await pivot(page, "horn")).toEqual(hornBefore);

  // Turning the selected bone with its handle is one edit too.
  await editor.getByTestId("bone-head").click();
  const turned = await projectRevision(page);
  await drag(page, overlay.getByTestId("turn-handle"), 0, 30);
  await expect.poll(() => projectRevision(page)).toBe(turned + 1);
  expect(await pivot(page, "horn")).not.toEqual(hornBefore);

  // The pose test turns joints without saving.
  await editor.getByLabel("pose test").check();
  await expect(overlay.getByTestId("pose-preview")).toBeVisible();
  const posing = await projectRevision(page);
  await drag(page, overlay.getByTestId("joint-head"), 0, 30);
  await expect(overlay).toContainText("head");
  expect(await projectRevision(page)).toBe(posing);
  await editor.getByLabel("pose test").uncheck();

  // Bones: add one under the head, then remove it.
  await editor.getByLabel("new bone name").fill("jaw");
  await editor.getByRole("button", { name: "+ Child bone" }).click();
  await expect(editor.getByTestId("bone-jaw")).toBeVisible();
  expect((await bones(page)).find((b) => b.id === "jaw")?.parent).toBe("head");
  expect(consoleErrors).toEqual([]);
});

test("the bone editor: Swap trades two limbs' names and draw order without moving anything; turning without carry leaves the drawing", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await rigTheCharger(page, false);
  await page.getByTestId("character-charger").click();
  await page.getByRole("tab", { name: "Characters" }).click();
  await page.getByRole("button", { name: /② Rig/ }).click();
  await page.getByLabel("Edit bones").check();
  const editor = page.getByTestId("bone-editor");
  const parts = async () =>
    ((await page.evaluate(() => window.studio!.getProject())).art.assets.find((a) => a.id === "beetle") as { rig: { parts: { id: string; bone: string; z: number; shape: unknown }[] } }).rig.parts;

  // Swap the front leg with the back one: the names trade places, the joints and drawings stay put.
  const front = await pivot(page, "leg_front");
  const back = await pivot(page, "leg_back");
  const partsBefore = await parts(page);
  await editor.getByTestId("bone-leg_front").click();
  await editor.getByLabel("swap with bone").selectOption("leg_back");
  let before = await projectRevision(page);
  await editor.getByRole("button", { name: "Swap", exact: true }).click();
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
  expect(await pivot(page, "leg_front")).toEqual(back);
  expect(await pivot(page, "leg_back")).toEqual(front);
  const shapes = (list: { shape: unknown }[]) => list.map((p) => JSON.stringify(p.shape)).sort();
  expect(shapes(await parts(page))).toEqual(shapes(partsBefore));
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(() => pivot(page, "leg_front")).toEqual(front);

  // Without "Carry the drawing", the turn handle re-aims the bone: the horn's joint swings, the drawing stays.
  await editor.getByLabel("Carry the drawing").uncheck();
  await editor.getByTestId("bone-head").click();
  const horn = await pivot(page, "horn");
  before = await projectRevision(page);
  await drag(page, page.getByTestId("bone-overlay").getByTestId("turn-handle"), 0, 30);
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
  expect(await pivot(page, "horn")).not.toEqual(horn);
  expect(await parts(page)).toEqual(partsBefore);
  expect(consoleErrors).toEqual([]);
});
