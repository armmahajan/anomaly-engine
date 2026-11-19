/**
 * Gaps in animated rigs, measured in the real runtime (web export in headless Chromium).
 *   node scripts/rig-gaps.ts <round-dir> <out-dir> [--label before] [--subjects player,troll] [--arm layered]
 * For each subject's <round>/<subject>/<arm>/rig.json (rig, clips; textures beside it), every clip
 * is drawn at FRAMES frames in 512 px cells (fit to the rest pose, about 2x the round's 320 px
 * filmstrips). A gap pixel lies inside the posed figure (its opaque mask, closed with a 4 px
 * radius, less a 2 px band along the outer silhouette's anti-aliasing) but shows the background
 * (coverage under 95%). Writes <out>/<label>-<subject>.json (counts per clip and frame), and
 * <out>/<label>-<subject>-<clip>.png (the frames with gap pixels in red) and -zoom.png (four
 * frames' figures at 2x).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProject, rigFiles, type Clip, type Rig } from "@anomaly/core";
import { decodePng, dilate, encodePng, erode, type Pixels } from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const round = args[0] ?? "";
const out = args[1] ?? "";
if (!round || !out) throw new Error("usage: node scripts/rig-gaps.ts <round-dir> <out-dir> [--label before] [--subjects a,b] [--arm layered]");
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const label = flag("--label") ?? "gaps";
const arm = flag("--arm") ?? "layered";
const subjects = (flag("--subjects") ?? "player,troll,turret").split(",");
mkdirSync(out, { recursive: true });

const FRAMES = 16;
const CELL = 512;
const COLUMNS = 8;
const CLOSE = Number(flag("--close") ?? 4);
const RIM = 2;
const COVERED = Math.round(0.95 * 255);

/** Gap pixels of one cell (alpha only), and the cell's gap mask. */
export function gapsOf(cell: Pixels): { count: number; mask: Uint8Array } {
  const { width: W, height: H, data } = cell;
  const solid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) solid[i] = data[i * 4 + 3]! >= 128 ? 1 : 0;
  const closed = erode(dilate(solid, W, H, CLOSE), W, H, CLOSE);
  const inside = erode(closed, W, H, RIM);
  const mask = new Uint8Array(W * H);
  let count = 0;
  for (let i = 0; i < W * H; i++)
    if (inside[i] && data[i * 4 + 3]! < COVERED) {
      mask[i] = 1;
      count++;
    }
  return { count, mask };
}

function cellOf(sheet: Pixels, n: number): Pixels {
  const x0 = (n % COLUMNS) * CELL;
  const y0 = Math.floor(n / COLUMNS) * CELL;
  const data = new Uint8Array(CELL * CELL * 4);
  for (let y = 0; y < CELL; y++) data.set(sheet.data.subarray(((y + y0) * sheet.width + x0) * 4, ((y + y0) * sheet.width + x0 + CELL) * 4), y * CELL * 4);
  return { width: CELL, height: CELL, data };
}

/** The cell over the stage colour, gap pixels red. */
function shown(cell: Pixels, mask: Uint8Array): Pixels {
  const bg = [0xd8, 0xd6, 0xcf];
  const data = new Uint8Array(cell.data.length);
  for (let i = 0; i < CELL * CELL; i++) {
    const a = cell.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(cell.data[i * 4 + c]! * a + bg[c]! * (1 - a));
    data[i * 4 + 3] = 255;
    if (mask[i]) data.set([255, 0, 0, 255], i * 4);
  }
  return { width: CELL, height: CELL, data };
}

function strip(cells: Pixels[], scale = 1, crop?: { x: number; y: number; w: number; h: number }): Pixels {
  const c = crop ?? { x: 0, y: 0, w: CELL, h: CELL };
  const w = c.w * scale;
  const h = c.h * scale;
  const data = new Uint8Array(w * cells.length * h * 4);
  cells.forEach((cell, n) => {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = c.x + Math.floor(x / scale);
        const sy = c.y + Math.floor(y / scale);
        data.set(cell.data.subarray((sy * CELL + sx) * 4, (sy * CELL + sx) * 4 + 4), (y * w * cells.length + n * w + x) * 4);
      }
  });
  return { width: w * cells.length, height: h, data };
}

