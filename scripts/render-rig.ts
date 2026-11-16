/**
 * Render a rig to a PNG contact sheet with the real runtime (headless Chromium).
 *   node scripts/render-rig.ts <out.png> [rig.json]
 * rig.json: {"rig", "clips"?, "direction"?}; defaults to the built-in example.
 * Rows: rest pose, then 6 frames of each clip.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultArtDirection, exampleClips, exampleRig, type Clip, type Rig } from "@anomaly/core";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";

const [out, input] = process.argv.slice(2);
if (!out) throw new Error("usage: node scripts/render-rig.ts <out.png> [rig.json]");
const data = input
  ? (JSON.parse(readFileSync(input, "utf8")) as { rig: Rig; clips?: Record<string, Clip>; direction?: ReturnType<typeof defaultArtDirection> })
  : { rig: exampleRig(), clips: exampleClips() };
const clips = data.clips ?? {};
const FRAMES = 6;
const frames = [
  ...Array.from({ length: FRAMES }, (_, i) => ({ clip: null, time: i * 0.1 })),
  ...Object.entries(clips).flatMap(([id, clip]) =>
    Array.from({ length: FRAMES }, (_, i) => ({ clip: id, time: (clip.duration * i) / FRAMES })),
  ),
];
const renderer = new BrowserRenderer(fileURLToPath(new URL("../apps/studio/public/game", import.meta.url)));
try {
  const t0 = Date.now();
  const image = await renderer.renderRig({
    rig: data.rig,
    direction: data.direction ?? defaultArtDirection(),
    clips,
    frames,
    cellWidth: 160,
    cellHeight: 160,
    columns: FRAMES,
    background: "#d8d6cf",
  });
  writeFileSync(out, image.png);
  console.log(`${image.width}x${image.height}, scale ${image.scale.toFixed(2)}, ${Date.now() - t0}ms`, image.warnings);
} finally {
  await renderer.close();
}
