/**
 * Natural motion demo: a layered rig played through the real runtime (headless Godot,
 * game/tests/rig_pose_probe.gd: crossfades and springs are stateful, so every frame continues the
 * last) and drawn here from the posed meshes. Before = the rig and clips as generated; after = the
 * same art with hand-written natural-motion data: a spring on a hair bone split off the head and on
 * the forearms, IK planting the feet, a crossfade from idle into walk.
 *
 *   node scripts/motion-demo.ts <layered dir with rig.json and its atlas> <out dir>
 *
 * Writes frames/NNNN.png (before | after, side by side, the character walking across fixed ground
 * marks) and after-rig.json (the hand-written rig and clips).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Clip, Rig } from "@anomaly/core";
import { decodePng, encodePng, type Pixels } from "@anomaly/art";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error("usage: node scripts/motion-demo.ts <layered dir> <out dir>");
const GAME_DIR = fileURLToPath(new URL("../game", import.meta.url));
const FPS = 30;
const IDLE = 1.0; // seconds of idle before the walk starts
const WALK = 2.7;
const SCALE = 6;
const SPEED = 20; // ground px/s of the after walk (its stance foot moves back 9 px in 0.45 s)
const CELL = { width: 520, height: 380 };

type Vec = [number, number];
type Layer = { points: Vec[]; indices: number[]; uv: Vec[] };
const saved = JSON.parse(readFileSync(join(dir, "rig.json"), "utf8")) as { rig: Rig; clips: Record<string, Clip> };
const rig = Rig.parse(saved.rig);
const atlases = new Map<string, Pixels>();
for (const p of rig.parts) if (p.texture && !atlases.has(p.texture.file)) atlases.set(p.texture.file, decodePng(readFileSync(join(dir, p.texture.file))));

// --- the after rig: hair split off the head on a spring bone, springy forearms, feet for IK ---

/**
 * Split the triangles of mesh part `id` beyond `cut` (y; `above` the line or below it) into a new
 * part on `bone`, bending back to the part's bone across the cut: weight 1 (the old bone) at the
 * cut, 0 (the new bone) `blend` px past it. The old part keeps the rest (its vertices at the cut are
 * not weighted toward its bendTo there, so the seam holds).
 */
function split(r: Rig, id: string, newId: string, bone: string, cut: number, above: boolean, blend: number): void {
  const part = r.parts.find((p) => p.id === id)!;
  if (part.shape.type !== "mesh") throw new Error("expects a layered rig");
  const s = part.shape;
  const verts = [...s.points, ...s.inner];
  const past = (y: number, by = 0) => (above ? y < cut - by : y > cut + by);
  const tris: number[][] = [];
  for (let i = 0; i < s.triangles.length; i += 3) tris.push(s.triangles.slice(i, i + 3));
  const moves = (t: number[]) => t.every((i) => past(verts[i]![1], -0.4)) && t.some((i) => past(verts[i]![1]));
  const moved = tris.filter(moves);
  const used = [...new Set(moved.flat())];
  const index = new Map(used.map((v, i) => [v, i]));
  const weight = (y: number) => {
    const u = Math.min(1, Math.max(0, Math.abs(y - cut) / blend));
    return Math.round((1 - u * u * (3 - 2 * u)) * 1000) / 1000;
  };
  const kept = used.map((i) => verts[i]!);
  r.parts.push({
    ...part,
    id: newId,
    bone,
    bendTo: part.bone,
    shape: { type: "mesh", points: kept.slice(0, 3), inner: kept.slice(3), triangles: moved.flat().map((i) => index.get(i)!), uv: used.map((i) => s.uv[i]!), weights: kept.map((v) => weight(v[1])) },
  });
  part.shape = { ...s, triangles: tris.filter((t) => !moves(t)).flat() };
}

