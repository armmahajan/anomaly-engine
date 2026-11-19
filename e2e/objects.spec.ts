import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, confirmInPage, openStudio, projectRevision, resetProject } from "./helpers.ts";
import { loadAnimatedFixture } from "./animatedFixture.ts";

// The animation target in the studio (README "Animation in play"): objects in the Characters tab,
// clip markers, props drawn with objects, playAnimation / spawnEffect / marker handlers and projectile
// looks. Only the studio and the project are checked here: drawing objects and playing them are the
// art pipeline's and the runtime's (their own tests).

test.afterEach(({ page }) => resetProject(page));

const project = (page: Page) => page.evaluate(() => window.studio!.getProject());
const asset = async (page: Page, id: string) => (await project(page)).art.assets.find((a) => a.id === id) as { kind: string; subject?: string; name: string; brief: string; clips: Record<string, { markers: { t: number; name: string }[] }> } | undefined;
const markers = async (page: Page, object: string, clip: string) => (await asset(page, object))!.clips[clip]!.markers;
const arenaProp = async (page: Page, id: string) => (await project(page)).world.rooms.find((r) => r.id === "arena")!.props.find((p) => p.id === id)!;
const undo = (page: Page) => page.getByRole("button", { name: "↶ Undo" }).click();

/** Wait for one more saved revision after `action`. */
async function oneEdit(page: Page, action: () => Promise<unknown>) {
  const before = await projectRevision(page);
  await action();
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
}

test("Objects: + Object makes one, its art jobs name it by objectId, it lists its uses and can't be deleted while used", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Characters" }).click();
  const objects = page.getByTestId("object-list");

  await objects.getByRole("button", { name: "+ Object" }).click();
  await objects.getByLabel("object name").fill("Floor Lever");
  await objects.getByLabel("object brief").fill("a rusted floor lever with a red knob");
  await oneEdit(page, () => objects.getByRole("button", { name: "Create" }).click());
  expect(await asset(page, "floor_lever")).toMatchObject({ kind: "character", subject: "object", name: "Floor Lever", brief: "a rusted floor lever with a red knob" });
  await expect(objects.getByTestId("object-floor_lever")).toHaveAttribute("aria-current", "true");
  const panel = page.getByTestId("art-panel");
  await expect(panel.getByRole("heading", { name: /Floor Lever/ })).toBeVisible();
  await expect(page.getByTestId("character-bench")).toContainText("Floor Lever's art, in three steps");
  await expect(panel.getByLabel("What should Floor Lever look like?")).toHaveValue("a rusted floor lever with a red knob");

  // Its art jobs are about the object (objectId, never characterId). The pipeline is not under test: the request is answered here.
  const requests: unknown[] = [];
  await page.route("**/api/art/jobs", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, jobId: "e2e-job" } });
  });
  await panel.getByRole("button", { name: "Generate concepts" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ stage: "concepts", objectId: "floor_lever" });
  expect(requests[0]).not.toHaveProperty("characterId");
  await panel.getByLabel("Auto").check();
  await panel.getByRole("button", { name: "Generate everything" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ stage: "auto", objectId: "floor_lever" });
  expect(requests[1]).not.toHaveProperty("characterId");

  // Used by a prop: its uses are listed and Delete is refused, saying why.
  const uses = page.getByTestId("object-uses");
  await expect(uses).toContainText("nothing yet");
  const used = await page.evaluate(() => window.studio!.applyOperation("addProp", { roomId: "arena", id: "lever", x: 400, y: 600, width: 32, height: 48, art: { object: "floor_lever", idle: "idle" } }));
  expect(used.ok).toBe(true);
  await expect(uses.getByTestId("object-use")).toHaveText(/the prop "lever" in "Arena"/);
  await uses.getByRole("button", { name: "Delete object" }).click();
  await expect(uses.getByTestId("object-delete-refused")).toContainText('object "floor_lever" is still used by the prop "lever"');
  expect(await asset(page, "floor_lever")).toBeDefined();

  // Unused again (Undo), it deletes after a question in the page, and the workbench goes back to a character.
  await undo(page);
  await expect(uses).toContainText("nothing yet");
  await uses.getByRole("button", { name: "Delete object" }).click();
  await confirmInPage(page, "Delete");
  await expect(objects.getByTestId("object-floor_lever")).toHaveCount(0);
  expect(await asset(page, "floor_lever")).toBeUndefined();
  await expect(page.getByTestId("art-panel").getByRole("heading", { level: 2 })).not.toContainText("Floor Lever");
  expect(consoleErrors).toEqual([]);
});

