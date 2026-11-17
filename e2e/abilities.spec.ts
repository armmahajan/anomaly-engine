import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject, runtimeState, waitForRuntimeAfter, type Snapshot } from "./helpers.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.afterEach(({ page }) => resetProject(page));

async function play(page: Page) {
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect.poll(async () => (await runtimeState(page)).mode).toBe("play");
}

/** Sample the runtime every ~20ms while `act` runs. */
async function during(page: Page, act: () => Promise<void>): Promise<Snapshot[]> {
  const samples: Snapshot[] = [];
  let done = false;
  const sampling = (async () => {
    while (!done) {
      samples.push(await runtimeState(page));
      await pause(20);
    }
  })();
  await act();
  await pause(300);
  done = true;
  await sampling;
  return samples;
}

const playerOf = (s: Snapshot) => s.entities.find((e) => e.characterId === "player")!;

test("the creator gives the player abilities, tunes them, and uses them in a playtest", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  await page.getByTestId("character-player").click();
  const dash = page.getByRole("checkbox", { name: "Dash" });
  await expect(dash).not.toBeChecked();
  await expect(page.getByLabel("Dash distance")).toHaveCount(0);

  // Turning an ability on shows its tuning; tuning is an ordinary undoable edit.
  const base = await projectRevision(page);
  await dash.click();
  await expect(dash).toBeChecked();
  await waitForRuntimeAfter(page, base);
  const distance = page.getByLabel("Dash distance");
  await expect(distance).toHaveValue("220");
  await distance.fill("300");
  await distance.press("Enter");
  await expect(page.getByLabel("Dash distance")).toHaveValue("300");
  await page.getByRole("checkbox", { name: "Glide" }).click();
  await expect(page.getByLabel("Glide fall speed")).toHaveValue("110");

  // The dash key dashes exactly the tuned distance.
  await play(page);
  const startX = playerOf(await runtimeState(page)).x;
  const dashing = await during(page, async () => {
    await page.keyboard.down("c");
    await pause(60);
    await page.keyboard.up("c");
  });
  expect(dashing.some((s) => playerOf(s).behaviorState === "dash")).toBe(true);
  expect(playerOf(dashing.at(-1)!).x - startX).toBeCloseTo(300, 0);

  // Holding jump while falling glides.
  const gliding = await during(page, async () => {
    await page.keyboard.down("Space");
    await pause(900);
    await page.keyboard.up("Space");
  });
  expect(gliding.some((s) => playerOf(s).behaviorState === "glide" && playerOf(s).velocityY === 110)).toBe(true);

  // Without the ability, the key does nothing.
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  await page.getByRole("checkbox", { name: "Dash" }).click();
  await expect(page.getByLabel("Dash distance")).toHaveCount(0);
  await play(page);
  const before = playerOf(await runtimeState(page)).x;
  const still = await during(page, async () => {
    await page.keyboard.down("c");
    await pause(60);
    await page.keyboard.up("c");
  });
  expect(still.every((s) => playerOf(s).behaviorState !== "dash" && playerOf(s).x === before)).toBe(true);

  // Undo restores the dash.
  await page.getByRole("button", { name: "■ Stop" }).click();
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect(page.getByRole("checkbox", { name: "Dash" })).toBeChecked();
  expect(consoleErrors).toEqual([]);
});

test("a ground pound smashes the cracked platform", async ({ page }) => {
  await openStudio(page);
  const base = await projectRevision(page);
  const res = await page.request.post("/api/batch", {
    data: {
      baseRevision: base,
      operations: [
        { name: "setPlaytest", input: { abilities: ["ground_pound"] } },
        { name: "setPlaytest", input: { x: 830, y: 416 } },
      ],
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await waitForRuntimeAfter(page, base);
  await play(page);
  await expect.poll(async () => playerOf(await runtimeState(page)).y).toBe(416);
  await page.keyboard.down("Space");
  await pause(120);
  await page.keyboard.up("Space");
  await page.keyboard.down("s");
  await page.keyboard.down("Space");
  await pause(60);
  await page.keyboard.up("Space");
  await page.keyboard.up("s");
  await expect.poll(async () => playerOf(await runtimeState(page)).y, { timeout: 3000 }).toBe(672);
});