function afterRig(): Rig {
  const r = structuredClone(rig);
  // Hair: the head mesh above -48.6 (its weights toward the chest stop below -47.9) on a floppy spring.
  r.bones.push({ id: "hair", parent: "head", pivot: [1, -48.6], spring: { stiffness: 0.12, damping: 0.22 } });
  split(r, "head", "hair", "hair", -48.6, true, 4);
  // Forearms trail the upper arms' swing.
  for (const id of ["arm_lower_near", "arm_lower_far"]) r.bones.find((b) => b.id === id)!.spring = { stiffness: 0.25, damping: 0.35 };
  // Feet: the shoes split off the shins at the ankle, so IK can keep them flat on the ground.
  r.bones.push({ id: "foot_near", parent: "leg_lower_near", pivot: [2.2, -2.8] }, { id: "foot_far", parent: "leg_lower_far", pivot: [-6.5, -2.8] });
  split(r, "leg_lower_near", "foot_near", "foot_near", -4.2, false, 1.6);
  split(r, "leg_lower_far", "foot_far", "foot_far", -4.2, false, 1.6);
  return Rig.parse(r);
}

function afterClips(): Record<string, Clip> {
  const walk = structuredClone(saved.clips.walk!);
  // The hip sits 0.7 px lower (the knees never lock) and is lowest when the feet are apart (t 0, 0.5).
  walk.tracks.push({ bone: "pelvis", property: "y", keys: [[0, 0.7], [1, 0.7]], ease: "linear" });
  walk.motions = walk.motions.map((m) => (m.type === "bob" && m.bone === "pelvis" ? { ...m, amount: 0.35, phase: 0.75 } : m));
  const y = -2.8;
  walk.ik = [
    // Stance (0..0.5): the near foot moves back on the ground at walking speed; swing: up and forward.
    { bone: "leg_lower_near", tip: "foot_near", bend: "cw", ease: "linear", keys: [[0, 6.7, y], [0.5, -2.3, y], [0.6, -1.4, y - 1.6], [0.75, 2.6, y - 2.6], [0.9, 6.0, y - 1.3], [0.96, 6.6, y - 0.2], [1, 6.7, y]] },
    { bone: "leg_lower_far", tip: "foot_far", bend: "cw", ease: "linear", keys: [[0, -9.5, y], [0.1, -8.6, y - 1.6], [0.25, -4.6, y - 2.6], [0.4, -1.2, y - 1.3], [0.46, -0.6, y - 0.2], [0.5, -0.5, y], [1, -9.5, y]] },
  ];
  walk.blendIn = 0.3;
  return { idle: Clip.parse(saved.clips.idle), walk: Clip.parse(walk) };
}

function beforeClips(): Record<string, Clip> {
  return { idle: Clip.parse(saved.clips.idle), walk: Clip.parse({ ...saved.clips.walk, blendIn: 0 }) };
}

// --- run both through the runtime --------------------------------------------------------------

const seq = () => [
  { clip: "idle", time: 0 },
  ...Array.from({ length: IDLE * FPS }, (_, i) => ({ clip: "idle", time: (i + 1) / FPS, continue: true })),
  { clip: "walk", time: 0 },
  ...Array.from({ length: WALK * FPS }, (_, i) => ({ clip: "walk", time: (i + 1) / FPS, continue: true })),
];
const textures = Object.fromEntries([...atlases].map(([f, p]) => [f, [p.width, p.height]]));
const after = afterRig();
mkdirSync(join(out, "frames"), { recursive: true });
writeFileSync(join(out, "after-rig.json"), JSON.stringify({ rig: after, clips: afterClips() }, null, 1));
const input = { cases: [{ rig, clips: beforeClips(), textures, crossfade: true, poses: seq() }, { rig: after, clips: afterClips(), textures, crossfade: true, poses: seq() }] };
writeFileSync(join(out, "in.json"), JSON.stringify(input));
const run = spawnSync("godot", ["--headless", "--path", GAME_DIR, "--script", "res://tests/rig_pose_probe.gd", "--", join(out, "in.json"), join(out, "out.json")], { encoding: "utf8", timeout: 600_000 });
if (run.status !== 0) throw new Error(run.stderr);
const errors = `${run.stdout}${run.stderr}`.split("\n").filter((l) => /ERROR/.test(l));
if (errors.length) console.warn(errors.slice(0, 5).join("\n"));
const cases = JSON.parse(readFileSync(join(out, "out.json"), "utf8")).cases as { warnings: string[]; poses: Record<string, Layer[] | unknown>[] }[];
for (const c of cases) if (c.warnings.length) console.warn(c.warnings);

// --- draw ------------------------------------------------------------------------------------