const renderer = new BrowserRenderer(flag("--export") ?? join(root, "apps/studio/public/game"));
try {
  for (const subject of subjects) {
    const dir = join(round, subject, arm);
    const saved = JSON.parse(readFileSync(join(dir, "rig.json"), "utf8")) as { rig: Rig; clips: Record<string, Clip> };
    const images = Object.fromEntries(rigFiles(saved.rig).map((r) => [r, readFileSync(join(dir, r)).toString("base64")]));
    const report: Record<string, { total: number; worst: number; frames: number[]; motion: number; motionWorst: number }> = {};
    // The design's own narrow gaps (between legs, under an arm) show at rest too: a gap pixel within
    // 3 px of one at rest is the design's, not one the motion opened ("motion" counts the others).
    const restSheet = decodePng(
      (await renderer.renderRig({ rig: saved.rig, direction: createDefaultProject().art.direction, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: CELL, cellHeight: CELL, columns: 1, background: null, images })).png,
    );
    const restGaps = dilate(gapsOf(restSheet).mask, CELL, CELL, 3);
    for (const [name, clip] of Object.entries(saved.clips)) {
      const frames = Array.from({ length: FRAMES }, (_, i) => ({ clip: name, time: clip.loop ? (clip.duration * i) / FRAMES : (clip.duration * i) / (FRAMES - 1) }));
      const sheet = decodePng(
        (
          await renderer.renderRig({
            rig: saved.rig,
            direction: createDefaultProject().art.direction,
            clips: saved.clips,
            frames,
            cellWidth: CELL,
            cellHeight: CELL,
            columns: COLUMNS,
            background: null,
            images,
          })
        ).png,
      );
      const cells = frames.map((_, n) => cellOf(sheet, n));
      const gaps = cells.map(gapsOf);
      const motion = gaps.map((g) => g.mask.reduce((s, v, i) => s + (v && !restGaps[i] ? 1 : 0), 0));
      report[name] = {
        total: gaps.reduce((s, g) => s + g.count, 0),
        worst: Math.max(...gaps.map((g) => g.count)),
        frames: gaps.map((g) => g.count),
        motion: motion.reduce((s, v) => s + v, 0),
        motionWorst: Math.max(...motion),
      };
      const views = cells.map((c, n) => shown(c, gaps[n]!.mask));
      writeFileSync(join(out, `${label}-${subject}-${name}.png`), encodePng(strip(views)));
      // Zoom: four frames, the figure's box (over all frames) at 2x.
      let [x0, y0, x1, y1] = [CELL, CELL, 0, 0];
      for (const c of cells)
        for (let i = 0; i < CELL * CELL; i++)
          if (c.data[i * 4 + 3]! > 0) {
            const x = i % CELL;
            const y = Math.floor(i / CELL);
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x + 1);
            y1 = Math.max(y1, y + 1);
          }
      const pick = [2, 6, 10, 14].map((n) => views[n]!);
      writeFileSync(join(out, `${label}-${subject}-${name}-zoom.png`), encodePng(strip(pick, 2, { x: Math.max(0, x0 - 4), y: Math.max(0, y0 - 4), w: Math.min(CELL, x1 + 4) - Math.max(0, x0 - 4), h: Math.min(CELL, y1 + 4) - Math.max(0, y0 - 4) })));
    }
    writeFileSync(join(out, `${label}-${subject}.json`), JSON.stringify(report, null, 1));
    console.log(`${label} ${subject}: ${Object.entries(report).map(([n, r]) => `${n} total ${r.total} worst-frame ${r.worst} motion ${r.motion} motion-worst ${r.motionWorst}`).join("; ")}`);
  }
} finally {
  await renderer.close();
}
