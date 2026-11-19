import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Clip, defaultArtDirection, exampleClips, exampleRig, Rig } from "@anomaly/core";
import { decodePng, encodePng, type Pixels } from "@anomaly/art";
import { BrowserRenderer } from "../../packages/server/src/art/renderer.ts";

// The rig renderer (game/scripts/art/rig_view.gd) draws every part from triangles computed once at
// rest, so a pose that folds or collapses a part never fails triangulation; mesh parts (layered
// rigs) bring their own triangles and show their texture, bending toward bendTo by their weights.
// Headless Godot (game/tests/rig_pose_probe.gd) checks the posed geometry and that no Godot ERROR
// is printed; the web export in headless Chromium checks the pixels.

const GODOT = process.env.GODOT ?? "godot";
const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
const EXPORT_DIR = fileURLToPath(new URL("../../apps/studio/public/game", import.meta.url));
const hasGodot = spawnSync(GODOT, ["--version"], { stdio: "ignore" }).status === 0;
const hasExport = existsSync(join(EXPORT_DIR, "index.html"));

type Vec = [number, number];
type Layer = { points: Vec[]; indices: number[]; uv: Vec[] };
type Probed = { warnings: string[]; poses: Record<string, Layer[]>[] };
type Case = { rig: unknown; clips?: Record<string, unknown>; direction?: unknown; textures?: Record<string, [number, number]>; poses: { clip: string | null; time: number }[] };

