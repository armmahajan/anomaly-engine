import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject } from "./helpers.ts";
import { E2E_TOKEN } from "./paths.ts";

// The Architect view: the plan as an editable document (room cards by region) and the run in the sidebar.
// The default layout/geometry/population stages are stubs for now, so these test the UI flow, not built rooms.

test.afterEach(async ({ page }) => resetProject(page));

/** gate (start) -> city (its boss grants Dash) -dash-> deep (ending): 3 + 4 + 2 rooms. */
async function withProgression(page: Page) {
  const result = await page.evaluate(() =>
    window.studio!.applyBatch([
      { name: "createRegion", input: { region: { id: "gate", name: "Sunken Gate", status: "canon", rooms: 3, enemies: ["crawler"] } } },
      { name: "createRegion", input: { region: { id: "city", name: "Drowned City", status: "canon", rooms: 4, enemies: ["crawler", "charger"], boss: "charger" } } },
      { name: "createRegion", input: { region: { id: "deep", name: "The Deep", status: "canon", rooms: 2 } } },
      { name: "createAbility", input: { ability: { id: "dash", name: "Dash", status: "canon", mechanic: "dash", obtainedIn: { regionId: "city", source: "boss" } } } },
      { name: "createConnection", input: { connection: { id: "gate_city", status: "canon", from: "gate", to: "city" } } },
      { name: "createConnection", input: { connection: { id: "city_deep", status: "canon", from: "city", to: "deep", requires: ["dash"] } } },
      { name: "setProgressionEnds", input: { start: "gate", ending: "deep" } },
    ]),
  );
  expect(result.ok).toBe(true);
}

const planRoom = (page: Page, id: string) => page.evaluate((roomId) => window.studio!.getProject().architect.rooms.find((r) => r.id === roomId), id);
const stageStatus = (page: Page, stage: string) =>
  page.evaluate((s) => window.studio!.getProject().architect.stages[s as "plan"]?.status ?? "pending", stage);

async function openArchitect(page: Page, seed = true) {
  await page.getByRole("tab", { name: "Architect" }).click();
  await expect(page.getByTestId("architect-main")).toBeVisible();
  if (seed) {
    await page.getByRole("button", { name: "Start from the progression" }).click();
    await expect(page.getByTestId("room-card-gate_1")).toBeVisible({ timeout: 15_000 });
  }
}

const card = (page: Page, id: string) => page.getByTestId(`room-card-${id}`);
/** The real stages build, prove and repair: wait for the run to end (its outcome shows under "Last run"). */
const runEnded = (page: Page, timeout = 240_000) =>
  expect(page.getByTestId("architect-last")).toContainText(/finished|failed|paused|cancelled/, { timeout });

/** Resolves when the server's event stream reports an Architect run under way (then stops listening). */
async function watchForRun(url: string): Promise<void> {
  const response = await fetch(url, { headers: { "x-studio-token": E2E_TOKEN } });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the event stream ended before a run started");
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop()!;
      for (const event of events) {
        if (!event.startsWith("data: ")) continue;
        const data = JSON.parse(event.slice(6)) as { type: string; architect?: { running: unknown } };
        if (data.type === "architect" && data.architect!.running) return;
      }
    }
  } finally {
    void reader.cancel();
  }
}

