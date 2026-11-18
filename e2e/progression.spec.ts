import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, resetProject } from "./helpers.ts";

test.afterEach(({ page }) => resetProject(page));

test("the director drafts the progression; the creator reviews it, the studio checks it", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  const tab = page.getByRole("tab", { name: /Progression/ });
  const graph = page.getByTestId("progression-graph");
  const panel = page.getByTestId("progression-panel");
  const checks = page.getByTestId("progression-issues");
  const node = (id: string) => page.getByTestId(`region-node-${id}`);
  // Spheres run across (columns) or down (rows), whichever fits the pane: where along that axis a node sits.
  const column = async (id: string) => {
    const box = (await node(id).boundingBox())!;
    return (await graph.getAttribute("data-orientation")) === "down" ? Math.round(box.y + box.height / 2) : Math.round(box.x + box.width / 2);
  };

  await tab.click();
  await expect(page.getByTestId("chat-narrative").getByRole("heading")).toHaveText("Director");
  await expect(page.getByRole("heading", { name: "Your game's progression" })).toBeVisible();

  // The director drafts a structure; the graph lays it out by sphere.
  await page.getByLabel("Message").fill("Design the structure: four regions, two abilities.");
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByTestId("chat-reply").last()).toContainText("Should the Lamp Key come from a boss instead?");
  await expect(page.getByTestId("chat-reply").last()).toContainText("drafted region gate");
  await expect(tab).toContainText("9");
  await expect(page.getByTestId("progression-status")).toContainText("Finishable");
  await expect(page.getByTestId("critical-path")).toHaveText("Critical path: ◆ Dash → ◆ Lamp Key");
  for (const heading of ["Sphere 0", "Sphere 1", "Sphere 2"]) await expect(graph.getByText(heading)).toBeVisible();
  expect(Math.abs((await column("gate")) - (await column("city")))).toBeLessThanOrEqual(1); // the graph is scaled to fit: same column, within a pixel
  expect(await column("tower")).toBeGreaterThan(await column("city"));
  expect(await column("deep")).toBeGreaterThan(await column("tower"));
  await expect(node("city")).toContainText("☠ Charger");
  await expect(node("gate")).toContainText("START");
  await expect(checks).toHaveCount(0);

  // Accept a draft.
  await node("city").click();
  await expect(panel).toContainText("Draft by the director");
  await panel.getByRole("button", { name: "Accept" }).click();
  await expect(panel.getByText("Canon", { exact: true })).toBeVisible();
  await expect(tab).toContainText("8");

  // A region of the creator's own starts unreachable.
  await page.getByRole("button", { name: "+ Region" }).click();
  await page.getByLabel("Name").fill("The Sump");
  await page.getByRole("button", { name: "Save as canon" }).click();
  await expect(graph.getByText("Unreachable")).toBeVisible();
  await expect(checks).toContainText("The Sump can't be reached from the start.");

  // A one-way drop into it traps the player: a soft-lock.
  await page.getByRole("button", { name: "+ Connection" }).click();
  await page.getByLabel("From", { exact: true }).selectOption({ label: "Drowned City" });
  await page.getByLabel("To", { exact: true }).selectOption({ label: "The Sump" });
  await page.getByLabel("One-way").check();
  await page.getByRole("button", { name: "Save as canon" }).click();
  await expect(checks).toContainText("Soft-lock: the player can reach The Sump holding nothing (sphere 0)");
  await expect(page.getByTestId("progression-status")).toContainText("Finishable");
  await checks.getByRole("listitem").filter({ hasText: "Soft-lock" }).getByRole("button", { name: "Show" }).click();
  await expect(panel.getByRole("heading")).toHaveText("The Sump");
  await expect(node("the_sump")).toHaveClass(/selected/);
  await expect(node("the_sump")).toHaveClass(/flagged/);

  // Undo removes the drop, and the soft-lock with it.
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect(checks).not.toContainText("Soft-lock");
  await expect(checks).toContainText("The Sump can't be reached");

  // Editing a gate updates the analysis: without the dash gate, only the key matters.
  await page.getByTestId("connection-label-city_tower").click();
  await expect(panel.getByRole("heading")).toHaveText("Connection");
  await panel.getByLabel("Dash").uncheck();
  await panel.getByRole("button", { name: "Save as canon" }).click();
  await expect(page.getByTestId("critical-path")).toHaveText("Critical path: ◆ Lamp Key");
  await expect(checks).toContainText("Dash doesn't open anything");

  // Hiding the key behind the gate it opens makes the game unbeatable.
  await page.getByTestId("progression-item-lamp_key").click();
  await page.getByLabel("Found in").selectOption({ label: "The Deep" });
  await panel.getByRole("button", { name: "Save as canon" }).click();
  await expect(page.getByTestId("progression-status")).toContainText("Not finishable");
  await expect(checks).toContainText("The ending, The Deep, can't be reached");

  // The graph zooms and fits; the item panel closes.
  const level = page.locator(".pan-zoom-level");
  const fitted = await level.textContent();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).not.toHaveText(fitted!);
  await page.getByRole("button", { name: "Fit" }).click();
  await expect(level).toHaveText(fitted!);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);

  // Accept all asks in the page, then makes every draft canon.
  await page.getByTestId("progression-review-bar").getByRole("button", { name: "Accept all…" }).click();
  await page.getByRole("button", { name: /^Accept \d+$/ }).click();
  await expect(page.getByTestId("progression-review-bar")).toHaveCount(0);
  await expect(tab).not.toContainText(/\d/);

  expect(consoleErrors).toEqual([]);
});

test("opening the progression stops a playtest", async ({ page }) => {
  await openStudio(page);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await page.getByRole("tab", { name: "Progression" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
});
