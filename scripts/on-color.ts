/** Composite images over a solid color to inspect their alpha: node scripts/on-color.ts <color> <in.png> <out.png> [...] */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pngSize } from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";

const [color, ...pairs] = process.argv.slice(2);
const renderer = new BrowserRenderer(fileURLToPath(new URL("../apps/studio/public/game", import.meta.url)));
try {
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const image = readFileSync(pairs[i]!);
    writeFileSync(pairs[i + 1]!, await renderer.compose({ ...pngSize(image), background: color, layers: [{ image }] }));
  }
} finally {
  await renderer.close();
}
