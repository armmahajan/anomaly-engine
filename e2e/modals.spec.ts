import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject, runtimeState } from "./helpers.ts";

test.afterEach(async ({ page }) => resetProject(page));

const project = (page: Page) => page.evaluate(() => window.studio!.getProject());

/** Type into a field and commit it (Enter), waiting for the one edit it makes. */
async function commit(page: Page, field: ReturnType<Page["getByLabel"]>, value: string) {
  const before = await projectRevision(page);
  await field.fill(value);
  await field.press("Enter");
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
}

test("a modal authored in the Game tab opens on entering a room, and its button sets a flag", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Game" }).click();
  const panel = page.getByTestId("modals-panel");

  // Create, title it, give it a button that sets a flag: one undoable edit each.
  await panel.getByRole("button", { name: "+ Modal" }).click();
  await expect.poll(async () => (await project(page)).world.modals.map((m) => m.id)).toEqual(["new_modal"]);
  await commit(page, panel.getByLabel("Title"), "Welcome");
  await panel.getByRole("button", { name: "+ Button" }).click();
  await expect.poll(async () => (await project(page)).world.modals[0]!.buttons).toEqual([{ label: "Continue", do: [] }]);
  await commit(page, panel.getByLabel("button 0 label"), "Open");
  await panel.getByRole("button", { name: "add button 0 effect" }).click();
  await commit(page, panel.getByLabel("button 0 effect 0 flag"), "opened");
  expect((await project(page)).world.modals[0]).toEqual({
    id: "new_modal",
    title: "Welcome",
    body: "",
    image: null,
    buttons: [{ label: "Open", do: [{ type: "setFlag", flag: "opened", value: true }] }],
  });

  // Live preview in the runtime (edit mode); hiding it closes it.
  await panel.getByRole("button", { name: "Preview" }).click();
  await expect.poll(async () => (await runtimeState(page)).modal).toBe("new_modal");
  await panel.getByRole("button", { name: "Hide preview" }).click();
  await expect.poll(async () => (await runtimeState(page)).modal).toBe(null);

  // The map is a switch.
  await page.getByLabel(/^Map screen/).click();
  await expect.poll(async () => (await project(page)).world.map.enabled).toBe(true);

  // Bind it to entering the room with a room handler.
  await page.getByRole("tab", { name: "Rooms" }).click();
  const handlers = page.getByTestId("handlers-room arena");
  await handlers.getByRole("button", { name: "+ Handler" }).click();
  await expect.poll(async () => (await project(page)).world.rooms[0]!.handlers).toHaveLength(1);
  await handlers.getByLabel("room arena 0 event", { exact: true }).selectOption("roomEntered");
  await expect.poll(async () => (await project(page)).world.rooms[0]!.handlers[0]!.on).toEqual({ type: "roomEntered" });
  await handlers.getByLabel("room arena 0 effect 0", { exact: true }).selectOption("showModal");
  await expect.poll(async () => (await project(page)).world.rooms[0]!.handlers[0]).toEqual({ on: { type: "roomEntered" }, when: [], do: [{ type: "showModal", modal: "new_modal" }] });

  await page.getByRole("button", { name: "▶ Play", exact: true }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await expect.poll(async () => (await runtimeState(page)).modal).toBe("new_modal");
  expect((await runtimeState(page)).flags).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await runtimeState(page)).flags).toEqual(["opened"]);
  expect((await runtimeState(page)).modal).toBe(null);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");

  // Delete: refused while the room handler shows it, saying where.
  await page.getByRole("tab", { name: "Game" }).click();
  await panel.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/modal "new_modal" is shown by a handler of the room "[^"]+"/)).toBeVisible();
  expect((await project(page)).world.modals).toHaveLength(1);
  // An unused one goes.
  await panel.getByRole("button", { name: "+ Modal" }).click();
  await expect(panel.getByTestId("modal-new_modal_2")).toBeVisible();
  await panel.getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await project(page)).world.modals.map((m) => m.id)).toEqual(["new_modal"]);
  expect(consoleErrors).toEqual([]);
});
