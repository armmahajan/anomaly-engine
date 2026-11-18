import { expect, test } from "@playwright/test";
import { collectConsoleErrors, loadExample, openStudio, projectRevision, resetProject, waitForRuntimeAfter } from "./helpers.ts";

test.afterEach(({ page }) => resetProject(page));

test("Check the game proves the example game beatable, then shows how a decoy lock breaks it", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await loadExample(page);
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().world.rooms.map((r) => r.id))).toContain("summit");
  await page.getByRole("tab", { name: "Game" }).click();

  const section = page.getByTestId("check-section");
  const verdict = page.getByTestId("check-verdict");
  await section.getByRole("button", { name: "Check the game" }).click();
  await expect(verdict).toHaveText("✓ Beatable, no dead ends");
  await expect(section).toContainText("Reaches bridge, cistern, entrance, hall, sanctum, spikes, summit");
  await section.getByText(/A route to the ending/).click();
  await expect(section.getByRole("listitem").last()).toHaveText("summit touch Altar: the game ends");

  // A lock in the hall that swallows the key: the hatch can never open.
  const base = await projectRevision(page);
  await page.evaluate(() =>
    window.studio!.applyOperation("addProp", {
      roomId: "hall",
      name: "Rusty lock",
      x: 640,
      y: 320,
      width: 32,
      height: 64,
      handlers: [{ on: { type: "interact" }, when: [{ type: "item", item: "key" }], do: [{ type: "takeItem", item: "key" }] }],
    }),
  );
  await waitForRuntimeAfter(page, base);
  await expect(section).toContainText("The game changed since this check.");
  await section.getByRole("button", { name: "Check the game" }).click();
  await expect(verdict).toHaveText("✗ Beatable, 1 dead end");
  const dead = page.getByTestId("check-dead");
  await expect(dead).toContainText("Lock post (hall) needs item key; no key is left anywhere reachable from here");
  await expect(dead.getByRole("listitem").last()).toHaveText("hall use Rusty lock");
  expect(consoleErrors).toEqual([]);
});
