/**
 * Re-render a generated world (no model calls): node scripts/world-render.ts <slug> [camera x ...]
 * Reads apps/studio/public/world-preview/<slug>/scene.json and writes views.png next to it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldScene } from "@anomaly/core";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";

const [slug, ...xs] = process.argv.slice(2);
if (!slug) throw new Error("usage: node scripts/world-render.ts <slug> [camera x ...]");
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "apps/studio/public/world-preview", slug);
const scene = WorldScene.parse(JSON.parse(readFileSync(join(dir, "scene.json"), "utf8")));
const refs = new Set([scene.backdrop, scene.ground, ...scene.pieces.map((p) => p.file)]);
const images = Object.fromEntries([...refs].map((ref) => [ref, readFileSync(join(dir, ref)).toString("base64")]));
const cameras = xs.length > 0 ? xs.map(Number) : [0, scene.width / 2, scene.width];

const renderer = new BrowserRenderer(join(root, "apps/studio/public/game"));
try {
  const views = await renderer.renderWorld({ scene, images, cameras, width: 960, height: 540 });
  writeFileSync(join(dir, "views.png"), views.png);
  console.log(`rendered ${views.width}x${views.height}`, views.warnings);
} finally {
  await renderer.close();
}
