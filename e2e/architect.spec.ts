import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, resetProject } from "./helpers.ts";

// Phase 0 wiring: the Architect tab runs the stages on the server and the studio follows them.
// (The Architect view's own e2e tests live in e2e/architect-view.spec.ts.)

test.afterEach(async ({ page }) => resetProject(page));

test("the Architect tab runs its stages on the server; the project records each stage", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Architect" }).click();
  await expect(page.getByTestId("architect-main")).toBeVisible();
  await page.getByTestId("architect-sidebar").getByRole("button", { name: "Build game" }).click();
  // The starter project has no ending, so verify stops the run before art.
  await expect
    .poll(async () => page.evaluate(() => window.studio!.getProject().architect.stages.verify?.status), { timeout: 30_000 })
    .toBe("failed");
  const stages = await page.evaluate(() => window.studio!.getProject().architect.stages);
  expect(Object.keys(stages)).toEqual(["plan", "layout", "geometry", "population", "cast", "screens", "verify"]);
  expect(stages.verify!.summary).toContain("no-ending");
  expect(consoleErrors).toEqual([]);
});