function draw(img: Pixels, which: Rig, pose: Record<string, unknown>, ox: number, oy: number): void {
  const parts = which.parts.map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z || a.i - b.i);
  for (const { p } of parts) {
    const tex = atlases.get(p.texture?.file ?? "");
    const layers = pose[p.id] as Layer[] | undefined;
    if (!tex || !layers) continue;
    for (const layer of layers) {
      const pos = layer.points.map(([x, y]) => [x * SCALE + ox, y * SCALE + oy] as Vec);
      const uv = layer.uv.map(([u, v]) => [u * tex.width, v * tex.height] as Vec);
      for (let t = 0; t + 2 < layer.indices.length; t += 3) triangle(img, tex, [pos[layer.indices[t]!]!, pos[layer.indices[t + 1]!]!, pos[layer.indices[t + 2]!]!], [uv[layer.indices[t]!]!, uv[layer.indices[t + 1]!]!, uv[layer.indices[t + 2]!]!]);
    }
  }
}

function triangle(img: Pixels, tex: Pixels, [a, b, c]: Vec[], [ua, ub, uc]: Vec[]): void {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-9) return;
  const sign = area > 0 ? 1 : -1;
  const edge = (p: Vec, q: Vec, x: number, y: number) => sign * ((q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]));
  for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))); y <= Math.min(img.height - 1, Math.ceil(Math.max(a[1], b[1], c[1]))); y++)
    for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))); x <= Math.min(img.width - 1, Math.ceil(Math.max(a[0], b[0], c[0]))); x++) {
      const w0 = edge(b, c, x + 0.5, y + 0.5);
      const w1 = edge(c, a, x + 0.5, y + 0.5);
      const w2 = edge(a, b, x + 0.5, y + 0.5);
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const sum = w0 + w1 + w2;
      const u = (w0 * ua[0] + w1 * ub[0] + w2 * uc[0]) / sum - 0.5;
      const v = (w0 * ua[1] + w1 * ub[1] + w2 * uc[1]) / sum - 0.5;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const px = [0, 0, 0, 0];
      for (const [dx, dy, k] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]] as const) {
        const sx = Math.min(tex.width - 1, Math.max(0, x0 + dx));
        const sy = Math.min(tex.height - 1, Math.max(0, y0 + dy));
        const j = (sy * tex.width + sx) * 4;
        const al = tex.data[j + 3]! / 255;
        for (let ch = 0; ch < 3; ch++) px[ch]! += tex.data[j + ch]! * al * k;
        px[3]! += al * k;
      }
      const alpha = px[3]!;
      if (alpha <= 0.002) continue;
      const i = (y * img.width + x) * 4;
      for (let ch = 0; ch < 3; ch++) img.data[i + ch] = Math.round(px[ch]! + img.data[i + ch]! * (1 - alpha));
    }
}

const frames = cases[0]!.poses.length;
for (let f = 0; f < frames; f++) {
  const img = { width: CELL.width * 2, height: CELL.height, data: new Uint8Array(CELL.width * 2 * CELL.height * 4) } as Pixels;
  const t = f / FPS - IDLE - 1 / FPS; // seconds into the walk (the walk starts on frame IDLE * FPS + 1)
  const travel = Math.max(0, t) * SPEED * SCALE;
  const groundY = 330;
  for (let k = 0; k < 2; k++) {
    const x0 = k * CELL.width;
    for (let y = 0; y < CELL.height; y++)
      for (let x = 0; x < CELL.width; x++) {
        const i = (y * img.width + x0 + x) * 4;
        const ground = y >= groundY;
        const c = ground ? [62, 58, 54] : [206, 203, 196];
        img.data.set([c[0]!, c[1]!, c[2]!, 255], i);
      }
    // Ground marks every 10 rig px, fixed in the world: a planted foot holds still against them.
    for (let gx = 0; gx < CELL.width; gx++) if (Math.round(gx / SCALE) % 10 === 0) for (let y = groundY; y < groundY + 10; y++) img.data.set([150, 146, 140, 255], (y * img.width + x0 + gx) * 4);
    const ox = x0 + 110 + travel;
    draw(img, k === 0 ? rig : after, cases[k]!.poses[f]! as Record<string, unknown>, ox, groundY);
  }
  writeFileSync(join(out, "frames", `${String(f).padStart(4, "0")}.png`), encodePng(img));
}
console.log(`${frames} frames in ${join(out, "frames")}`);