async function expand(page: Page, id: string) {
  const toggle = card(page, id).locator(".room-card-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(card(page, id).locator(".room-card-body")).toBeVisible();
}

test("Start from the progression creates room cards grouped by region", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await withProgression(page);
  await openArchitect(page, false);
  await expect(page.getByTestId("architect-empty")).toContainText("Start the plan from the progression (3 regions, 1 abilities and keys)");
  await page.getByRole("button", { name: "Start from the progression" }).click();

  // Regions in the order the player meets them, each with its rooms.
  const regions = page.locator(".architect-region-head h2");
  await expect(regions).toHaveText(["Sunken Gate", "Drowned City", "The Deep"]);
  await expect(page.getByTestId("architect-region-gate").locator(".room-card")).toHaveCount(3);
  await expect(page.getByTestId("architect-region-city").locator(".room-card")).toHaveCount(4);
  await expect(page.getByTestId("architect-region-deep").locator(".room-card")).toHaveCount(2);
  await expect(page.getByTestId("architect-stats")).toContainText("9 rooms");

  // Cards summarize what each room holds: the start, the guardian that grants Dash, the ending.
  await expect(card(page, "gate_1")).toContainText("▶ start");
  await expect(card(page, "city_4")).toContainText("☠ Charger → Dash");
  await expect(card(page, "deep_2")).toContainText("★ ending");

  // A card opens into its plan; a link jumps to the room on the other end.
  await expand(page, "city_4");
  await expect(card(page, "city_4").getByTestId("room-link-city_deep")).toContainText("The Deep 1");
  await expect(card(page, "city_4").getByTestId("room-link-city_deep").getByRole("button", { name: "Dash", pressed: true })).toBeVisible();
  await card(page, "city_4").getByTestId("room-link-city_deep").getByRole("button", { name: "The Deep 1", exact: true }).click();
  await expect(card(page, "deep_1")).toHaveClass(/focused/);
  await expect(card(page, "deep_1").locator(".room-card-body")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("editing a room changes the plan, one operation per edit; Undo reverts one edit", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await withProgression(page);
  await openArchitect(page);
  await expand(page, "gate_2");
  const room = card(page, "gate_2");

  /** Do `edit` and wait until it is saved as exactly one new revision. */
  const oneEdit = async (edit: () => Promise<void>, check: () => Promise<boolean>) => {
    const before = await projectRevision(page);
    await edit();
    await expect.poll(check).toBe(true);
    expect(await projectRevision(page)).toBe(before + 1);
  };

  // Size.
  await oneEdit(
    async () => {
      await room.getByLabel("Width in tiles").fill("60");
      await room.getByLabel("Width in tiles").press("Enter");
    },
    async () => (await planRoom(page, "gate_2"))?.cols === 60,
  );
  await expect(room.getByTestId("room-screens")).toHaveText("tiles, about 2 screens");

  // A terrain knob.
  await oneEdit(
    () => room.getByLabel("Hazards").fill("0.8"),
    async () => (await planRoom(page, "gate_2"))?.terrain.hazards === 0.8,
  );

  // Notes: typed character by character, saved once.
  await oneEdit(
    async () => {
      await room.getByLabel("Room notes").pressSequentially("A long flooded hall.", { delay: 20 });
      await room.getByLabel("Room notes").blur();
    },
    async () => (await planRoom(page, "gate_2"))?.notes === "A long flooded hall.",
  );

  // An enemy, then make it a new kind (the cast stage will create it).
  const enemies = () => room.getByTestId("content-enemy");
  const before = await enemies().count();
  await oneEdit(
    () => room.getByRole("button", { name: "+ Enemy" }).click(),
    async () => (await planRoom(page, "gate_2"))!.contents.filter((c) => c.kind === "enemy").length === before + 1,
  );
  const added = enemies().last();
  await oneEdit(
    async () => {
      await added.getByLabel("Enemy character").fill("eel");
      await added.getByLabel("Enemy character").press("Enter");
    },
    async () => (await planRoom(page, "gate_2"))!.contents.some((c) => c.kind === "enemy" && c.characterId === "eel"),
  );
  await expect(added.getByText("new", { exact: true })).toBeVisible();

  // A pickup (the only ability: Dash).
  await oneEdit(
    () => room.getByRole("button", { name: "+ Pickup" }).click(),
    async () => (await planRoom(page, "gate_2"))!.contents.some((c) => c.kind === "pickup" && c.grants === "dash"),
  );
  await expect(room.getByTestId("content-pickup")).toBeVisible();

  // Undo takes back the pickup only.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(async () => (await planRoom(page, "gate_2"))!.contents.some((c) => c.kind === "pickup")).toBe(false);
  const after = (await planRoom(page, "gate_2"))!;
  expect(after.contents.some((c) => c.kind === "enemy" && c.characterId === "eel")).toBe(true);
  expect(after).toMatchObject({ cols: 60, notes: "A long flooded hall.", terrain: { hazards: 0.8 } });
  await expect(room.getByTestId("content-pickup")).toHaveCount(0);

  // Undo again: the enemy is back to the region's kind.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect.poll(async () => (await planRoom(page, "gate_2"))!.contents.some((c) => c.kind === "enemy" && c.characterId === "eel")).toBe(false);
  await expect(enemies().last().getByLabel("Enemy character")).toHaveValue("crawler");
  expect(consoleErrors).toEqual([]);
});

test("a pinned room is read-only and a rebuild leaves its plan alone", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await withProgression(page);
  await openArchitect(page);
  await expand(page, "gate_3");
  const room = card(page, "gate_3");
  await room.getByLabel("Room notes").fill("Mine: hand-made.");
  await room.getByLabel("Room notes").blur();
  await expect.poll(async () => (await planRoom(page, "gate_3"))?.notes).toBe("Mine: hand-made.");

  await room.getByRole("button", { name: "Pin" }).click();
  await expect.poll(async () => (await planRoom(page, "gate_3"))?.pinned).toBe(true);
  await expect(room).toHaveClass(/pinned/);
  await expect(room.getByRole("button", { name: "Pinned", pressed: true })).toBeVisible();
  await expect(room.getByText("Pinned: this room is yours.")).toBeVisible();
  for (const label of ["Room name", "Width in tiles", "Hazards", "Room notes", "Seed"]) await expect(room.getByLabel(label)).toBeDisabled();
  for (const name of ["+ Enemy", "+ Save", "↻ Reroll", "Rebuild this room", "Delete room"]) await expect(room.getByRole("button", { name })).toBeDisabled();

  const pinned = await planRoom(page, "gate_3");
  // Rebuild the whole plan from the progression, then build the game: the pinned room stays as it is.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Start again from the progression" }).click();
  await page.getByTestId("architect-sidebar").getByRole("button", { name: "Build game" }).click();
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().architect.stages.plan?.status)).toBe("done");
  await runEnded(page);
  expect(await planRoom(page, "gate_3")).toEqual(pinned);
  await expect(room).toHaveClass(/pinned/);
  expect(consoleErrors).toEqual([]);
});

