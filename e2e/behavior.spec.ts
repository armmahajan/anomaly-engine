import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, commitField, entity, openStudio, runtimeState } from "./helpers.ts";

// Third target: behaviors are data. The Charger is built only from
// primitives (patrol -> telegraph -> charge -> wait); editing its windup in
// the inspector changes how long the warning lasts in the real runtime.

const stateOf = async (page: Page, id: string) => (await entity(page, id)).behaviorState;

/**
 * Walk the player toward the Charger until it starts its windup, then
 * stand still and time how long the windup lasts (wall clock, polled).
 */
async function provokeAndTimeWindup(page: Page): Promise<number> {
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  expect(await stateOf(page, "charger")).toBe("patrol");

  await page.keyboard.down("ArrowRight");
  await expect.poll(() => stateOf(page, "charger"), { intervals: [25], timeout: 5000 }).toBe("windup");
  await page.keyboard.up("ArrowRight");
  const windupStart = Date.now();

  // Telegraph: stands still while warning.
  expect(Math.abs((await entity(page, "charger")).velocityX)).toBe(0);

  await expect.poll(() => stateOf(page, "charger"), { intervals: [25], timeout: 5000 }).toBe("charge");
  return (Date.now() - windupStart) / 1000;
}

test("the Charger telegraphs, charges, knocks the player back, and its windup is editable", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  // Start from the default windup regardless of what earlier runs left in the project.
  const reset = await page.evaluate(() =>
    window.studio!.applyOperation("updateBehavior", {
      characterId: "charger",
      stateId: "windup",
      transitions: [{ index: 0, when: { seconds: 0.6 } }],
    }),
  );
  expect(reset.ok).toBe(true);

  // The inspector shows the Charger's states with editable values.
  await page.getByTestId("character-charger").click();
  for (const state of ["patrol", "windup", "charge", "recover"]) {
    await expect(page.getByTestId(`state-${state}`)).toBeVisible();
  }
  await expect(page.getByLabel("windup to charge seconds")).toHaveValue("0.6");
  await page.screenshot({ path: "test-results/4-charger-inspector.png" });

  // Default windup is 0.6s.
  const shortWindup = await provokeAndTimeWindup(page);
  expect(shortWindup).toBeGreaterThan(0.4);
  expect(shortWindup).toBeLessThan(1.1);

  // Charging: fast, toward the player, then recovers.
  await expect.poll(async () => Math.abs((await entity(page, "charger")).velocityX)).toBe(520);
  await page.screenshot({ path: "test-results/5-charging.png" });

  // The charge connects with the stationary player: knocked back and hurt.
  await expect.poll(() => stateOf(page, "player"), { intervals: [25], timeout: 3000 }).toBe("hurt");
  await expect.poll(() => stateOf(page, "charger"), { timeout: 3000 }).toBe("recover");
  await expect.poll(() => stateOf(page, "charger"), { timeout: 3000 }).not.toBe("recover");

  // Stop (reset), make the warning much longer, play again.
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  const windup = page.getByLabel("windup to charge seconds");
  await commitField(page, windup, "1.6");
  const revision = await page.evaluate(() => window.studio!.getProject().revision);

  const longWindup = await provokeAndTimeWindup(page);
  expect(longWindup).toBeGreaterThan(1.3);
  expect(longWindup - shortWindup).toBeGreaterThan(0.7);

  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");

  // Invalid behavior edits are rejected in the UI and via the API.
  await windup.fill("-1");
  await windup.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  const dangling = await page.evaluate(() =>
    window.studio!.applyOperation("updateBehavior", {
      characterId: "charger",
      stateId: "windup",
      transitions: [{ index: 0, to: "nowhere" }],
    }),
  );
  expect(dangling).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(await page.evaluate(() => window.studio!.getProject().revision)).toBe(revision);

  expect(consoleErrors).toEqual([]);
});
