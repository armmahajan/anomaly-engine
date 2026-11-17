import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { borderedGrid, createDefaultProject, fillTiles, PLANE_RECIPE, planeScreenScale, REFERENCE_SCREEN, toRuntimeProject, TILE, type TileGrid } from "@anomaly/core";
import { FPS, playtestRoom } from "./simulate.ts";

// The play camera and depth in the real runtime (headless): a fixed zoom from world.camera.rows,
// following the player on both axes, clamped to the room (small rooms centred); background planes
// sized to the view with parallax on both axes; particles at several depths.

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
/** Headless Godot's window: the project's 960x540. */
const VIEW = { width: 960, height: 540 };
const ROWS = 14;
const ZOOM = VIEW.height / (ROWS * TILE);
const VIEW_W = VIEW.width / ZOOM;
const VIEW_H = ROWS * TILE;

type Plane = { name: string; x: number; y: number; height: number; blurred: boolean };
type Sample = {
  frame: number;
  camera: { x: number; y: number; zoom: number } | null;
  entities: { characterId: string; x: number; y: number }[];
  view: { planes: Plane[]; layers: Record<string, { x: number; y: number }>; particles: { layer: string; amount: number }[]; screen: [number, number] } | null;
  scales: Record<string, number>;
};

const PLANE_SIZE = { width: 1260, height: 1024 };
const planes = PLANE_RECIPE.map(({ transparent: _t, prompt: _p, ...p }) => ({ ...p, file: `${p.name}.png`, ...PLANE_SIZE }));

/** A dressed room `grid` with the player at `at`: layered kit (or the old single backdrop). */
function scenario(grid: TileGrid, at: { x: number; y: number }, options: { legacy?: boolean; frames?: number; samples?: number[]; input?: { action: string; from: number; to: number }[]; edit?: boolean; rows?: number } = {}) {
  const base = createDefaultProject();
  const project = playtestRoom(base, grid, at);
  const sent = toRuntimeProject(project);
  if (options.rows) sent.world.camera = { rows: options.rows };
  sent.world.rooms[0]!.dressing = { biome: "cave", room: "hall" };
  (sent.art.assets as unknown[]).push({
    id: "cave",
    kind: "biome",
    kit: options.legacy
      ? { backdrop: "backdrop.png", ground: "ground.png", pieces: [] }
      : { backdrop: "sky.png", backgrounds: planes, atmosphere: { particles: "embers" }, ground: "ground.png", pieces: [] },
    rooms: [
      {
        id: "hall",
        name: "Hall",
        composition: {
          palette: { ambient: "#8090a0", fog: "#33465a", light: "#ffd9a0", shadow: "#05070a" },
          placements: [],
          lights: [],
          fog: { mid: 0.3, back: 0.2, play: 0.1 },
          rays: [],
          dust: { color: "#ffb070", amount: 120 },
        },
      },
    ],
  });
  const textures: Record<string, [number, number]> = { "ground.png": [256, 256] };
  if (options.legacy) textures["backdrop.png"] = [PLANE_SIZE.width, PLANE_SIZE.height];
  else for (const p of planes) textures[p.file] = [PLANE_SIZE.width, PLANE_SIZE.height];
  return { project: sent, frames: options.frames ?? 2, samples: options.samples ?? [2], input: options.input ?? [], textures, edit: options.edit ?? false };
}

