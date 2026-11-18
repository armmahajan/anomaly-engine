import { expect, test } from "@playwright/test";
import { collectConsoleErrors, confirmInPage, openStudio, projectRevision, resetProject, runtimeState } from "./helpers.ts";

test.afterEach(({ page }) => resetProject(page));

const project = (page: import("@playwright/test").Page) => page.evaluate(() => window.studio!.getProject());

test("the creator makes a weapon with an arc attack, puts it in the main slot and plays with it", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Game" }).click();
  const weapons = page.getByTestId("weapons-panel");
  const loadout = page.getByTestId("loadout-panel");
  await expect(weapons).toContainText("No weapons yet");
  await expect(loadout.getByLabel("main weapon")).toHaveValue("");

  // A weapon, then an attack (an arc by default), then its reach and damage: one edit each.
  await weapons.getByLabel("new weapon name").fill("Bone Sickle");
  await weapons.getByRole("button", { name: "+ Weapon" }).click();
  const editor = weapons.getByTestId("weapon-bone_sickle");
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "+ Attack" }).click();
  const attack = editor.getByTestId("attack-attack");
  await expect(attack.getByLabel("attack shape")).toHaveValue("arc");
  const before = await projectRevision(page);
  await attack.getByLabel("attack Radius").fill("90");
  await attack.getByLabel("attack Radius").press("Enter");
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
  await attack.getByLabel("attack Damage").fill("3");
  await attack.getByLabel("attack Damage").press("Enter");
  await expect(attack).toContainText("arc 90px · 3 dmg");
  await editor.getByLabel("weapon brief").fill("a chipped bone sickle");
  await editor.getByLabel("weapon brief").blur();
  await expect.poll(async () => (await project(page)).weapons.list[0]).toMatchObject({
    id: "bone_sickle",
    name: "Bone Sickle",
    attacks: [{ id: "attack", shape: { type: "arc", radius: 90 }, damage: 3 }],
    art: { brief: "a chipped bone sickle" },
  });

  // Into the main slot; a second slot on alt attack makes Controls show that key.
  await loadout.getByLabel("main weapon").selectOption("bone_sickle");
  await expect.poll(async () => (await project(page)).weapons.loadout.slots[0]!.start).toBe("bone_sickle");
  await expect(page.getByTestId("control-alt_attack")).toHaveCount(0);
  await loadout.getByRole("button", { name: "+ Slot" }).click();
  await expect(loadout.getByTestId("slot-alt")).toBeVisible();
  await expect(page.getByTestId("control-alt_attack")).toBeVisible();
  await loadout.getByRole("button", { name: "remove slot Alt" }).click();
  await expect(page.getByTestId("control-alt_attack")).toHaveCount(0);

  // The loadout is project data: the playtest has it, with the weapon equipped in the main slot.
  const revision = await projectRevision(page);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(revision);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).weapons?.slots.main ?? null).toBe("bone_sickle");
  expect((await runtimeState(page)).weapons?.owned).toContain("bone_sickle");
  await page.keyboard.press("x");
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");

  // Delete asks in the page; the slot then starts empty again.
  await page.getByRole("tab", { name: "Game" }).click();
  await editor.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmInPage(page, "Delete");
  await expect.poll(async () => (await project(page)).weapons).toMatchObject({ list: [], loadout: { slots: [{ id: "main", start: null }] } });
  expect(consoleErrors).toEqual([]);
});
