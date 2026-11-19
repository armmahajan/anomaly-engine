import { expect, test, type Locator, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject, runtimeState } from "./helpers.ts";
import { loadAnimatedFixture } from "./animatedFixture.ts";

// Looks in the studio (core art/animation.ts Look, Emitter; README "Looks"): the handler editor offers
// setLook, clearLook, emit, dissolve and cameraZoom and the stateEntered event with their pickers
// (colours, targets and places, behavior states), and a behavior state's look is edited in the
// inspector (previewed on the character stage). Only the studio and the saved project are checked here:
// drawing looks is the runtime's (game/test/looks.test.ts).

test.afterEach(({ page }) => resetProject(page));

const project = (page: Page) => page.evaluate(() => window.studio!.getProject());
const arena = async (page: Page) => (await project(page)).world.rooms.find((r) => r.id === "arena")!;

/** Wait for one more saved revision after `action`. */
async function oneEdit(page: Page, action: () => Promise<unknown>) {
  const before = await projectRevision(page);
  await action();
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
}
const type = (page: Page, field: Locator, value: string) =>
  oneEdit(page, async () => {
    await field.fill(value);
    await field.press("Enter");
  });

test("the handler editor offers the look effects and stateEntered with colour, target, place and state pickers, and saves them", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await loadAnimatedFixture(page);
  await page.getByRole("tab", { name: "Rooms" }).click();

  // A spawn's handler: stateEntered offers its own enemy's states; setLook on itself with a tint, brightness, an aura and an emitter.
  await page.getByTestId("spawn-details-crawler_1").locator("summary").click();
  const crawler = page.getByTestId("handlers-crawler_1");
  await oneEdit(page, () => crawler.getByRole("button", { name: "+ Handler", exact: true }).click());
  await expect(crawler.getByLabel("crawler_1 0 event", { exact: true }).locator("option")).toHaveText(["enemyKilled", "marker", "stateEntered"]);
  await oneEdit(page, () => crawler.getByLabel("crawler_1 0 event", { exact: true }).selectOption("stateEntered"));
  await expect(crawler.getByLabel("crawler_1 0 event state", { exact: true }).locator("option")).toHaveText(["(any state)", "rest", "fire"]);
  await oneEdit(page, () => crawler.getByLabel("crawler_1 0 event state", { exact: true }).selectOption("fire"));
  await oneEdit(page, () => crawler.getByLabel("crawler_1 0 effect 0", { exact: true }).selectOption("setLook"));
  await expect(crawler.getByLabel("crawler_1 0 effect 0 target", { exact: true })).toHaveValue("self");
  await oneEdit(page, () => crawler.getByRole("button", { name: "add crawler_1 0 effect 0 look tint", exact: true }).click());
  await oneEdit(page, () => crawler.getByLabel("crawler_1 0 effect 0 look tint color", { exact: true }).fill("#ff2200"));
  await type(page, crawler.getByLabel("crawler_1 0 effect 0 look tint amount", { exact: true }), "0.6");
  await type(page, crawler.getByLabel("crawler_1 0 effect 0 look brightness", { exact: true }), "1.8");
  await oneEdit(page, () => crawler.getByRole("button", { name: "add crawler_1 0 effect 0 look aura", exact: true }).click());
  await oneEdit(page, () => crawler.getByLabel("crawler_1 0 effect 0 look aura color", { exact: true }).fill("#ff4400"));
  await oneEdit(page, () => crawler.getByRole("button", { name: "add crawler_1 0 effect 0 look emitter", exact: true }).click());
  await oneEdit(page, () => crawler.getByLabel("crawler_1 0 effect 0 look emitter shape", { exact: true }).selectOption("spark"));
  await oneEdit(page, () => crawler.getByLabel("crawler_1 0 effect 0 look emitter color", { exact: true }).fill("#ffaa00"));
  await oneEdit(page, () => crawler.getByRole("button", { name: "add crawler_1 0 effect 0 look emitter colorEnd", exact: true }).click());
  await type(page, crawler.getByLabel("crawler_1 0 effect 0 look emitter rate", { exact: true }), "40");
  await type(page, crawler.getByLabel("crawler_1 0 effect 0 seconds", { exact: true }), "2");
  let spawn = (await arena(page)).spawns.find((s) => s.id === "crawler_1")!;
  expect(spawn.handlers[0]).toEqual({
    on: { type: "stateEntered", state: "fire" },
    when: [],
    do: [
      {
        type: "setLook",
        target: { kind: "self" },
        look: {
          tint: { color: "#ff2200", amount: 0.6 },
          brightness: 1.8,
          aura: { color: "#ff4400", size: 12, pulse: 0.3 },
          emitter: { shape: "spark", color: "#ffaa00", colorEnd: "#ffffff", rate: 40, burst: 0, lifetime: 0.6, speed: 80, spread: 360, direction: -90, gravity: 0, size: 4, additive: true },
        },
        seconds: 2,
        fade: 0.2,
      },
    ],
  });
  // Optional parts come off again.
  await oneEdit(page, () => crawler.getByRole("button", { name: "remove crawler_1 0 effect 0 look tint", exact: true }).click());
  spawn = (await arena(page)).spawns.find((s) => s.id === "crawler_1")!;
  expect(spawn.handlers[0]!.do[0]).not.toHaveProperty("look.tint");

  // A room's handlers: emit at a point, dissolve a spawn in, a camera zoom, clearLook on the player; stateEntered filtered by a spawn and its states.
  const room = page.getByTestId("handlers-room arena");
  await oneEdit(page, () => room.getByRole("button", { name: "+ Handler", exact: true }).click());
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 0", { exact: true }).selectOption("emit"));
  await expect(room.getByLabel("room arena 0 effect 0 at", { exact: true })).not.toHaveValue("self");
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 0 at", { exact: true }).selectOption("point"));
  await type(page, room.getByLabel("room arena 0 effect 0 at x", { exact: true }), "200");
  await type(page, room.getByLabel("room arena 0 effect 0 at y", { exact: true }), "300");
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 0 emitter shape", { exact: true }).selectOption("star"));
  await type(page, room.getByLabel("room arena 0 effect 0 emitter rate", { exact: true }), "0");
  await type(page, room.getByLabel("room arena 0 effect 0 emitter burst", { exact: true }), "16");
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 0 emitter additive", { exact: true }).click()); // a controlled box: it shows the saved value once saved

  await oneEdit(page, () => room.getByRole("button", { name: "add room arena 0 effect", exact: true }).click());
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 1", { exact: true }).selectOption("dissolve"));
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 1 target", { exact: true }).selectOption("spawn"));
  await expect(room.getByLabel("room arena 0 effect 1 target spawn", { exact: true }).locator("option")).toContainText(["crawler_1", "charger_1"]);
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 1 target spawn", { exact: true }).selectOption("charger_1"));
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 1 to", { exact: true }).selectOption("in"));
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 1 color", { exact: true }).fill("#88ccff"));

  await oneEdit(page, () => room.getByRole("button", { name: "add room arena 0 effect", exact: true }).click());
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 2", { exact: true }).selectOption("cameraZoom"));
  await type(page, room.getByLabel("room arena 0 effect 2 amount", { exact: true }), "1.3");

  await oneEdit(page, () => room.getByRole("button", { name: "add room arena 0 effect", exact: true }).click());
  await oneEdit(page, () => room.getByLabel("room arena 0 effect 3", { exact: true }).selectOption("clearLook"));
  await expect(room.getByLabel("room arena 0 effect 3 target", { exact: true })).toHaveValue("player");

  expect((await arena(page)).handlers[0]!.do).toEqual([
    { type: "emit", at: { kind: "point", x: 200, y: 300 }, offset: [0, 0], emitter: { shape: "star", color: "#ffffff", rate: 0, burst: 16, lifetime: 0.6, speed: 80, spread: 360, direction: -90, gravity: 0, size: 4, additive: false }, seconds: 0.5, layer: "front" },
    { type: "dissolve", target: { kind: "spawn", spawn: "charger_1" }, to: "in", seconds: 0.4, color: "#88ccff" },
    { type: "cameraZoom", amount: 1.3, seconds: 0.3 },
    { type: "clearLook", target: { kind: "player" }, fade: 0.2 },
  ]);

  // stateEntered on a room: `from` offers only spawns; with one, its enemy's states.
  await oneEdit(page, () => room.getByRole("button", { name: "+ Handler", exact: true }).click());
  await oneEdit(page, () => room.getByLabel("room arena 1 event", { exact: true }).selectOption("stateEntered"));
  await expect(room.getByLabel("room arena 1 event from", { exact: true }).locator("option")).toHaveText(["(any from)", "spawn"]);
  await oneEdit(page, () => room.getByLabel("room arena 1 event from", { exact: true }).selectOption("spawn"));
  await oneEdit(page, () => room.getByLabel("room arena 1 event from spawn", { exact: true }).selectOption("charger_1"));
  await expect(room.getByLabel("room arena 1 event state", { exact: true }).locator("option")).toHaveText(["(any state)", "patrol", "windup", "charge", "recover"]);
  await oneEdit(page, () => room.getByLabel("room arena 1 event state", { exact: true }).selectOption("charge"));
  await oneEdit(page, () => room.getByLabel("room arena 1 effect 0", { exact: true }).selectOption("shake"));
  expect((await arena(page)).handlers[1]).toEqual({ on: { type: "stateEntered", from: { kind: "spawn", spawn: "charger_1" }, state: "charge" }, when: [], do: [{ type: "shake", strength: 8, seconds: 0.3 }] });

  // Props hear no enemy's states.
  await page.getByTestId("prop-trap").click();
  await expect(page.getByTestId("handlers-prop trap").getByLabel("prop trap 0 event", { exact: true }).locator("option", { hasText: "stateEntered" })).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("a behavior state's look: edited in the inspector (one undoable edit each), previewed on the character stage", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await loadAnimatedFixture(page);
  await page.getByTestId("character-charger").click();
  const look = page.getByTestId("state-look-windup");
  await expect(look).toContainText("Look: none");
  await look.getByRole("button", { name: "windup look", exact: true }).click();
  // The charger is drawn: its stage previews the open state's look.
  await expect.poll(async () => (await runtimeState(page)).stage).toBe("character");

  await oneEdit(page, () => look.getByRole("button", { name: "add windup look aura", exact: true }).click());
  await oneEdit(page, () => look.getByLabel("windup look aura color", { exact: true }).fill("#ffd27a"));
  await type(page, look.getByLabel("windup look aura size", { exact: true }), "20");
  await type(page, look.getByLabel("windup look brightness", { exact: true }), "1.6");
  const windup = async () => {
    const c = (await project(page)).characters.find((x) => x.id === "charger") as { behavior: { states: Record<string, { look?: unknown }> } };
    return c.behavior.states.windup!.look;
  };
  expect(await windup()).toEqual({ aura: { color: "#ffd27a", size: 20, pulse: 0.3 }, brightness: 1.6 });
  await expect(look).toContainText("Look: brightness, aura");

  // Undo takes the last edit back.
  await oneEdit(page, () => page.getByRole("button", { name: "↶ Undo", exact: true }).click());
  expect(await windup()).toEqual({ aura: { color: "#ffd27a", size: 20, pulse: 0.3 } });

  await oneEdit(page, () => look.getByRole("button", { name: "Remove look", exact: true }).click());
  expect(await windup()).toBeUndefined();

  // Closing it goes back to the game.
  await look.getByRole("button", { name: "windup look", exact: true }).click();
  await expect.poll(async () => (await runtimeState(page)).stage).toBe("game");
  expect(consoleErrors).toEqual([]);
});