test("the marker timeline: add, drag, rename and delete a clip's markers, one edit each, and Undo takes each back", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await loadAnimatedFixture(page);
  await page.getByRole("tab", { name: "Characters" }).click();
  await page.getByTestId("object-lever").click();
  const list = page.getByTestId("animation-list");
  await list.getByTestId("clip-pull").getByRole("button").click();
  const timeline = list.getByTestId("marker-timeline");
  await expect(timeline.getByTestId("marker-0")).toHaveAccessibleName("marker click at 0.7");
  const original = [{ t: 0.7, name: "click" }];
  const bar = (await timeline.getByTestId("marker-bar").boundingBox())!;
  const at = (t: number) => ({ x: bar.x + bar.width * t, y: bar.y + bar.height / 2 });

  // Add: a click on the bar puts a marker there.
  await oneEdit(page, () => page.mouse.click(at(0.25).x, at(0.25).y));
  const added = await markers(page, "lever", "pull");
  expect(added).toHaveLength(2);
  expect(added[0]!.name).toBe("marker");
  expect(added[0]!.t).toBeCloseTo(0.25, 1);
  expect(added[1]).toEqual(original[0]);

  // Move: drag it to the middle.
  const handle = (await timeline.getByTestId("marker-0").boundingBox())!;
  await oneEdit(page, async () => {
    await page.mouse.move(handle.x + 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(at(0.4).x, at(0.4).y, { steps: 3 });
    await page.mouse.move(at(0.5).x, at(0.5).y, { steps: 3 });
    await page.mouse.up();
  });
  const moved = await markers(page, "lever", "pull");
  expect(moved[0]!.name).toBe("marker");
  expect(moved[0]!.t).toBeCloseTo(0.5, 1);

  // Rename the selected one; then move it exactly with its time field.
  const edit = timeline.getByTestId("marker-edit");
  await expect(edit.getByLabel("marker name")).toHaveValue("marker");
  await oneEdit(page, async () => {
    await edit.getByLabel("marker name").fill("Spark");
    await edit.getByLabel("marker name").press("Enter");
  });
  expect((await markers(page, "lever", "pull"))[0]!.name).toBe("spark");
  await oneEdit(page, async () => {
    await edit.getByLabel("marker time").fill("0.55");
    await edit.getByLabel("marker time").press("Enter");
  });
  const retimed = await markers(page, "lever", "pull");
  expect(retimed).toEqual([{ t: 0.55, name: "spark" }, original[0]]);
  await expect(list.getByTestId("clip-pull")).toContainText("spark, click");

  // Delete it.
  await oneEdit(page, () => edit.getByRole("button", { name: "Delete marker" }).click());
  expect(await markers(page, "lever", "pull")).toEqual(original);

  // Undo takes back each step in turn: the delete, the retime, the rename, the move, the add.
  await undo(page);
  await expect.poll(() => markers(page, "lever", "pull")).toEqual(retimed);
  await undo(page);
  await expect.poll(async () => (await markers(page, "lever", "pull"))[0]).toEqual({ t: moved[0]!.t, name: "spark" });
  await undo(page);
  await expect.poll(() => markers(page, "lever", "pull")).toEqual(moved);
  await undo(page);
  await expect.poll(() => markers(page, "lever", "pull")).toEqual(added);
  await undo(page);
  await expect.poll(() => markers(page, "lever", "pull")).toEqual(original);
  await expect(timeline.getByTestId("marker-1")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("a prop drawn with an object; handlers play its clips and spawn effects with pickers; spawn and prop handlers hear markers", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await loadAnimatedFixture(page);
  await page.getByRole("tab", { name: "Rooms" }).click();

  // The door: from its colour to the trap object, looping idle; then another idle clip and a size.
  await page.getByTestId("prop-door").click();
  const editor = page.getByTestId("prop-editor");
  await expect(editor.getByLabel("prop art")).toHaveValue("");
  await oneEdit(page, () => editor.getByLabel("prop art").selectOption("object:trap"));
  expect((await arenaProp(page, "door")).art).toEqual({ object: "trap", idle: "idle", scale: 1 });
  await expect(editor.getByLabel("prop object idle")).toHaveValue("idle");
  await expect(editor.getByLabel("prop object idle").locator("option")).toHaveText(["(rest pose)", "idle", "snap"]);
  await oneEdit(page, () => editor.getByLabel("prop object idle").selectOption("snap"));
  await oneEdit(page, async () => {
    await editor.getByLabel("prop object scale").fill("1.5");
    await editor.getByLabel("prop object scale").press("Enter");
  });
  expect((await arenaProp(page, "door")).art).toEqual({ object: "trap", idle: "snap", scale: 1.5 });
  await oneEdit(page, () => editor.getByLabel("prop object idle").selectOption("idle"));

  // A handler that plays a clip on itself (its own clips offered), then on the lever prop (the lever's clips).
  const handlers = editor.getByTestId("handlers-prop door");
  await oneEdit(page, () => handlers.getByRole("button", { name: "+ Handler" }).click());
  await oneEdit(page, () => handlers.getByLabel("prop door 0 event", { exact: true }).selectOption("touch"));
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 0", { exact: true }).selectOption("playAnimation"));
  await expect(handlers.getByLabel("prop door 0 effect 0 target", { exact: true })).toHaveValue("self");
  await expect(handlers.getByLabel("prop door 0 effect 0 clip").locator("option")).toHaveText(["idle", "snap"]);
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 0 clip").selectOption("snap"));
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 0 then").selectOption("hold"));
  expect((await arenaProp(page, "door")).handlers[0]).toEqual({ on: { type: "touch" }, when: [], do: [{ type: "playAnimation", target: { kind: "self" }, clip: "snap", then: "hold" }] });
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 0 target", { exact: true }).selectOption("prop"));
  await expect(handlers.getByLabel("prop door 0 effect 0 target prop").locator("option")).toContainText(["trap", "lever", "door"]);
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 0 target prop").selectOption("lever"));
  await expect(handlers.getByLabel("prop door 0 effect 0 clip").locator("option")).toContainText(["idle", "pull"]);
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 0 clip").selectOption("pull"));
  expect((await arenaProp(page, "door")).handlers[0]!.do[0]).toEqual({ type: "playAnimation", target: { kind: "prop", prop: "lever" }, clip: "pull", then: "hold" });

  // A spawnEffect: an object, its clip, at a spawn of the room, nudged up.
  await oneEdit(page, () => handlers.getByRole("button", { name: "add prop door 0 effect" }).click());
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 1", { exact: true }).selectOption("spawnEffect"));
  await expect(handlers.getByLabel("prop door 0 effect 1 object").locator("option")).toHaveText(["lever", "trap", "shockwave", "bolt"]);
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 1 object").selectOption("shockwave"));
  await expect(handlers.getByLabel("prop door 0 effect 1 clip").locator("option")).toHaveText(["idle", "burst"]);
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 1 clip").selectOption("burst"));
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 1 at", { exact: true }).selectOption("spawn"));
  await expect(handlers.getByLabel("prop door 0 effect 1 at spawn").locator("option")).toContainText(["crawler_1", "charger_1"]);
  await oneEdit(page, () => handlers.getByLabel("prop door 0 effect 1 at spawn").selectOption("charger_1"));
  await oneEdit(page, async () => {
    await handlers.getByLabel("prop door 0 effect 1 offset y").fill("-20");
    await handlers.getByLabel("prop door 0 effect 1 offset y").press("Enter");
  });
  expect((await arenaProp(page, "door")).handlers[0]!.do[1]).toEqual({ type: "spawnEffect", object: "shockwave", clip: "burst", at: { kind: "spawn", spawn: "charger_1" }, offset: [0, -20], scale: 1, layer: "front" });

  // Markers: the trap's handler hears its own `strike` (no `from` on a prop); the charger's spawn hears its art's `impact`.
  await page.getByTestId("prop-trap").click();
  const trap = page.getByTestId("handlers-prop trap");
  await expect(trap.getByLabel("prop trap 1 event", { exact: true })).toHaveValue("marker");
  await expect(trap.getByLabel("prop trap 1 event name")).toHaveValue("strike");
  await expect(trap.getByLabel("prop trap 1 event from")).toHaveCount(0);
  const spawn = page.getByTestId("handlers-charger_1");
  await expect(spawn.getByLabel("charger_1 0 event", { exact: true }).locator("option")).toHaveText(["enemyKilled", "marker", "stateEntered"]);
  await expect(spawn.getByLabel("charger_1 0 event", { exact: true })).toHaveValue("marker");
  await expect(spawn.getByLabel("charger_1 0 event name")).toHaveValue("impact");
  await expect(spawn.getByLabel("charger_1 0 effect 0 at", { exact: true })).toHaveValue("self");
  // A crawler spawn's handler can now listen for a marker too.
  const crawler = page.getByTestId("handlers-crawler_1");
  await page.getByTestId("spawn-details-crawler_1").locator("summary").click();
  await oneEdit(page, () => crawler.getByRole("button", { name: "+ Handler" }).click());
  await oneEdit(page, () => crawler.getByLabel("crawler_1 0 event", { exact: true }).selectOption("marker"));
  const room = (await project(page)).world.rooms.find((r) => r.id === "arena")!;
  expect(room.spawns.find((s) => s.id === "crawler_1")!.handlers[0]!.on).toEqual({ type: "marker" });
  expect(consoleErrors).toEqual([]);
});

test("projectile looks: origin, appear and object art on a weapon's projectile attack and on an enemy's shoot action", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await loadAnimatedFixture(page);

  // A weapon with a projectile attack (Game tab).
  await page.getByRole("tab", { name: "Game" }).click();
  const weapons = page.getByTestId("weapons-panel");
  await weapons.getByLabel("new weapon name").fill("Wand");
  await weapons.getByRole("button", { name: "+ Weapon" }).click();
  const editor = weapons.getByTestId("weapon-wand");
  await editor.getByRole("button", { name: "+ Attack" }).click();
  const attack = editor.getByTestId("attack-attack");
  await oneEdit(page, () => attack.getByLabel("attack shape").selectOption("projectile"));
  const look = async () => {
    const shape = (await project(page)).weapons.list.find((w) => w.id === "wand")!.attacks[0]!.shape;
    return shape.type === "projectile" ? shape.projectile.look : null;
  };
  expect(await look()).toEqual({ origin: [0, 0], appear: "fire", art: null });
  await oneEdit(page, async () => {
    await attack.getByLabel("attack look origin x").fill("24");
    await attack.getByLabel("attack look origin x").press("Enter");
  });
  await oneEdit(page, async () => {
    await attack.getByLabel("attack look origin y").fill("-10");
    await attack.getByLabel("attack look origin y").press("Enter");
  });
  await oneEdit(page, () => attack.getByLabel("attack look appear").selectOption("windup"));
  await oneEdit(page, () => attack.getByLabel("attack look object").selectOption("bolt"));
  expect(await look()).toEqual({ origin: [24, -10], appear: "windup", art: { object: "bolt", charge: "charge", fly: "fly", burst: "burst" } });
  await expect(attack.getByLabel("attack look fly").locator("option")).toHaveText(["(idle)", "idle", "charge", "fly", "burst"]);
  await oneEdit(page, () => attack.getByLabel("attack look burst").selectOption(""));
  await oneEdit(page, () => attack.getByLabel("attack look fly").selectOption("idle"));
  expect(await look()).toEqual({ origin: [24, -10], appear: "windup", art: { object: "bolt", charge: "charge", fly: "idle", burst: null } });

  // The crawler's shoot state (Playtest inspector): its look as the fixture set it, then edited.
  await page.getByRole("tab", { name: "Playtest" }).click();
  await page.getByTestId("character-crawler").click();
  const fire = page.getByTestId("look-fire");
  await expect(fire.getByLabel("fire look origin y")).toHaveValue("-60");
  await expect(fire.getByLabel("fire look appear")).toHaveValue("windup");
  await expect(fire.getByLabel("fire look object")).toHaveValue("bolt");
  const shootLook = async () => {
    const crawler = (await project(page)).characters.find((c) => c.id === "crawler")!;
    return crawler.kind === "enemy" && crawler.behavior.states.fire!.action.type === "shoot" ? crawler.behavior.states.fire!.action.look : null;
  };
  await oneEdit(page, async () => {
    await fire.getByLabel("fire look origin y").fill("-80");
    await fire.getByLabel("fire look origin y").press("Enter");
  });
  await oneEdit(page, () => fire.getByLabel("fire look appear").selectOption("fire"));
  await oneEdit(page, () => fire.getByLabel("fire look charge").selectOption(""));
  expect(await shootLook()).toEqual({ origin: [0, -80], appear: "fire", art: { object: "bolt", charge: null, fly: "fly", burst: "burst" } });
  await oneEdit(page, () => fire.getByLabel("fire look object").selectOption(""));
  expect(await shootLook()).toEqual({ origin: [0, -80], appear: "fire", art: null });
  await expect(fire.getByLabel("fire look fly")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});
