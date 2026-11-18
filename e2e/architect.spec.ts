import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, resetProject } from "./helpers.ts";

// The Architect end to end with the scripted chat backend: the director drafts the progression, the
// Architect tab's Build game runs the stages on the server (the plan stage is an Architect agent turn),
// and the studio follows them. (The Architect view's own e2e tests live in e2e/architect-view.spec.ts.)

test.afterEach(async ({ page }) => resetProject(page));

const project = (page: Page) => page.evaluate(() => window.studio!.getProject());
async function chat(page: Page, message: string) {
  const replies = page.getByTestId("chat-reply");
  const before = await replies.count();
  await page.getByLabel("Message").fill(message);
  await page.getByLabel("Message").press("Enter");
  await expect(replies).toHaveCount(before + 1, { timeout: 30_000 });
}

test("Build game plans the world from the progression and runs every stage on the server", async ({ page }) => {
  test.setTimeout(360_000);
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByRole("tab", { name: "Progression" }).click();
  await chat(page, "Design the structure: four regions, two abilities.");

  await page.getByRole("tab", { name: "Architect" }).click();
  await expect(page.getByTestId("architect-main")).toBeVisible();
  // Stop for review after pacing: the art stage (renders every room) has its own specs; a wide target avoids pacing repairs.
  for (const [name, input] of [["setArchitectPause", { pauseAfter: ["pacing"] }], ["setArchitectGuidance", { targetMinutes: [1, 60] }]] as const) {
    expect((await page.evaluate(([n, i]) => window.studio!.applyOperation(n, i), [name, input] as const)).ok).toBe(true);
  }
  await page.getByTestId("architect-sidebar").getByRole("button", { name: /Build game/ }).click();
  // Every stage up to pacing runs for real: the world is built, populated and proven.
  await expect(page.getByTestId("architect-last")).toContainText(/paused at Pacing/i, { timeout: 300_000 });
  const built = await project(page);
  for (const stage of ["plan", "layout", "geometry", "cast", "population", "screens", "verify"]) expect(built.architect.stages[stage as "plan"]!.status).toBe("done");
  expect(built.world.rooms.filter((r) => r.regionId).length).toBe(built.architect.rooms.length);
  expect([...new Set(built.architect.rooms.map((r) => r.regionId))]).toEqual(["gate", "city", "tower", "deep"]);
  expect(built.architect.rooms.filter((r) => r.contents.some((c) => c.kind === "start")).map((r) => r.regionId)).toEqual(["gate"]);
  expect(consoleErrors).toEqual([]);
});

test("the Architect chat plans on request and queues a build run after its turn", async ({ page }) => {
  test.setTimeout(360_000);
  await openStudio(page);
  await page.getByRole("tab", { name: "Progression" }).click();
  await chat(page, "Design the structure: four regions, two abilities.");
  await page.getByRole("tab", { name: "Architect" }).click();
  await expect(page.getByTestId("chat-reply")).toHaveCount(0); // the Architect's own conversation
  // Stop for review after pacing: the art stage (renders every room) has its own specs; a wide target avoids pacing repairs.
  for (const [name, input] of [["setArchitectPause", { pauseAfter: ["pacing"] }], ["setArchitectGuidance", { targetMinutes: [1, 60] }]] as const) {
    expect((await page.evaluate(([n, i]) => window.studio!.applyOperation(n, i), [name, input] as const)).ok).toBe(true);
  }
  await chat(page, "Plan the world and build it.");
  expect((await project(page)).architect.rooms.length).toBeGreaterThan(4);
  await expect(page.getByTestId("chat-reply").last()).toContainText("Planned the world");
  await expect(page.getByTestId("architect-last")).toContainText(/paused at Pacing/i, { timeout: 300_000 });
  expect((await project(page)).architect.stages.verify!.status).toBe("done");
});
