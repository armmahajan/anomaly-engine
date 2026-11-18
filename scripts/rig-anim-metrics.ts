/**
 * How cleanly rigs hold together while they animate (packages/art/src/animMetrics.ts), with the real runtime.
 *   node scripts/rig-anim-metrics.ts <out-dir> <label>=<rig.json>[,<concept.png>] ...
 * rig.json: {"rig", "clips"}. A cutout rig's source image is cut again from the concept
 * (default: concept.png next to rig.json's folder), the way the pipeline cuts it.
 * Writes <out>/<label>.png (filmstrips: rest, then 8 frames per clip, a row per clip) and
 * <out>/<label>.json (metrics per clip), and prints a table.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultArtDirection, rigBounds, type Clip, type Rig } from "@anomaly/core";
import { cutCharacter, decodePng, encodePng, sheetMetrics } from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";

const [out, ...specs] = process.argv.slice(2);
if (!out || specs.length === 0) throw new Error("usage: node scripts/rig-anim-metrics.ts <out-dir> <label>=<rig.json>[,<concept.png>] ...");
mkdirSync(out, { recursive: true });

const METRIC_FRAMES = 12;
const STRIP_FRAMES = 8;
const CELL = 256;

const renderer = new BrowserRenderer(fileURLToPath(new URL("../apps/studio/public/game", import.meta.url)));
const rows: string[] = [];
try {
  for (const spec of specs) {
    const [label, paths] = spec.split("=") as [string, string];
    const [rigPath, conceptArg] = paths.split(",");
    const data = JSON.parse(readFileSync(rigPath!, "utf8")) as { rig: Rig; clips: Record<string, Clip>; images?: Record<string, string> };
    const { clips } = data;
    // An invisible frame around the rest pose, 1.6 times its size, so the renderer's fit leaves room for big moves (falls, leaps).
    const b = rigBounds(data.rig);
    const [cx, cy, hw, hh] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0.8 * (b.maxX - b.minX), 0.8 * (b.maxY - b.minY)];
    const root = data.rig.bones.find((bone) => bone.parent === null)!.id;
    const frame: Rig["parts"][number] = {
      id: "metrics_frame",
      bone: root,
      z: -100,
      shape: { type: "blob", points: [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]], smooth: 0, sharp: [] },
      fill: "#000000",
      ink: 0,
      glow: false,
      opacity: 0,
    };
    const rig: Rig = { ...data.rig, parts: [...data.rig.parts, frame] };
    let images: Record<string, string> | undefined = data.images;
    if (rig.source && !images) {
      const conceptPath = conceptArg ?? join(dirname(dirname(rigPath!)), "concept.png");
      const atlas = join(dirname(rigPath!), rig.source.file);
      const png = existsSync(atlas) ? readFileSync(atlas) : encodePng(cutCharacter(decodePng(readFileSync(conceptPath)))!.image);
      images = { [rig.source.file]: png.toString("base64") };
    }
    const ids = Object.keys(clips);
    const at = (count: number, id: string) =>
      Array.from({ length: count }, (_, i) => ({ clip: id, time: clips[id]!.loop ? (clips[id]!.duration * i) / count : (clips[id]!.duration * i) / (count - 1) }));
    const direction = defaultArtDirection();
    const base = { rig, direction, clips, ...(images ? { images } : {}) };
    // Metrics: transparent background.
    const sheet = await renderer.renderRig({
      ...base,
      frames: [{ clip: null, time: 0 }, ...ids.flatMap((id) => at(METRIC_FRAMES, id))],
      cellWidth: CELL,
      cellHeight: CELL,
      columns: METRIC_FRAMES,
      background: null,
    });
    // The metric sheet's first cell is the rest pose, then clips back to back (columns don't matter to sheetMetrics).
    const metrics = sheetMetrics(decodePng(sheet.png), { width: CELL, height: CELL }, METRIC_FRAMES, ids, METRIC_FRAMES);
    // Filmstrips to look at: one row per clip, the rest pose first in each row.
    const strip = await renderer.renderRig({
      ...base,
      frames: ids.flatMap((id) => [{ clip: null, time: 0 }, ...at(STRIP_FRAMES, id)]),
      cellWidth: 220,
      cellHeight: 220,
      columns: STRIP_FRAMES + 1,
      background: "#d8d6cf",
    });
    writeFileSync(join(out, `${label}.png`), strip.png);
    writeFileSync(join(out, `${label}.json`), JSON.stringify({ clips: ids, warnings: sheet.warnings, metrics }, null, 1));
    const avg = (k: "holes" | "seams" | "debris") => (ids.reduce((s, id) => s + metrics[id]!.mean[k], 0) / ids.length).toFixed(1);
    const max = (k: "holes" | "seams" | "debris") => Math.max(...ids.map((id) => metrics[id]!.worst[k])).toFixed(1);
    const area = Math.max(...ids.map((id) => Math.abs(metrics[id]!.worst.area - 1))).toFixed(3);
    const row = `| ${label} | ${avg("holes")} / ${max("holes")} | ${avg("seams")} / ${max("seams")} | ${avg("debris")} / ${max("debris")} | ${area} |`;
    rows.push(row);
    console.log(row, sheet.warnings.length ? sheet.warnings : "");
  }
} finally {
  await renderer.close();
}
const header = "| rig | holes ‰ mean / worst | seams ‰ mean / worst | debris ‰ mean / worst | worst area change |\n|---|---|---|---|---|";
writeFileSync(join(out, "table.md"), `${header}\n${rows.join("\n")}\n`);
console.log(`\n${header}\n${rows.join("\n")}`);