function probe(scenarios: ReturnType<typeof scenario>[]): Sample[][] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-view-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ windowHeight: REFERENCE_SCREEN.height, scenarios }));
    execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://tests/view_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], {
      stdio: "pipe",
      timeout: 120_000,
    });
    const { results } = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: { error: string; samples: Sample[] }[] };
    return results.map((r, i) => {
      if (r.error) throw new Error(`scenario ${i}: ${r.error}`);
      return r.samples;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 90 x 42 tiles (about 3.6 views wide, 3 tall): a floor, and a high shelf on the right. */
const BIG = fillTiles(borderedGrid(90, 42), { col: 60, row: 10, cols: 28, rows: 1 }, "solid");
const BIG_W = 90 * TILE;
const BIG_H = 42 * TILE;
const FLOOR = (42 - 1) * TILE;
const SHELF = 10 * TILE;

describe("play camera and parallax", () => {
  let low: Sample[];
  let high: Sample[];
  let fall: Sample[];
  let small: Sample[];
  let screen: Sample[];
  let legacy: Sample[];
  let edit: Sample[];

  beforeAll(() => {
    const run = [{ action: "move_right", from: 5, to: 200 }];
    [low, high, fall, small, screen, legacy, edit] = probe([
      scenario(BIG, { x: 200, y: FLOOR }, { frames: 200, samples: [2, 200], input: run }),
      scenario(BIG, { x: 2700, y: SHELF }, { frames: 20, samples: [20] }),
      // Off the shelf's left end and down to the floor.
      scenario(BIG, { x: 1960, y: SHELF }, { frames: 160, samples: [2, 160], input: [{ action: "move_left", from: 2, to: 30 }] }),
      scenario(borderedGrid(12, 10), { x: 192, y: 9 * TILE }),
      scenario(borderedGrid(30, 14), { x: 120, y: 13 * TILE }),
      scenario(borderedGrid(30, 14), { x: 120, y: 13 * TILE }, { legacy: true }),
      scenario(BIG, { x: 200, y: FLOOR }, { edit: true }),
    ]) as [Sample[], Sample[], Sample[], Sample[], Sample[], Sample[], Sample[]];
  }, 180_000);

  it("zooms so world.camera.rows tiles fill the view's height", () => {
    expect(low[0]!.camera!.zoom).toBeCloseTo(ZOOM, 4);
    expect(low[0]!.view!.screen).toEqual([VIEW.width, VIEW.height]);
  });

  it("follows the player on both axes in a room bigger than the view, clamped to it", () => {
    const [start, end] = low;
    // bottom-left corner of the room
    expect(start!.camera!.x).toBeCloseTo(VIEW_W / 2, 0);
    expect(start!.camera!.y).toBeCloseTo(BIG_H - VIEW_H / 2, 0);
    // ran right: the camera follows (with look-ahead, so the player is left of centre)
    const player = end!.entities.find((e) => e.characterId === "player")!;
    expect(end!.camera!.x).toBeGreaterThan(start!.camera!.x + 600);
    expect(end!.camera!.x).toBeGreaterThan(player.x);
    expect(end!.camera!.x).toBeLessThanOrEqual(BIG_W - VIEW_W / 2 + 1e-3);
    // high up on the shelf, at the right edge
    expect(high[0]!.camera!.x).toBeCloseTo(BIG_W - VIEW_W / 2, 0);
    expect(high[0]!.camera!.y).toBeLessThan(SHELF);
    expect(high[0]!.camera!.y).toBeGreaterThanOrEqual(VIEW_H / 2 - 1e-3);
    // dropping off the shelf, the camera comes down with the player
    expect(fall[1]!.camera!.y).toBeGreaterThan(fall[0]!.camera!.y + 500);
  });

  it("centres a room smaller than the view; a 30x14 room fills its height", () => {
    expect(small[0]!.camera).toMatchObject({ x: 6 * TILE, y: 5 * TILE });
    expect(screen[0]!.camera!.y).toBeCloseTo(7 * TILE, 3);
    expect(screen[0]!.camera!.x).toBeCloseTo(VIEW_W / 2, 0);
  });

  it("offsets every layer against the camera on both axes by its depth", () => {
    const a = low[1]!.view!;
    const b = high[0]!.view!;
    const ca = low[1]!.camera!;
    const cb = high[0]!.camera!;
    const dx = cb.x - ca.x;
    const dy = cb.y - ca.y;
    expect(Math.abs(dy)).toBeGreaterThan(500);
    // Placed layers: x and y offsets follow the camera by (1 - factor); play doesn't move, front keeps to the view vertically.
    for (const [layer, f] of [["mid", 0.38], ["back", 0.72], ["play", 1]] as const) {
      expect(b.layers[layer]!.x - a.layers[layer]!.x).toBeCloseTo(dx * (1 - f), 1);
      expect(b.layers[layer]!.y - a.layers[layer]!.y).toBeCloseTo(dy * (1 - f), 1);
    }
    expect(b.layers.front!.y - a.layers.front!.y).toBeCloseTo(dy, 1);
    // Planes (screen px): scroll by depth x the camera's move; climbing, they sink (the sky only as far as its headroom).
    for (const plane of planes) {
      const pa = a.planes.find((p) => p.name === plane.name)!;
      const pb = b.planes.find((p) => p.name === plane.name)!;
      expect(pb.x - pa.x).toBeCloseTo(plane.depth * dx * ZOOM, 0);
      const sink = pb.y - pa.y;
      if (plane.opaque) expect(sink).toBeCloseTo(Math.min(plane.depth * -dy * ZOOM, (plane.span - 1) * VIEW.height), 0);
      else expect(sink).toBeCloseTo(plane.depth * -dy * ZOOM, 0);
    }
    // deeper planes move less
    const moved = planes.map((p) => b.planes.find((q) => q.name === p.name)!.x - a.planes.find((q) => q.name === p.name)!.x);
    expect(moved[0]!).toBeLessThan(moved[1]!);
    expect(moved[1]!).toBeLessThan(moved[2]!);
  });

  it("draws the planes at the size core planeScreenScale predicts on a 3024x1890 screen, distant ones blurred", () => {
    const view = screen[0]!.view!;
    for (const plane of planes) {
      expect(screen[0]!.scales[plane.name]).toBeCloseTo(planeScreenScale(plane, REFERENCE_SCREEN.height), 3);
      const drawn = view.planes.find((p) => p.name === plane.name)!;
      expect(drawn.height).toBeCloseTo(plane.span * VIEW.height, 1);
      expect(drawn.blurred).toBe(plane.blur > 0);
      // standing on the view's bottom edge (a 14-row room never moves the camera vertically)
      expect(drawn.y + drawn.height).toBeCloseTo(VIEW.height, 1);
    }
    expect(view.planes.filter((p) => p.blurred).map((p) => p.name)).toEqual(["sky", "far"]);
  });

  it("draws an old kit's single backdrop as before: one sharp plane, the view's height", () => {
    const view = legacy[0]!.view!;
    expect(view.planes).toEqual([expect.objectContaining({ name: "backdrop", blurred: false, height: VIEW.height, y: 0 })]);
  });

  it("puts particles at several depths, some in front of the play layer", () => {
    const layers = low[0]!.view!.particles.map((p) => p.layer);
    expect(layers).toEqual(["mid", "back", "play", "front"]);
    expect(low[0]!.view!.particles.reduce((n, p) => n + p.amount, 0)).toBeGreaterThan(100);
  });

  it("edit mode keeps fitting the whole room", () => {
    const camera = edit[0]!.camera!;
    expect(camera.x).toBeCloseTo(BIG_W / 2, 0);
    expect(camera.y).toBeCloseTo(BIG_H / 2, 0);
    expect(camera.zoom).toBeLessThan(ZOOM);
  });
});
