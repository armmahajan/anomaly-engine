/**
 * Screenshot a studio mode in headless Chromium (layout checks).
 *   node scripts/screenshot-mode.ts <studio url with ?token=…> <Arena|Characters|Worlds|Wiki> <out-prefix> [label to check ...]
 * Writes <out-prefix>.png, then one more <out-prefix>-<n>.png after ticking each labelled checkbox.
 */
import { chromium } from "playwright-core";

const [url, mode, out, ...checks] = process.argv.slice(2);
if (!url || !mode || !out) throw new Error("usage: node scripts/screenshot-mode.ts <url> <mode> <out-prefix> [checkbox label ...]");

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
  await page.goto(url);
  await page.getByTestId("runtime-status").getByText("Editing").waitFor({ timeout: 60_000 });
  await page.getByRole("tab", { name: mode }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}.png` });
  for (const [i, label] of checks.entries()) {
    await page.getByLabel(label).setChecked(true);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${out}-${i + 1}.png` });
  }
} finally {
  await browser.close();
}
