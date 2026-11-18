import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, patrolSpeedField, resetProject, runtimeState } from "./helpers.ts";

test.afterEach(({ page }) => resetProject(page));

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

test("a reply's changes fold into one line, without token counts", async ({ page }) => {
  await openStudio(page);
  await page.getByLabel("Message").fill("crawler speed 210");
  await page.getByLabel("Message").press("Enter");

  const reply = page.getByTestId("chat-reply").last();
  await expect(reply).toContainText("patrol speed to 210");
  const summary = reply.getByText("1 change", { exact: true });
  const change = reply.getByText("tuned crawler › patrol");
  await expect(summary).toBeVisible();
  await expect(change).toBeHidden();
  await summary.click();
  await expect(change).toBeVisible();
  await expect(reply).not.toContainText("tokens");
});

test("edit the latest message: its changes are undone first and the exchange is replaced; Retry; Reuse an earlier one", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const r0 = await openStudio(page);
  const message = page.getByLabel("Message");
  const messages = page.getByTestId("chat-message");
  const replies = page.getByTestId("chat-reply");

  await message.fill("crawler speed 222");
  await message.press("Enter");
  await expect(replies.last()).toContainText("patrol speed to 222");
  await expect(patrolSpeedField(page)).toHaveValue("222");

  // Edit says what it will do before doing it.
  await messages.last().getByRole("button", { name: "Edit" }).click();
  const editor = page.getByLabel("Edit message");
  await expect(editor).toBeFocused();
  await expect(messages.last()).toContainText("Undoes this turn's 1 change first, then replaces the message and its reply.");
  // Escape cancels; nothing changed.
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await messages.last().getByRole("button", { name: "Edit" }).click();
  await editor.fill("crawler speed 180");
  await editor.press("Enter");

  await expect(replies.last()).toContainText("patrol speed to 180");
  await expect(messages).toHaveCount(1);
  await expect(replies).toHaveCount(1);
  await expect(messages.last()).toContainText("crawler speed 180");
  await expect(patrolSpeedField(page)).toHaveValue("180");
  // One undo (the old turn) and one new turn.
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 3);

  // Retry the latest turn: it asks first because the turn saved changes.
  await replies.last().getByRole("button", { name: "Retry" }).click();
  const confirm = page.getByRole("group", { name: "Retry" });
  await expect(confirm).toContainText("Undoes this turn's 1 change first");
  await confirm.getByRole("button", { name: "Retry" }).click();
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 5);
  await expect(messages).toHaveCount(1);
  await expect(replies).toHaveCount(1);
  await expect(patrolSpeedField(page)).toHaveValue("180");

  // Once the project changed after a turn, an edit keeps its changes and sends a new message.
  await message.fill("crawler speed 190");
  await message.press("Enter");
  await expect(replies.last()).toContainText("patrol speed to 190");
  await patrolSpeedField(page).fill("195");
  await patrolSpeedField(page).press("Enter");
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(r0 + 7);
  await messages.last().getByRole("button", { name: "Edit" }).click();
  await expect(messages.last()).toContainText("can't be undone automatically");
  await expect(replies.last().getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.getByLabel("Edit message").press("Escape");

  // An earlier message can be copied into the message box to send again.
  await messages.first().getByRole("button", { name: "Reuse" }).click();
  await expect(message).toHaveValue("crawler speed 180");
  await expect(message).toBeFocused();
  expect(consoleErrors).toEqual([]);
});

test("the composer grows with its text, Shift+Enter adds a line, and a draft survives switching assistants", async ({ page }) => {
  await openStudio(page);
  const message = page.getByLabel("Message");
  await expect(page.getByTestId("chat-build")).toContainText("Enter to send");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  const oneLine = (await message.boundingBox())!.height;
  await message.fill("first line");
  await message.press("Shift+Enter");
  await message.pressSequentially("second line");
  await message.press("Shift+Enter");
  await message.pressSequentially("third line");
  await expect(message).toHaveValue("first line\nsecond line\nthird line");
  expect((await message.boundingBox())!.height).toBeGreaterThan(oneLine + 20);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  // Each tab has its own assistant: the header says who, and links to the others.
  const chat = page.getByTestId("chat-build");
  await expect(chat.getByRole("heading")).toHaveText("Build assistant");
  await expect(chat).toContainText("Builds and tunes the game");
  await chat.getByRole("button", { name: "Director" }).click();
  await expect(page.getByRole("tab", { name: "Wiki" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("chat-narrative").getByRole("heading")).toHaveText("Director");
  await expect(page.getByLabel("Message")).toHaveValue("");
  await page.getByTestId("chat-narrative").getByRole("button", { name: "Build assistant" }).click();
  await expect(page.getByLabel("Message")).toHaveValue("first line\nsecond line\nthird line");
});

test("the chat is wider by default, resizes from its left edge and remembers it", async ({ page }) => {
  await openStudio(page);
  const chat = page.getByTestId("chat-build");
  const before = (await chat.boundingBox())!;
  expect(before.width).toBeGreaterThanOrEqual(400);

  const handle = page.getByRole("separator", { name: "Resize the chat" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + 200, { steps: 5 });
  await page.mouse.up();
  const wider = (await chat.boundingBox())!.width;
  expect(wider).toBeGreaterThan(before.width + 80);

  // Collapsing keeps the width for later; a reload restores it.
  await page.getByRole("button", { name: "Collapse chat" }).click();
  expect((await chat.boundingBox())!.width).toBeLessThan(60);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByLabel("Message")).toBeFocused();
  expect(Math.abs((await chat.boundingBox())!.width - wider)).toBeLessThan(2);
  await page.reload();
  await expect(page.getByLabel("Message")).toBeVisible();
  expect(Math.abs((await page.getByTestId("chat-build").boundingBox())!.width - wider)).toBeLessThan(2);
  await page.evaluate(() => localStorage.removeItem("anomaly.chatWidth"));
});
