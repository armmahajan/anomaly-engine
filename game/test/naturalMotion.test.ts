import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Clip, defaultArtDirection, exampleClips, exampleRig, Rig } from "@anomaly/core";
import { bonePoses, decodePng, encodePng, type Pixels } from "@anomaly/art";
import { BrowserRenderer } from "../../packages/server/src/art/renderer.ts";

// Natural motion in the rig runtime (game/scripts/art/rig_view.gd): crossfades between clips,
// two-bone IK, spring bones (follow-through) and per-part look tracks. Headless Godot
// (game/tests/rig_pose_probe.gd) checks the bones; the web export checks the look tracks' pixels.

const GODOT = process.env.GODOT ?? "godot";
const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
const EXPORT_DIR = fileURLToPath(new URL("../../apps/studio/public/game", import.meta.url));
const hasGodot = spawnSync(GODOT, ["--version"], { stdio: "ignore" }).status === 0;
const hasExport = existsSync(join(EXPORT_DIR, "index.html"));

type Bones = Record<string, [number, number, number]>;
type Pose = { clip: string | null; time: number; restart?: boolean; continue?: boolean };
type Case = { rig: unknown; clips?: Record<string, unknown>; poses: Pose[]; crossfade?: boolean; quick?: boolean };

function probe(cases: Case[]): { cases: { warnings: string[]; poses: { bones: Bones }[] }[]; errors: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-motion-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ cases: cases.map((c) => ({ quick: true, ...c })) }));
    const run = spawnSync(GODOT, ["--headless", "--path", GAME_DIR, "--script", "res://tests/rig_pose_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const errors = `${run.stdout}${run.stderr}`.split("\n").filter((line) => /ERROR|SCRIPT ERROR/.test(line));
    if (run.status !== 0) throw new Error(`rig pose probe failed (${run.status}):\n${run.stderr}`);
    return { cases: JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).cases, errors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Poses continuing the playing clip every 1/fps s from `from` (exclusive) to `to`. */
const frames = (clip: string, from: number, to: number, fps: number): Pose[] =>
  Array.from({ length: Math.round((to - from) * fps) }, (_, i) => ({ clip, time: from + (i + 1) / fps, continue: true }));

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

describe.skipIf(!hasGodot)("natural motion (headless Godot)", () => {
  /** An arm on a body: the arm turns 0° in `low`, 90° in `high`. */
  const armRig = Rig.parse({
    bones: [
      { id: "root", parent: null, pivot: [0, 0] },
      { id: "arm", parent: "root", pivot: [0, -20] },
    ],
    parts: [{ id: "arm", bone: "arm", z: 0, fill: "#888888", shape: { type: "stroke", points: [[0, -20], [20, -20]], width: 4 } }],
  });
  const still = (degrees: number, blendIn?: number) =>
    Clip.parse({ duration: 1, loop: true, tracks: [{ bone: "arm", property: "rotate", keys: [[0, degrees], [1, degrees]] }], ...(blendIn !== undefined && { blendIn }) });

  it("crossfades a clip switch over blendIn (the bone moves its per-frame share each frame); blendIn 0 cuts", () => {
    const fps = 60;
    const switching = (blendIn: number): Case => ({
      rig: armRig,
      clips: { low: still(0), high: still(90, blendIn) },
      crossfade: true,
      poses: [{ clip: "low", time: 0 }, ...frames("low", 0, 0.5, fps), { clip: "high", time: 0 }, ...frames("high", 0, 0.4, fps)],
    });
    const { cases, errors } = probe([switching(0.2), switching(0), { ...switching(0.2), crossfade: false }]);
    expect(errors).toEqual([]);
    const angles = (c: (typeof cases)[number]) => c.poses.map((p) => p.bones.arm![2]);
    const switchAt = 1 + 0.5 * fps; // the pose that starts `high`
    const faded = angles(cases[0]!);
    expect(faded[switchAt - 1]).toBeCloseTo(0, 6);
    // Continuous: never more than 90° / (0.2 s * 60 fps) = 7.5° a frame, and there by 0.2 s.
    for (let i = switchAt; i < faded.length; i++) expect(Math.abs(faded[i]! - faded[i - 1]!), `frame ${i}`).toBeLessThanOrEqual(7.5 + 1e-3);
    expect(faded[switchAt + 6]).toBeCloseTo(45, 4);
    expect(faded[switchAt + 12]).toBeCloseTo(90, 4);
    expect(faded.at(-1)).toBeCloseTo(90, 4);
    // blendIn 0, or a view that doesn't crossfade (renders, stages posed by time): a hard cut.
    for (const c of [cases[1]!, cases[2]!]) expect(angles(c)[switchAt]).toBeCloseTo(90, 4);
  }, 90_000);

  /** A leg: pelvis (bobbing), thigh, shin, foot; 20 px thigh and shin, the hip 40 px up. */
  const legRig = Rig.parse({
    bones: [
      { id: "root", parent: null, pivot: [0, 0] },
      { id: "pelvis", parent: "root", pivot: [0, -40] },
      { id: "thigh", parent: "pelvis", pivot: [0, -40] },
      { id: "shin", parent: "thigh", pivot: [0, -20] },
      { id: "foot", parent: "shin", pivot: [0, 0] },
    ],
    parts: [
      { id: "thigh", bone: "thigh", z: 0, fill: "#888888", shape: { type: "stroke", points: [[0, -40], [0, -20]], width: 4 } },
      { id: "shin", bone: "shin", z: 0, fill: "#888888", shape: { type: "stroke", points: [[0, -20], [0, 0]], width: 4 } },
      { id: "foot", bone: "foot", z: 0, fill: "#888888", shape: { type: "stroke", points: [[0, 0], [6, 0]], width: 3 } },
    ],
  });
  const legClips = {
    // The hip bobs down 3..8 px and sways 3 px while the foot stays planted at (4, 0); thigh tracks are overridden.
    plant: Clip.parse({
      duration: 1,
      loop: true,
      tracks: [
        { bone: "pelvis", property: "y", keys: [[0, 3], [0.5, 8], [1, 3]] },
        { bone: "pelvis", property: "x", keys: [[0, -3], [0.5, 3], [1, -3]], ease: "linear" },
        { bone: "thigh", property: "rotate", keys: [[0, 40], [1, -40]] },
      ],
      ik: [{ bone: "shin", tip: "foot", keys: [[0, 4, 0]] }],
    }),
    // A target 50 px from the hip (the leg reaches 40): straight, pointing at it.
    reach: Clip.parse({ duration: 1, loop: false, ik: [{ bone: "shin", tip: "foot", keys: [[0, 30, 0]], bend: "ccw" }] }),
  };

  it("plants a foot with IK while the hip bobs (and matches the TypeScript pose); out of reach the limb is straight", () => {
    const times = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9];
    const { cases, errors } = probe([{ rig: legRig, clips: legClips, poses: [...times.map((time) => ({ clip: "plant", time })), { clip: "reach", time: 0.5 }] }]);
    expect(errors).toEqual([]);
    expect(cases[0]!.warnings).toEqual([]);
    const poses = cases[0]!.poses.map((p) => p.bones);
    times.forEach((time, i) => {
      const b = poses[i]!;
      expect(Math.hypot(b.foot![0] - 4, b.foot![1] - 0), `foot at t ${time}`).toBeLessThan(0.5);
      // cw: the knee in front of the hip-foot line (a right-facing knee).
      const [hx, hy] = b.thigh!;
      const [kx, ky] = b.shin!;
      expect((kx - hx) * (0 - hy) - (ky - hy) * (4 - hx), `knee side at t ${time}`).toBeGreaterThan(0);
      // The foot keeps the angle the clip gave it (here the thigh track's turn) while the shin turns.
      const unsolved = bonePoses(legRig, { ...legClips.plant, ik: [] }, time).get("foot")!;
      expect(Math.abs(wrap(b.foot![2] - (Math.atan2(unsolved[1], unsolved[0]) * 180) / Math.PI))).toBeLessThan(1e-3);
      // The TypeScript pose (art pipeline: grips, limits) is the runtime's.
      const ts = bonePoses(legRig, legClips.plant, time);
      for (const id of ["thigh", "shin", "foot"]) {
        const m = ts.get(id)!;
        expect(Math.hypot(m[4] - b[id]![0], m[5] - b[id]![1]), id).toBeLessThan(1e-3);
        expect(Math.abs(wrap((Math.atan2(m[1], m[0]) * 180) / Math.PI - b[id]![2])), id).toBeLessThan(1e-3);
      }
    });
    const far = poses[times.length]!;
    const hip = far.thigh!;
    const toTarget = Math.atan2(0 - hip[1], 30 - hip[0]);
    for (const [from, to] of [["thigh", "shin"], ["shin", "foot"]] as const) {
      const a = Math.atan2(far[to]![1] - far[from]![1], far[to]![0] - far[from]![0]);
      expect(Math.abs(wrap(((a - toTarget) * 180) / Math.PI)), `${from} points at the target`).toBeLessThan(0.01);
    }
    expect(Math.hypot(far.foot![0] - hip[0], far.foot![1] - hip[1])).toBeCloseTo(40, 3);
  }, 90_000);

  /** A body that turns 30° in 0.3 s and stops, carrying a lock of hair on a spring. */
  const hairRig = (spring?: { stiffness: number; damping: number }) =>
    Rig.parse({
      bones: [
        { id: "root", parent: null, pivot: [0, 0] },
        { id: "body", parent: "root", pivot: [0, -20] },
        { id: "hair", parent: "body", pivot: [0, -40], ...(spring && { spring }) },
      ],
      parts: [
        { id: "body", bone: "body", z: 0, fill: "#888888", shape: { type: "blob", points: [[-8, -40], [8, -40], [8, -20], [-8, -20]], smooth: 0 } },
        { id: "hair", bone: "hair", z: 1, fill: "#442211", shape: { type: "stroke", points: [[0, -40], [-12, -44], [-24, -42]], width: 5, widthEnd: 1 } },
      ],
    });
  const turn = Clip.parse({ duration: 3, loop: false, tracks: [{ bone: "body", property: "rotate", keys: [[0, 0], [0.1, 30], [1, 30]] }] });

  it("springs lag, overshoot and settle after the parent stops, the same at 30 and 60 fps and on every run; rest is unaffected", () => {
    const spring = { stiffness: 0.3, damping: 0.3 };
    const run = (fps: number): Case => ({ rig: hairRig(spring), clips: { turn }, poses: [{ clip: "turn", time: 0 }, ...frames("turn", 0, 3, fps)] });
    const { cases, errors } = probe([run(60), run(30), run(60), { rig: hairRig(spring), poses: [{ clip: null, time: 0 }] }, { rig: hairRig(), poses: [{ clip: null, time: 0 }] }]);
    expect(errors).toEqual([]);
    // The hair's turn relative to the body (0 = rigid), every 1/fps s from 0.
    const lag = (c: (typeof cases)[number]) => c.poses.map((p) => wrap(p.bones.hair![2] - p.bones.body![2]));
    const at60 = lag(cases[0]!);
    const at30 = lag(cases[1]!);
    // Lags behind the turn (the body turns clockwise, +), then swings past and settles.
    expect(Math.min(...at60.slice(0, 20))).toBeLessThan(-5);
    expect(Math.max(...at60.slice(20, 90))).toBeGreaterThan(2);
    const crossings = at60.slice(20).filter((v, i, a) => i > 0 && Math.sign(v) !== Math.sign(a[i - 1]!) && Math.abs(v - a[i - 1]!) > 0.01).length;
    expect(crossings).toBeGreaterThanOrEqual(2);
    expect(Math.max(...at60.slice(150).map(Math.abs))).toBeLessThan(1);
    expect(Math.abs(at60.at(-1)!)).toBeLessThan(0.05);
    // Frame-rate independent: the 30 fps run passes the same angles (within 1°).
    at30.forEach((v, i) => expect(Math.abs(v - at60[2 * i]!), `t ${i / 30}`).toBeLessThan(1));
    // Deterministic.
    expect(lag(cases[2]!)).toEqual(at60);
    // Rest renders: a spring rig at rest is the rig without springs.
    expect(cases[3]!.poses[0]!.bones).toEqual(cases[4]!.poses[0]!.bones);
  }, 90_000);

  it("damps more with more damping, and stays stable on violent motion", () => {
    const shake = Clip.parse({ duration: 1, loop: true, tracks: [{ bone: "body", property: "rotate", keys: [[0, 0], [0.25, 170], [0.5, -170], [0.75, 170], [1, 0]], ease: "linear" }], motions: [{ type: "shake", bone: "body", amount: 40 }] });
    const run = (damping: number): Case => ({ rig: hairRig({ stiffness: 0.3, damping }), clips: { turn, shake }, poses: [{ clip: "turn", time: 0 }, ...frames("turn", 0, 1.5, 60)] });
    const wild: Case = { rig: hairRig({ stiffness: 0.05, damping: 0 }), clips: { shake }, poses: [{ clip: "shake", time: 0 }, ...frames("shake", 0, 2, 60)] };
    const { cases, errors } = probe([run(0.1), run(0.9), wild]);
    expect(errors).toEqual([]);
    const lag = (c: (typeof cases)[number]) => c.poses.map((p) => wrap(p.bones.hair![2] - p.bones.body![2]));
    const late = (c: (typeof cases)[number]) => Math.max(...lag(c).slice(40).map(Math.abs));
    expect(late(cases[1]!)).toBeLessThan(late(cases[0]!));
    // Clamped: never past 75° from where the clip puts it, never NaN.
    for (const v of lag(cases[2]!)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(75 + 1e-3);
    }
  }, 90_000);

  it("plays clips without the new fields exactly as the TypeScript pose says (no crossfade in probes)", () => {
    const clips = exampleClips();
    const times = [0, 0.25, 0.6, 0.9];
    const poses = Object.keys(clips).flatMap((clip) => times.map((time) => ({ clip, time })));
    const { cases, errors } = probe([{ rig: exampleRig(), clips, poses }]);
    expect(errors).toEqual([]);
    poses.forEach((p, i) => {
      const clip = clips[p.clip]!;
      const t = clip.loop ? (p.time % clip.duration) / clip.duration : Math.min(p.time / clip.duration, 1);
      const ts = bonePoses(exampleRig(), clip, t);
      for (const [id, [x, y, deg]] of Object.entries(cases[0]!.poses[i]!.bones)) {
        // Shake is random per frame in the runtime (the TypeScript side takes its peak): skip its bones' offsets.
        if (clip.motions.some((m) => m.type === "shake")) continue;
        const m = ts.get(id)!;
        expect(Math.hypot(m[4] - x, m[5] - y), `${p.clip}@${p.time} ${id}`).toBeLessThan(1e-3);
        expect(Math.abs(wrap((Math.atan2(m[1], m[0]) * 180) / Math.PI - deg))).toBeLessThan(1e-3);
      }
    });
  }, 90_000);
});

const FILE = "0123456789abcdef0123456789abcdef.png";

/** A 64x64 texture: red top-left, green top-right, blue bottom-left, yellow bottom-right. */
function quadrants(): Pixels {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = colors[(y < 32 ? 0 : 2) + (x < 32 ? 0 : 1)]!;
      data.set([c[0]!, c[1]!, c[2]!, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data } as Pixels;
}

describe.skipIf(!hasGodot || !hasExport || process.env.SKIP_BROWSER_TESTS === "1")("look tracks in the runtime (web export)", () => {
  const renderer = new BrowserRenderer(EXPORT_DIR);
  afterAll(() => renderer.close());

  // A grey vector square (rig 10..30, no outline) and a textured mesh square (rig 50..70), on one bone.
  const rig = Rig.parse({
    mode: "layered",
    bones: [{ id: "root", parent: null, pivot: [40, 40] }],
    parts: [
      { id: "box", bone: "root", z: 0, fill: "#808080", ink: 0, shape: { type: "blob", points: [[10, 30], [30, 30], [30, 50], [10, 50]], smooth: 0 } },
      {
        id: "tile",
        bone: "root",
        z: 1,
        fill: "#888888",
        texture: { file: FILE, rect: [50, 30, 20, 20], uv: [0, 0, 64, 64] },
        shape: { type: "mesh", points: [[50, 30], [70, 30], [70, 50], [50, 50]], inner: [], triangles: [0, 1, 2, 0, 2, 3], uv: [[0, 0], [64, 0], [64, 64], [0, 64]] },
      },
    ],
  });
  const look = (looks: unknown[]) => Clip.parse({ duration: 1, loop: false, looks });
  const clips = {
    fade: look([{ part: "box", property: "opacity", keys: [[0, 0.25]] }, { part: "tile", property: "opacity", keys: [[0, 0.25]] }]),
    bright: look([{ property: "brightness", keys: [[0, 1.8]] }]),
    tint: look([{ property: "tint", color: "#ff00ff", keys: [[0, 0], [1, 1]], ease: "linear" }]),
    glow: look([{ part: "box", property: "glow", color: "#00ffff", keys: [[0, 1]] }, { part: "tile", property: "glow", color: "#ffffff", keys: [[0, 1]] }]),
  };

  it("fades, brightens and tints a part's pixels (vector and mesh), and glows a halo around it", async () => {
    const image = await renderer.renderRig({
      rig,
      direction: defaultArtDirection(),
      clips,
      frames: [{ clip: null, time: 0 }, { clip: "fade", time: 0 }, { clip: "bright", time: 0 }, { clip: "tint", time: 1 }, { clip: "glow", time: 0 }, { clip: "tint", time: 0 }],
      cellWidth: 80,
      cellHeight: 80,
      columns: 6,
      background: "#000000",
      fit: false,
      images: { [FILE]: encodePng(quadrants()).toString("base64") },
    });
    expect(image.warnings).toEqual([]);
    if (process.env.LOOK_SHOT) writeFileSync(process.env.LOOK_SHOT, image.png);
    const png = decodePng(image.png);
    const at = (frame: number, x: number, y: number) => {
      const i = (y * png.width + frame * 80 + x) * 4;
      return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
    };
    const near = (got: number[], want: number[], by = 30) => got.every((v, i) => Math.abs(v - want[i]!) <= by);
    const box: [number, number] = [20, 40];
    const blue: [number, number] = [54, 46]; // the tile's bottom-left (blue) quadrant
    const outside: [number, number] = [40, 40];
    const nearBox: [number, number] = [32, 40];
    // Rest.
    expect(near(at(0, ...box), [128, 128, 128]), `${at(0, ...box)}`).toBe(true);
    expect(near(at(0, ...blue), [0, 0, 255]), `${at(0, ...blue)}`).toBe(true);
    expect(at(0, ...nearBox)).toEqual([0, 0, 0]);
    // Opacity 0.25 over black.
    expect(near(at(1, ...box), [32, 32, 32]), `${at(1, ...box)}`).toBe(true);
    expect(near(at(1, ...blue), [0, 0, 64]), `${at(1, ...blue)}`).toBe(true);
    // Brightness 1.8 (the whole rig).
    expect(near(at(2, ...box), [230, 230, 230]), `${at(2, ...box)}`).toBe(true);
    expect(near(at(2, ...blue), [0, 0, 255]), `${at(2, ...blue)}`).toBe(true);
    // Tint 1 toward magenta: both parts are magenta; tint 0 (its first key) is the rest.
    expect(near(at(3, ...box), [255, 0, 255]), `${at(3, ...box)}`).toBe(true);
    expect(near(at(3, ...blue), [255, 0, 255]), `${at(3, ...blue)}`).toBe(true);
    expect(near(at(5, ...blue), [0, 0, 255]), `${at(5, ...blue)}`).toBe(true);
    // Glow: a cyan halo just outside the box, a white one outside the tile; the parts themselves as at rest.
    const halo = at(4, ...nearBox);
    expect(halo[1]! > 20 && halo[2]! > 20 && halo[0]! < halo[1]!, `${halo}`).toBe(true);
    const tileHalo = at(4, 47, 40);
    expect(Math.min(...tileHalo) > 15 && Math.max(...tileHalo) - Math.min(...tileHalo) < 12, `white halo ${tileHalo}`).toBe(true);
    expect(near(at(4, ...box), [128, 128, 128], 40), `${at(4, ...box)}`).toBe(true);
    expect(at(4, ...outside)[0]).toBeLessThan(at(4, 47, 40)[0]!);
  }, 120_000);
});
