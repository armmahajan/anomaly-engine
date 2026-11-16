import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, patrolSpeedField, runtimeState } from "./helpers.ts";

test("chat stops the playtest, edits the game, and undoes from the reply", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const r0 = await openStudio(page);
  const status = page.getByTestId("runtime-status");
  const before = await patrolSpeedField(page).inputValue();

  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(status).toHaveText("Playing");

  await page.getByLabel("Message").fill("crawler speed 222");
  await page.getByLabel("Message").press("Enter");

  const reply = page.getByTestId("chat-reply").last();
  await expect(reply).toContainText("patrol speed to 222");
  await expect(reply).toContainText("tuned crawler › patrol");
  await expect(status).toHaveText("Editing");
  await expect(patrolSpeedField(page)).toHaveValue("222");
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 1);

  await reply.getByRole("button", { name: "Undo this" }).click();
  await expect(patrolSpeedField(page)).toHaveValue(before);
  await expect(reply.getByRole("button", { name: "Undo this" })).toHaveCount(0);
  await expect(reply).toContainText("Undone");
  expect(consoleErrors).toEqual([]);
});