test("pause after plan: the run stops for review, an edit, then Continue carries on", async ({ page }) => {
  test.setTimeout(300_000); // the real stages build, populate and prove the world
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await withProgression(page);
  await openArchitect(page);
  const sidebar = page.getByTestId("architect-sidebar");
  const chip = (stage: string) => sidebar.getByTestId(`stage-chip-${stage}`);

  // A target this 9-room game meets: no pacing repair sends it back to the (paused-after) plan stage.
  const target = await page.evaluate(() => window.studio!.applyOperation("setArchitectGuidance", { targetMinutes: [1, 60] }));
  expect(target.ok ? "ok" : JSON.stringify(target.error)).toBe("ok");
  await sidebar.getByLabel("Pause after plan").click(); // controlled by the project: it ticks once the server has it
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().architect.pauseAfter)).toEqual(["plan"]);
  await expect(sidebar.getByLabel("Pause after plan")).toBeChecked();
  await expect(sidebar.getByTestId("architect-stage-plan")).toContainText("pauses here for review");

  await sidebar.getByRole("button", { name: "Build game" }).click();
  await expect(chip("plan")).toHaveText("paused", { timeout: 30_000 });
  await expect(sidebar.getByTestId("architect-run-hint")).toContainText("Paused after plan");
  await expect(chip("layout")).toHaveText("pending");
  await expect(sidebar.getByTestId("architect-stage-plan")).toContainText("planned 9 rooms");

  // Review: change the plan while paused.
  await page.getByLabel("Game guidance").fill("Short and tense.");
  await page.getByLabel("Game guidance").blur();
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().architect.guidance)).toBe("Short and tense.");

  await sidebar.getByRole("button", { name: "Continue" }).click();
  // The real stages carry on: the world is built, populated and proven.
  // (A game shorter than its play-time target goes back to the plan a few times first: wait for the end.)
  await expect(sidebar.getByTestId("architect-last")).toContainText("finished", { timeout: 240_000 });
  for (const stage of ["plan", "layout", "geometry", "cast", "population", "screens", "verify"]) await expect(chip(stage)).toHaveText("done");
  expect(await page.evaluate(() => window.studio!.getProject().world.rooms.filter((r) => r.regionId).length)).toBe(9);
  expect(consoleErrors).toEqual([]);
});

