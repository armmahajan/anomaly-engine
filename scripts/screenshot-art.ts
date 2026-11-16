/**
 * Screenshot the studio's Art tab and the arena for one character (headless Chromium).
 *   node scripts/screenshot-art.ts <studio url with ?token=…> <characterId> <out-prefix>
 * Writes <out-prefix>-art.png (whole studio, Art tab open) and <out-prefix>-play.png (mid-playtest).
 */
import { chromium } from "playwright-core";

const [url, characterId, out] = process.argv.slice(2);
if (!url || !characterId || !out) throw new Error("usage: node scripts/screenshot-art.ts <url> <characterId> <out-prefix>");

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
  await page.goto(url);
  await page.getByTestId("runtime-status").getByText("Editing").waitFor({ timeout: 60_000 });
  await page.getByTestId(`character-${characterId}`).click();
  await page.getByRole("tab", { name: "Characters" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}-art.png` });
  await page.getByRole("button", { name: "▶ Play" }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}-play.png` });
  await page.getByRole("button", { name: "■ Stop" }).click();
} finally {
  await browser.close();
}