/** Run the probe; returns its cases and every Godot error line it printed. */
function probe(cases: Case[]): { cases: Probed[]; errors: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-rigpose-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ cases }));
    const run = spawnSync(GODOT, ["--headless", "--path", GAME_DIR, "--script", "res://tests/rig_pose_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const errors = `${run.stdout}${run.stderr}`.split("\n").filter((line) => /ERROR/.test(line));
    if (run.status !== 0) throw new Error(`rig pose probe failed (${run.status}):\n${run.stderr}`);
    return { cases: (JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { cases: Probed[] }).cases, errors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FILE = "0123456789abcdef0123456789abcdef.png";
const BLACK = "#000000";

/**
 * A layered rig: one mesh part, a 40x40 square at rig [10..50] (origin top-left of the render,
 * fit off) on bone `low` (pivot at its bottom middle), bending toward `top` (pivot at its centre):
 * outline TL TR BR BL, one inner vertex in the middle; weights 1 at the top, 0.5 in the middle, 0
 * at the bottom. Its uv is the middle 32x32 of a 64x64 texture (quadrants red, green, blue, yellow).
 */
function meshRig(weights = true): Rig {
  return Rig.parse({
    mode: "layered",
    bones: [
      { id: "low", parent: null, pivot: [30, 50] },
      { id: "top", parent: "low", pivot: [30, 30] },
    ],
    parts: [
      {
        id: "layer",
        bone: "low",
        bendTo: "top",
        z: 0,
        fill: "#888888",
        texture: { file: FILE, rect: [10, 10, 40, 40], uv: [16, 16, 32, 32] },
        shape: {
          type: "mesh",
          points: [[10, 10], [50, 10], [50, 50], [10, 50]],
          inner: [[30, 30]],
          triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
          uv: [[16, 16], [48, 16], [48, 48], [16, 48], [32, 32]],
          ...(weights ? { weights: [1, 1, 0, 0, 0.5] } : {}),
        },
      },
    ],
  });
}
/** The top bone slides 20 px right. */
const SLIDE = Clip.parse({ duration: 1, loop: false, tracks: [{ bone: "top", property: "x", keys: [[0, 20], [1, 20]], ease: "linear" }] });

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

describe.skipIf(!hasGodot)("rig renderer geometry (headless Godot)", () => {
  it("draws a mesh part on its own triangles and uv, bending by its weights (or by position without)", () => {
    const { cases, errors } = probe([
      { rig: meshRig(), clips: { slide: SLIDE }, textures: { [FILE]: [64, 64] }, poses: [{ clip: null, time: 0 }, { clip: "slide", time: 1 }] },
      { rig: meshRig(false), clips: { slide: SLIDE }, textures: { [FILE]: [64, 64] }, poses: [{ clip: "slide", time: 1 }] },
    ]);
    expect(errors).toEqual([]);
    const [weighted, projected] = cases;
    expect(weighted!.warnings).toEqual([]);
    const [rest, bent] = weighted!.poses.map((p) => p.layer!);
    expect(rest).toHaveLength(1);
    expect(rest![0]!.indices).toEqual([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]);
    expect(rest![0]!.points).toEqual([[10, 10], [50, 10], [50, 50], [10, 50], [30, 30]]);
    // uv were normalized to the 64 px texture once it was found.
    expect(rest![0]!.uv).toEqual([[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75], [0.5, 0.5]]);
    // Weight 1 follows the top bone (+20), 0 stays with the low bone, 0.5 goes half way.
    expect(bent![0]!.points).toEqual([[30, 10], [70, 10], [50, 50], [10, 50], [40, 30]]);
    // Without weights: by position along low -> top (pivots y 50 -> 30): the top row (past the top pivot) 1, the middle 1, the bottom 0.
    expect(projected!.poses[0]!.layer![0]!.points).toEqual([[30, 10], [70, 10], [50, 50], [10, 50], [50, 30]]);
  }, 90_000);

  it("bends a part by turning it about the joint (the outside of a 90° bend keeps its distance from the joint)", () => {
    // A bar along x on bone `fore` (pivot at the joint, x 20), bending toward its parent `upper`: weight 0.5 at the joint's column.
    const rig = Rig.parse({
      mode: "layered",
      bones: [
        { id: "upper", parent: null, pivot: [0, 0] },
        { id: "fore", parent: "upper", pivot: [20, 0] },
      ],
      parts: [
        {
          id: "bar",
          bone: "fore",
          bendTo: "upper",
          z: 0,
          fill: "#888888",
          texture: { file: FILE, rect: [10, -5, 30, 10], uv: [0, 0, 64, 64] },
          shape: { type: "mesh", points: [[10, -5], [20, -5], [40, -5], [40, 5], [20, 5], [10, 5]], inner: [], triangles: [0, 1, 4, 0, 4, 5, 1, 2, 3, 1, 3, 4], uv: [[0, 0], [21, 0], [64, 0], [64, 64], [21, 64], [0, 64]], weights: [1, 0.5, 0, 0, 0.5, 1] },
        },
      ],
    });
    const bend = Clip.parse({ duration: 1, loop: false, tracks: [{ bone: "fore", property: "rotate", keys: [[0, 90], [1, 90]], ease: "linear" }] });
    const { cases, errors } = probe([{ rig, clips: { bend }, textures: { [FILE]: [64, 64] }, poses: [{ clip: "bend", time: 0 }] }]);
    expect(errors).toEqual([]);
    const points = cases[0]!.poses[0]!.bar![0]!.points;
    // The joint's column (weight 0.5) turns 45°: both its edge points stay 5 px from the joint (a blend of positions would pull them to 3.5).
    for (const i of [1, 4]) expect(Math.hypot(points[i]![0] - 20, points[i]![1]) / 5).toBeCloseTo(1, 1);
    expect(Math.abs(Math.hypot(points[1]![0] - 20, points[1]![1]) - 5)).toBeLessThan(0.1);
    // Weight 0 follows `fore` turned 90° (clockwise on screen) about the joint; weight 1 stays with `upper`.
    expect(points[2]![0]).toBeCloseTo(25, 3);
    expect(points[2]![1]).toBeCloseTo(20, 3);
    expect(points[0]).toEqual([10, -5]);
  }, 90_000);

  it("draws folded and collapsed vector parts with no triangulation errors, from their rest triangles", () => {
    const rig = Rig.parse({
      bones: [
        { id: "root", parent: null, pivot: [0, 0] },
        { id: "arm", parent: "root", pivot: [0, -20] },
        { id: "gone", parent: "root", pivot: [20, -10] },
      ],
      parts: [
        // A cloak bending root -> arm: turning the arm 180° folds its top over its bottom (a bow tie).
        { id: "cloak", bone: "root", bendTo: "arm", z: 0, fill: "#aa3344", shade: { color: "#220011" }, shape: { type: "blob", points: [[-10, -30], [10, -30], [10, 0], [-10, 0]], smooth: 0 } },
        { id: "tail", bone: "root", bendTo: "arm", z: 1, fill: "#ddcc22", shape: { type: "stroke", points: [[0, 0], [0, -15], [0, -35]], width: 6, widthEnd: 2 } },
        // Parts on a bone scaled to 0 (and one squashed flat): everything collapses to a point or a line.
        { id: "eye", bone: "gone", z: 2, fill: "#ffffff", glow: true, shape: { type: "ellipse", center: [20, -10], rx: 4, ry: 3 } },
        { id: "flat", bone: "gone", z: 3, fill: "#00ffaa", shape: { type: "blob", points: [[15, -15], [25, -15], [25, -5], [15, -5]] } },
      ],
    });
    const clips = {
      fold: Clip.parse({ duration: 1, loop: false, tracks: [{ bone: "arm", property: "rotate", keys: [[0, 0], [1, 180]], ease: "linear" }] }),
      vanish: Clip.parse({ duration: 1, loop: false, tracks: [{ bone: "gone", property: "scaleX", keys: [[0, 1], [1, 0]] }, { bone: "gone", property: "scaleY", keys: [[0, 1], [0.5, 0]] }] }),
    };
    const poses = [0, 0.5, 0.75, 1].flatMap((time) => [{ clip: "fold", time }, { clip: "vanish", time }]);
    const { cases, errors } = probe([{ rig, clips, direction: defaultArtDirection(), poses }]);
    expect(errors).toEqual([]);
    expect(cases[0]!.warnings).toEqual([]);
    const folded = cases[0]!.poses[poses.findIndex((p) => p.clip === "fold" && p.time === 1)]!;
    // The folded cloak and tail are still drawn (what isn't degenerate covers area), with the same triangles as at rest.
    for (const id of ["cloak", "tail"]) {
      const layers = folded[id]!;
      expect(layers.length).toBeGreaterThan(0);
      expect(layers.map((l) => l.indices)).toEqual(cases[0]!.poses[0]![id]!.map((l) => l.indices));
      expect(layers.reduce((sum, l) => sum + area(l), 0)).toBeGreaterThan(20);
    }
  }, 90_000);

  it("draws the example rig through every clip with no errors", () => {
    const clips = exampleClips();
    const poses = Object.keys(clips).flatMap((clip) => [0, 0.3, 0.6, 0.9].map((time) => ({ clip, time })));
    const { cases, errors } = probe([{ rig: exampleRig(), clips, direction: defaultArtDirection(), poses }]);
    expect(errors).toEqual([]);
    expect(cases[0]!.warnings).toEqual([]);
    for (const part of exampleRig().parts) expect(cases[0]!.poses[0]![part.id]!.length, part.id).toBeGreaterThan(0);
  }, 90_000);
});

/** Area covered by a layer's triangles (each counted unsigned). */
function area(layer: Layer): number {
  let sum = 0;
  for (let i = 0; i + 2 < layer.indices.length; i += 3) {
    const [a, b, c] = [layer.points[layer.indices[i]!]!, layer.points[layer.indices[i + 1]!]!, layer.points[layer.indices[i + 2]!]!];
    sum += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  return sum;
}

describe.skipIf(!hasGodot || !hasExport || process.env.SKIP_BROWSER_TESTS === "1")("mesh parts in the runtime (web export)", () => {
  const renderer = new BrowserRenderer(EXPORT_DIR);
  afterAll(() => renderer.close());

  it("shows the texture where uv says at rest, and moves its far side with bendTo", async () => {
    const image = await renderer.renderRig({
      rig: meshRig(),
      direction: defaultArtDirection(),
      clips: { slide: SLIDE },
      frames: [{ clip: null, time: 0 }, { clip: "slide", time: 1 }],
      cellWidth: 96,
      cellHeight: 64,
      columns: 2,
      background: BLACK,
      fit: false,
      images: { [FILE]: encodePng(quadrants()).toString("base64") },
    });
    expect(image.warnings).toEqual([]);
    const png = decodePng(image.png);
    const at = (frame: number, x: number, y: number) => {
      const i = (y * png.width + frame * 96 + x) * 4;
      return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
    };
    const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]!) <= 40);
    const [RED, GREEN, BLUE, YELLOW, NONE] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 0, 0]];
    // Rest: rig (x, y) shows texture px 16 + (x - 10) * 0.8: its quadrants split at rig 30.
    const rest: [number, number, number[]][] = [[16, 16, RED], [44, 16, GREEN], [16, 44, BLUE], [44, 44, YELLOW], [24, 24, RED], [36, 36, YELLOW], [5, 5, NONE], [55, 30, NONE]];
    for (const [x, y, want] of rest) expect(near(at(0, x, y), want), `rest ${x},${y}: ${at(0, x, y)}`).toBe(true);
    // Bent: the top edge (weight 1) slid 20 px right with the top bone; the bottom (weight 0) stayed.
    const bent: [number, number, number[]][] = [[15, 12, NONE], [36, 12, RED], [62, 12, GREEN], [16, 47, BLUE], [44, 47, YELLOW]];
    for (const [x, y, want] of bent) expect(near(at(1, x, y), want), `bent ${x},${y}: ${at(1, x, y)}`).toBe(true);
  }, 120_000);
});