test("Stop ends a run after the stage it is on", async ({ page, baseURL }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  // The example game verifies clean, so a run that isn't stopped would go on to the end.
  expect((await page.evaluate(() => window.studio!.resetProject("example"))).ok).toBe(true);
  await openArchitect(page, false);
  const sidebar = page.getByTestId("architect-sidebar");

  // The stub stages take milliseconds, faster than a busy page reacts. So Stop is pressed while the
  // run starts (its request held), and the Stop's request is let through the moment the server
  // reports the run under way (watched here, on the server's own event stream).
  let pressStop!: () => void;
  const stopPressed = new Promise<void>((resolve) => (pressStop = resolve));
  await page.route("**/api/architect/run", async (route) => {
    await stopPressed;
    await route.continue();
  });
  const underway = watchForRun(`${baseURL}/api/events?clientId=e2e_architect_watch`);
  await page.route("**/api/architect/cancel", async (route) => {
    await underway;
    await route.continue();
  });

  await sidebar.getByRole("button", { name: "Build game" }).click();
  await expect(sidebar.getByTestId("architect-run-hint")).toHaveText("Starting…");
  await sidebar.getByRole("button", { name: "■ Stop" }).click();
  await expect(sidebar.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  pressStop();

  await expect(sidebar.getByTestId("architect-last")).toContainText("cancelled", { timeout: 30_000 });
  await expect(sidebar.getByTestId("architect-run-hint")).toContainText("Stopped before");
  await expect(sidebar.getByRole("button", { name: "Build game" })).toBeEnabled();
  expect(await stageStatus(page, "art")).toBe("pending");
  await expect(sidebar.getByTestId("stage-chip-art")).toHaveText("pending");
  expect(consoleErrors).toEqual([]);
});

test("a failed run lists its issues; an issue about a room opens its card", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await withProgression(page);
  await openArchitect(page);
  const sidebar = page.getByTestId("architect-sidebar");
  // Pin a room before it's ever built: it stays unbuilt, so its neighbours' doors have nothing to lead to.
  await expand(page, "city_2");
  await card(page, "city_2").getByRole("button", { name: "Pin" }).click();
  await expect.poll(async () => (await planRoom(page, "city_2"))?.pinned).toBe(true);

  await sidebar.getByRole("button", { name: "Build game" }).click();
  await expect(sidebar.getByTestId("stage-chip-geometry")).toHaveText("failed", { timeout: 240_000 });
  await expect(sidebar.getByTestId("architect-last")).toContainText("failed at Geometry");
  const issues = sidebar.getByTestId("architect-issues");
  await expect(issues).toBeVisible();
  const show = issues.getByRole("button", { name: "Show room" }).first();
  const roomId = (await show.getAttribute("data-room"))!;
  await show.click();
  await expect(card(page, roomId)).toHaveClass(/focused/);
  await expect(card(page, roomId).locator(".room-card-body")).toBeVisible();
  await expect(card(page, roomId)).toBeInViewport();
  await expect(sidebar.getByTestId("architect-log")).toContainText("run failed");
  expect(consoleErrors).toEqual([]);
});
