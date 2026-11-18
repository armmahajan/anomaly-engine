import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, confirmInPage, openStudio, projectRevision, resetProject } from "./helpers.ts";
import { rigTheCharger } from "./rigFixture.ts";

test.afterEach(({ page }) => resetProject(page));

const beetle = async (page: Page) => (await page.evaluate(() => window.studio!.getProject())).art.assets.find((a) => a.id === "beetle") as { clips: Record<string, unknown>; stateClips: Record<string, string> };

test("the animation list: add a named animation, attach it to a behavior state, rename it, delete it, undo", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await rigTheCharger(page);
  await page.getByTestId("character-charger").click();
  await page.getByRole("tab", { name: "Characters" }).click();
  const list = page.getByTestId("animation-list");
  await expect(list.getByTestId("clip-idle")).toBeVisible();

  // Add a named animation from a direction (an animate job with the fake backend, or a copy until named animation lands).
  await list.getByText("+ Add an animation").click();
  await list.getByLabel("new animation name").fill("Overhead Chop");
  await list.getByLabel("new animation direction").fill("a heavy overhead chop, leaning in");
  await list.getByTestId("add-animation").getByRole("button", { name: /^(Add|Animate it)$/ }).click();
  await expect(list.getByTestId("clip-overhead_chop")).toBeVisible({ timeout: 60_000 });

  // Preview it on the stage, then attach it to the charger's windup state.
  await list.getByTestId("clip-overhead_chop").getByRole("button").click();
  await expect(list.getByTestId("clip-overhead_chop").getByRole("button")).toHaveText(/■ overhead_chop/);
  const detail = list.getByTestId("clip-detail");
  await expect(detail.getByLabel("animation name")).toHaveValue("overhead_chop");
  await detail.getByLabel("attach to").selectOption("state:windup");
  await expect(detail.getByTestId("attached-state-windup")).toBeVisible();
  expect((await beetle(page)).stateClips).toEqual({ windup: "overhead_chop" });

  // Renaming keeps it attached (one undo step).
  const before = await projectRevision(page);
  await detail.getByLabel("animation name").fill("chop");
  await detail.getByLabel("animation name").press("Enter");
  await expect(list.getByTestId("clip-chop")).toBeVisible();
  expect(await projectRevision(page)).toBe(before + 1);
  const renamed = await beetle(page);
  expect(renamed.stateClips).toEqual({ windup: "chop" });
  expect(renamed.clips.overhead_chop).toBeUndefined();

  // Delete asks in the page; the state goes back to its automatic clip. Undo brings both back.
  await list.getByTestId("clip-detail").getByRole("button", { name: "Delete" }).click();
  await confirmInPage(page, "Delete");
  await expect(list.getByTestId("clip-chop")).toHaveCount(0);
  expect((await beetle(page)).stateClips).toEqual({});
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect(list.getByTestId("clip-chop")).toBeVisible();
  expect((await beetle(page)).stateClips).toEqual({ windup: "chop" });
  expect(consoleErrors).toEqual([]);
});
