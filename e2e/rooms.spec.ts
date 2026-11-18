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

test("Rooms: grouped by region, filtered, picked on the map; the tool groups are labelled", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const r0 = await openStudio(page);
  // 30 rooms in two regions (and the arena): more than fit, so only the selected room's region starts open.
  const operations: { name: string; input: unknown }[] = [
    { name: "createRegion", input: { region: { id: "caves", name: "The Caves", rooms: 15, status: "canon" } } },
    { name: "createRegion", input: { region: { id: "spire", name: "The Spire", rooms: 10, status: "canon" } } },
  ];
  for (let i = 1; i <= 15; i++) operations.push({ name: "createWorldRoom", input: { name: `Cave ${i}`, cols: 12, rows: 8, regionId: "caves" } });
  for (let i = 1; i <= 15; i++) operations.push({ name: "createWorldRoom", input: { name: `Spire ${i}`, cols: 12, rows: 8, regionId: "spire" } });
  const made = await page.request.post("/api/batch", { data: { baseRevision: r0, operations } });
  expect(made.ok()).toBe(true);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 1);
  await page.getByRole("tab", { name: "Rooms" }).click();

  await expect(page.getByRole("toolbar", { name: "Paint tiles" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Place" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Play" }).getByText("Play with")).toBeVisible();

  const caves = page.getByTestId("region-group-caves");
  const spire = page.getByTestId("region-group-spire");
  await expect(caves).toContainText("The Caves");
  await expect(caves).toContainText("15 · 0 dressed");
  await expect(spire).toContainText("15/10");
  await expect(page.getByTestId("room-spire_3")).toHaveCount(0); // collapsed
  await spire.getByRole("button", { name: /The Spire/ }).click();
  await expect(page.getByTestId("room-spire_3")).toBeVisible();
  await spire.getByRole("button", { name: /The Spire/ }).click();
  await expect(page.getByTestId("room-spire_3")).toHaveCount(0);

  // A click on the map selects the room and opens its region.
  await page.getByTestId("map-room-spire_7").dispatchEvent("click");
  await expect(page.getByTestId("room-spire_7")).toHaveClass(/selected/);
  await expect(page.getByTestId("map-room-spire_7")).toHaveClass(/selected/);
  await expect(page.getByTestId("rooms-bench")).toContainText("Spire 7");
  await expect(page.getByTestId("rooms-bench")).toContainText("The Spire");
  await expect(page.getByTestId("room-art-chip")).toContainText("plain tiles");

  // The filter narrows every region at once.
  await page.getByLabel("filter rooms", { exact: true }).fill("cave 1");
  await expect(page.getByTestId("room-cave_1")).toBeVisible();
  await expect(page.getByTestId("room-cave_12")).toBeVisible();
  await expect(page.getByTestId("room-cave_2")).toHaveCount(0);
  await expect(page.getByTestId("region-group-spire")).toHaveCount(0);
  await page.getByLabel("filter rooms", { exact: true }).fill("");
  await page.getByLabel("filter rooms by scenery").selectOption("dressed");
  await expect(page.getByText("No rooms match.")).toBeVisible();
  await page.getByLabel("filter rooms by scenery").selectOption("plain");
  await expect(page.getByTestId("room-spire_7")).toBeVisible();

  // A plain room points to Scenery (no looks yet).
  await expect(page.getByTestId("room-scenery")).toHaveAttribute("data-art", "plain");
  await page.getByTestId("room-scenery").getByRole("button", { name: "Open Scenery" }).click();
  await expect(page.getByRole("tab", { name: "Scenery" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("room to dress first")).toHaveValue("spire_7");
  expect(consoleErrors).toEqual([]);
});
