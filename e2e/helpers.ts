import { expect, type Locator, type Page } from "@playwright/test";
import { E2E_TOKEN } from "./paths.ts";

export type Entity = {
  spawnId: string;
  characterId: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  behaviorState: string | null;
  health: number;
};
export type Snapshot = {
  mode: string;
  revision: number;
  seed: number | null;
  deaths: number;
  stage: string;
  dressed: boolean;
  entities: Entity[];
  room: string | null;
  visited: string[];
  flags: string[];
  items: Record<string, number>;
  abilities: string[];
  checkpoint: { room: string; x: number; y: number } | null;
  modal: string | null;
  mapOpen: boolean;
  healthBars: string[];
  props: { id: string; visible: boolean; solid: boolean }[];
  camera: { x: number; y: number; zoom: number } | null;
  /** Keyboard keys per action in effect (the game's, with the player's overrides). */
  controls: Record<string, string[]>;
};

export const runtimeState = (page: Page) =>
  page.evaluate(() => window.studio!.getRuntimeState()) as Promise<Snapshot>;

export const projectRevision = (page: Page) => page.evaluate(() => window.studio!.getProject().revision);

export async function entity(page: Page, id: string): Promise<Entity> {
  const found = (await runtimeState(page)).entities.find((e) => e.characterId === id);
  if (!found) throw new Error(`no entity ${id}`);
  return found;
}

/** The selected enemy's patrol-state speed field (Crawler is selected by default). */
export const patrolSpeedField = (page: Page) => page.getByLabel("patrol speed");

export async function setPatrolSpeed(page: Page, value: string) {
  const field = patrolSpeedField(page);
  await field.fill(value);
  await field.press("Enter");
}

/** Open the studio and wait until the runtime is up and synced with the project. */
export async function openStudio(page: Page) {
  // The ?token= link sets the auth cookie and redirects to the clean URL.
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing", { timeout: 30_000 });
  const revision = await projectRevision(page);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(revision);
  return revision;
}

/**
 * Collect console errors, ignoring the browser's automatic log line for
 * HTTP 409/422 responses: those are the API correctly rejecting an edit.
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource: .*status of (409|422)/.test(m.text())) return;
    errors.push(m.text());
  });
  return errors;
}

/**
 * Test cleanup: start over from the starter project. Closing the page first
 * releases a playtest a failed test may have left running (the server
 * refuses to reset during one).
 */
export async function resetProject(page: Page) {
  const request = page.context().request;
  await page.close();
  await expect
    .poll(async () => {
      const { project } = (await (await request.get("/api/project")).json()) as { project: { revision: number } };
      return (await request.post("/api/reset", { data: { baseRevision: project.revision } })).ok();
    })
    .toBe(true);
}

/** The project menu (the game's name at the toolbar's left). */
export const projectMenu = (page: Page) => page.getByRole("button", { name: /project menu/ });

/** The in-page confirmation (ui/confirm.tsx): press its confirming button. */
export async function confirmInPage(page: Page, button: string | RegExp) {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: button }).click();
  await expect(dialog).toHaveCount(0);
}

/** Project menu ▸ Load the example game…, confirmed in the page. */
export async function loadExample(page: Page) {
  await projectMenu(page).click();
  await page.getByRole("menuitem", { name: /Load the example game/ }).click();
  await confirmInPage(page, "Load the example");
}

/** Wait until the studio has seen a revision newer than `base` and the runtime has loaded it. */
export async function waitForRuntimeAfter(page: Page, base: number) {
  await expect
    .poll(async () => {
      const revision = await projectRevision(page);
      return revision > base && (await runtimeState(page)).revision === revision;
    })
    .toBe(true);
}

/**
 * Type a value into an inspector field and press Enter, then wait until the
 * server has accepted it (revision +1) and the runtime has rebuilt from it.
 * (Reading the revision right after Enter races the save.)
 */
export async function commitField(page: Page, field: Locator, value: string) {
  const before = await projectRevision(page);
  await field.fill(value);
  await field.press("Enter");
  await expect.poll(() => projectRevision(page)).toBe(before + 1);
  await expect.poll(async () => (await runtimeState(page)).revision).toBe(before + 1);
}
