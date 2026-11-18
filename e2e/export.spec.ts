import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { loadExample, openStudio, projectMenu, resetProject, type Snapshot } from "./helpers.ts";

test.afterEach(async ({ page }) => resetProject(page));

/** Write a zip's entries under `root` (stored or deflated entries, as the export writes them). */
async function unzipTo(zip: Buffer, root: string): Promise<string[]> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(dataAt, dataAt + size);
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, method === 8 ? inflateRawSync(body) : body);
    names.push(name);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return names;
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".txt": "text/plain",
};

/** A plain static file server for `root` on a free port (no special headers). */
async function serveStatic(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return { server, origin: `http://localhost:${(server.address() as AddressInfo).port}` };
}

const gameState = (page: Page) => page.evaluate(() => (window as unknown as { game: { state(): Promise<unknown> } }).game.state()) as Promise<Snapshot>;

/** Open the exported game at `url`: it boots on its title in the start room; Enter starts it. Only its own files are requested. */
async function playExport(page: Page, url: string, origin: string, title: string, saveKey: string) {
  const foreign: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(origin)) foreign.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await expect(page).toHaveTitle(title);
  await expect(page.locator("body")).toHaveAttribute("data-status", "playing", { timeout: 30_000 });
  await expect(page.getByRole("complementary", { name: "Controls" })).toBeVisible();
  await expect.poll(async () => (await gameState(page)).modal).toBe("title");
  const state = await gameState(page);
  expect(state).toMatchObject({ mode: "play", room: "entrance" });
  await expect(page.locator("body")).toHaveAttribute("data-room", "entrance");
  // The title's button starts the game (keys reach the runtime without a click).
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await gameState(page)).modal).toBeNull();
  // The game's rules save the run in this browser, under the game's own key.
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key) !== null, saveKey)).toBe(true);
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
}

test("Export game: the example exports as a standalone web game that plays from any folder", async ({ page, browser }, testInfo) => {
  test.setTimeout(150_000);
  await openStudio(page);
  // The starter project has no ending: the page says so, and Cancel exports nothing.
  await projectMenu(page).click();
  await page.getByRole("menuitem", { name: /Export game/ }).click();
  await expect(page.getByTestId("export-verdict")).toContainText("it has no ending");
  await page.getByTestId("export-dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("export-dialog")).toHaveCount(0);

  await loadExample(page);
  // The page has the example once its rooms arrive (the reset answers before the page catches up).
  await expect.poll(() => page.evaluate(() => window.studio!.getProject().world.rooms.some((r) => r.id === "entrance"))).toBe(true);
  const name = await page.evaluate(() => window.studio!.getProject().name);

  await projectMenu(page).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /Export game/ }).click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog).toBeVisible();
  // The example is proven beatable, so it builds straight away and downloads.
  const download = await downloading;
  await expect(dialog.getByTestId("export-done")).toContainText("Checked: the game can be finished");
  await expect(dialog.getByTestId("export-size")).toHaveText(/\d+(\.\d)? MB/);
  await expect(dialog).toContainText("Game runtime (web)");
  await page.screenshot({ path: testInfo.outputPath("export-dialog.png") });
  const zipPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(zipPath);
  expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+\.zip$/);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // Unzip it at the site's root and again in a subfolder.
  const root = testInfo.outputPath("site");
  const zip = await readFile(zipPath);
  const names = await unzipTo(zip, root);
  await unzipTo(zip, join(root, "games", "ours"));
  expect(names).toContain("index.html");
  expect(names).toContain("runtime/index.wasm");
  expect(names.filter((n) => !/^(index\.html|game\.json|README\.txt|runtime\/index\.[a-z.-]+|files\/[0-9a-f]+\.(png|jpg|webp))$/.test(n))).toEqual([]);
  const data = JSON.parse(await readFile(join(root, "game.json"), "utf8")) as { saveKey: string };

  const { server, origin } = await serveStatic(root);
  try {
    for (const path of ["/", "/games/ours/"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      try {
        await playExport(await context.newPage(), origin + path, origin, name, data.saveKey);
      } finally {
        await context.close();
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
