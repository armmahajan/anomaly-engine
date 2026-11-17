import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject, runtimeState } from "./helpers.ts";

const room = (page: Page, id: string) =>
  page.evaluate((id) => window.studio!.getProject().world.rooms.find((r) => r.id === id) ?? null, id);

/** The centre of a cell of the painter canvas (it covers the room exactly). */
async function cellPoint(page: Page, col: number, row: number) {
  const canvas = page.getByTestId("room-painter");
  const box = (await canvas.boundingBox())!;
  const cols = Number(await canvas.getAttribute("data-cols"));
  const rows = Number(await canvas.getAttribute("data-rows"));
  return { x: box.x + ((col + 0.5) * box.width) / cols, y: box.y + ((row + 0.5) * box.height) / rows };
}

test.afterEach(async ({ page }) => resetProject(page));

test("Rooms: create rooms, paint tiles, connect doors, undo", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Rooms" }).click();

  await page.getByLabel("new room name").fill("Cave");
  await page.getByRole("button", { name: "+ Room" }).click();
  await expect(page.getByTestId("room-cave")).toHaveClass(/selected/);
  await expect.poll(async () => (await runtimeState(page)).stage).toBe("room");

  // Drag a solid strip across row 10, columns 3-8: one edit.
  await page.getByTestId("tool-solid").click();
  const before = await projectRevision(page);
  const from = await cellPoint(page, 3, 10);
  const to = await cellPoint(page, 8, 10);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => (await room(page, "cave"))?.grid.rows[10]).toBe(`#..${"#".repeat(6)}${".".repeat(20)}#`);
  expect(await projectRevision(page)).toBe(before + 1);

  // A door on each of two rooms, connected from the second.
  await page.getByLabel("door offset").fill("12");
  await page.getByRole("button", { name: "+ Door" }).click();
  await expect(page.getByTestId("door-door_1")).toBeVisible();
  await page.getByLabel("new room name").fill("Hall");
  await page.getByRole("button", { name: "+ Room" }).click();
  await expect(page.getByTestId("room-hall")).toHaveClass(/selected/);
  await page.getByLabel("door side").selectOption("left");
  await page.getByLabel("door offset").fill("12");
  await page.getByRole("button", { name: "+ Door" }).click();
  await page.getByLabel("door_1 leads to").selectOption({ label: "Cave · door_1" });
  await expect.poll(async () => (await room(page, "cave"))?.doors[0]?.to).toEqual({ room: "hall", door: "door_1" });
  expect((await room(page, "hall"))?.doors[0]?.to).toEqual({ room: "cave", door: "door_1" });
  await expect(page.locator(".world-map line")).toHaveCount(1);

  // Undo takes back the connection only.
  const connected = await projectRevision(page);
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(() => projectRevision(page)).toBe(connected + 1);
  expect((await room(page, "cave"))?.doors[0]?.to).toBeNull();
  expect((await room(page, "hall"))?.doors).toHaveLength(1);
  expect(consoleErrors).toEqual([]);
});

test("Rooms: play from here and walk through a door with the keyboard", async ({ page }) => {
  const r0 = await openStudio(page);
  // Two 20x10 rooms (floor top y 288) joined by doors at rows 6-8.
  const made = await page.request.post("/api/batch", {
    data: {
      baseRevision: r0,
      operations: [
        { name: "createWorldRoom", input: { name: "West", cols: 20, rows: 10 } },
        { name: "createWorldRoom", input: { name: "East", cols: 20, rows: 10 } },
        { name: "setDoor", input: { roomId: "west", door: { id: "out", side: "right", offset: 6, size: 3 } } },
        { name: "setDoor", input: { roomId: "east", door: { id: "in", side: "left", offset: 6, size: 3 } } },
        { name: "connectDoors", input: { from: { roomId: "west", doorId: "out" }, to: { roomId: "east", doorId: "in" } } },
        { name: "addRoomSpawn", input: { roomId: "east", characterId: "crawler", x: 500, y: 288 } },
      ],
    },
  });
  expect(made.ok()).toBe(true);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 1);
  await page.getByRole("tab", { name: "Rooms" }).click();
  await page.getByTestId("room-west").click();

  // Drop the spot near the right wall, standing on the floor.
  await page.getByTestId("tool-spot").click();
  const spot = await cellPoint(page, 15, 8);
  await page.mouse.click(spot.x, spot.y);
  await page.getByRole("button", { name: "▶ Play from here" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).room).toBe("west");
  const start = (await runtimeState(page)).entities.find((e) => e.characterId === "player")!;
  expect(start.y).toBe(288);

  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await runtimeState(page)).room, { timeout: 5_000 }).toBe("east");
  await page.keyboard.up("ArrowRight");
  await expect(page.getByTestId("room-east")).toHaveClass(/selected/); // the sidebar follows the player
  const state = await runtimeState(page);
  expect(state.visited).toEqual(["west", "east"]);
  expect(state.entities.map((e) => e.characterId).sort()).toEqual(["crawler", "player"]);
  const player = state.entities.find((e) => e.characterId === "player")!;
  expect(player.x).toBeLessThan(200);
  expect(player.y).toBe(288);

  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  await expect.poll(async () => (await runtimeState(page)).stage).toBe("room");
  expect((await runtimeState(page)).room).toBe("east"); // shown where the player left off
});
