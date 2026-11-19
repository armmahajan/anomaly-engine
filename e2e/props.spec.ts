import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject, runtimeState, waitForRuntimeAfter } from "./helpers.ts";

test.afterEach(async ({ page }) => resetProject(page));

const arena = (page: Page) => page.evaluate(() => window.studio!.getProject().world.rooms[0]!);
const propOf = async (page: Page, id: string) => (await arena(page)).props.find((p) => p.id === id);

/** Screen point of a room point (the props overlay covers the room exactly). */
async function roomPoint(page: Page, x: number, y: number) {
  const box = (await page.getByTestId("props-overlay").boundingBox())!;
  const scale = box.width / 1600; // the arena is 50 tiles wide
  return { x: box.x + x * scale, y: box.y + y * scale };
}
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await roomPoint(page, ...from);
  const b = await roomPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.up();
}
async function commit(page: Page, label: string, value: string) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press("Enter");
}

test("Props: an item, a pickup and a barrier made in the UI; picking it up opens the barrier", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const r0 = await openStudio(page);
  // No enemies in the way (setup through the API).
  const cleared = await page.request.post("/api/batch", {
    data: { baseRevision: r0, operations: ["crawler_1", "charger_1"].map((spawnId) => ({ name: "removeRoomSpawn", input: { roomId: "arena", spawnId } })) },
  });
  expect(cleared.ok()).toBe(true);
  await waitForRuntimeAfter(page, r0);

  // An item, in the Game tab.
  await page.getByRole("tab", { name: "Game" }).click();
  await page.getByLabel("new item name").fill("Key");
  await page.getByRole("button", { name: "+ Item" }).click();
  await expect(page.getByTestId("item-key")).toBeVisible();

  // The pickup: drawn with the Prop tool (one edit), then its visibility and handler.
  await page.getByRole("tab", { name: "Rooms" }).click();
  await page.getByTestId("tool-prop").click();
  let before = await projectRevision(page);
  await drag(page, [400, 640], [416, 672]);
  await expect.poll(() => propOf(page, "prop_1")).toMatchObject({ x: 400, y: 640, width: 16, height: 32 });
  expect(await projectRevision(page)).toBe(before + 1);
  await expect(page.getByTestId("prop-editor")).toBeVisible();
  await commit(page, "prop name", "Key");
  await expect.poll(async () => (await propOf(page, "prop_1"))?.name).toBe("Key");
  await page.getByLabel("prop visible", { exact: true }).selectOption("while");
  await commit(page, "prop visible condition flag", "got_key");
  await expect.poll(async () => (await propOf(page, "prop_1"))?.visible).toEqual({ type: "flag", flag: "got_key", is: true });
  await page.getByLabel("prop visible condition is").click(); // controlled: it changes once the edit lands
  await expect.poll(async () => (await propOf(page, "prop_1"))?.visible).toEqual({ type: "flag", flag: "got_key", is: false });
  await page.getByTestId("handlers-prop prop_1").getByRole("button", { name: "+ Handler" }).click();
  await expect.poll(async () => (await propOf(page, "prop_1"))?.handlers).toHaveLength(1);
  await page.getByLabel("prop prop_1 0 event", { exact: true }).selectOption("touch");
  await expect.poll(async () => (await propOf(page, "prop_1"))?.handlers[0]?.on).toEqual({ type: "touch" });
  await commit(page, "prop prop_1 0 effect 0 flag", "got_key");
  await expect.poll(async () => (await propOf(page, "prop_1"))?.handlers[0]?.do[0]).toMatchObject({ flag: "got_key" });
  await page.getByRole("button", { name: "add prop prop_1 0 effect" }).click();
  await expect.poll(async () => (await propOf(page, "prop_1"))?.handlers[0]?.do).toHaveLength(2);
  await page.getByLabel("prop prop_1 0 effect 1", { exact: true }).selectOption("giveItem");
  await expect.poll(async () => (await propOf(page, "prop_1"))?.handlers).toEqual([
    { on: { type: "touch" }, when: [], do: [{ type: "setFlag", flag: "got_key", value: true }, { type: "giveItem", item: "key", count: 1 }] },
  ]);

  // The barrier: drawn, moved and resized (one edit each), solid, there while the player has no key.
  await drag(page, [760, 576], [792, 672]);
  await expect.poll(() => propOf(page, "prop_2")).toMatchObject({ x: 760, y: 576, width: 32, height: 96 });
  before = await projectRevision(page);
  await drag(page, [776, 620], [816, 620]);
  await expect.poll(() => propOf(page, "prop_2")).toMatchObject({ x: 800, y: 576 });
  expect(await projectRevision(page)).toBe(before + 1);
  const corner = await page.getByTestId("prop-handle").boundingBox();
  await page.mouse.move(corner!.x + corner!.width / 2, corner!.y + corner!.height / 2);
  await page.mouse.down();
  const wider = await roomPoint(page, 848, 672);
  await page.mouse.move(wider.x, wider.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => propOf(page, "prop_2")).toMatchObject({ x: 800, width: 48, height: 96 });
  expect(await projectRevision(page)).toBe(before + 2);
  await page.getByLabel("prop solid", { exact: true }).selectOption("true");
  await expect.poll(async () => (await propOf(page, "prop_2"))?.solid).toBe(true);
  await page.getByLabel("prop visible", { exact: true }).selectOption("while");
  await expect.poll(async () => typeof (await propOf(page, "prop_2"))?.visible).toBe("object");
  await page.getByLabel("prop visible condition", { exact: true }).selectOption("not");
  await expect.poll(async () => (await propOf(page, "prop_2"))?.visible).toMatchObject({ type: "not" });
  await page.getByLabel("prop visible condition of 0", { exact: true }).selectOption("item");
  await expect.poll(() => propOf(page, "prop_2")).toMatchObject({ solid: true, visible: { type: "not", of: { type: "item", item: "key" } } });

  // Play: the barrier stands until the key is picked up, then the player walks through.
  await page.getByRole("button", { name: "▶ From start" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).props).toEqual([
    { id: "prop_1", visible: true, solid: false, playing: null, look: null, dissolved: false },
    { id: "prop_2", visible: true, solid: true, playing: null, look: null, dissolved: false },
  ]);
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await runtimeState(page)).items, { timeout: 5_000 }).toEqual({ key: 1 });
  const state = await runtimeState(page);
  expect(state.flags).toEqual(["got_key"]);
  expect(state.props).toEqual([
    { id: "prop_1", visible: false, solid: false, playing: null, look: null, dissolved: false },
    { id: "prop_2", visible: false, solid: false, playing: null, look: null, dissolved: false },
  ]);
  await expect.poll(async () => (await runtimeState(page)).entities.find((e) => e.characterId === "player")!.x, { timeout: 5_000 }).toBeGreaterThan(900);
  await page.keyboard.up("ArrowRight");
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  expect(consoleErrors).toEqual([]);
});
