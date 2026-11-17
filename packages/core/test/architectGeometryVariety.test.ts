import { describe, expect, it } from "vitest";
import { buildRoom, createDefaultProject, gridToSolids, movementParams, standingSurfaces, gridSize, type PlayerCharacter, type RoomRequest, type TileGrid } from "../src/index.ts";

/** How the terrain knobs and the seed change rooms (measured over seeds). */

const base = createDefaultProject();
const params = movementParams(base.characters[0] as PlayerCharacter, base.world.gravity);
const KNOBS = { verticality: 0.3, hazards: 0.2, density: 0.5, open: 0.3 };

function room(seed: number, terrain: Partial<typeof KNOBS> = {}, extra: Partial<RoomRequest> = {}): TileGrid {
  const req: RoomRequest = {
    cols: 48,
    rows: 30,
    seed,
    terrain: { ...KNOBS, ...terrain },
    fight: false,
    doors: [
      { id: "w", side: "left", gate: [], flow: "both" },
      { id: "e", side: "right", gate: [], flow: "both" },
    ],
    ...extra,
  };
  const out = buildRoom(req, params);
  expect(out.proof?.ok, out.proof?.problems.join("; ")).toBe(true);
  return out.built!.grid;
}

const count = (grid: TileGrid, ch: string) => grid.rows.reduce((n, r) => n + r.split(ch).length - 1, 0);
const surfaces = (grid: TileGrid) => standingSurfaces(gridToSolids(grid), params, gridSize(grid));
const stdev = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
/** Distinct standing heights, and their spread (tiles). */
const heights = (grid: TileGrid) => surfaces(grid).map((s) => s.y / 32);
/** The longest flat run of floor with nothing standable low over it (tiles). */
function widestFloor(grid: TileGrid): number {
  return Math.max(...surfaces(grid).map((s) => (s.x1 - s.x0 + params.width) / 32));
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const SEEDS = Array.from({ length: 12 }, (_, i) => 1000 + i * 37);

describe("room variety", () => {
  it("differs by seed", () => {
    const grids = SEEDS.map((s) => room(s).rows.join("\n"));
    expect(new Set(grids).size).toBe(SEEDS.length);
  });

  it("is the same room for the same seed", () => {
    expect(room(5)).toEqual(room(5));
  });

  it("the knobs show: verticality adds standing heights, hazards add spikes, density platforms, open a wider floor", () => {
    const measure = (terrain: Partial<typeof KNOBS>, rows = 30) => {
      const grids = SEEDS.map((s) => room(s, terrain, { rows }));
      return {
        spread: mean(grids.map((g) => stdev(heights(g)))),
        levels: mean(grids.map((g) => new Set(heights(g)).size)),
        spikes: mean(grids.map((g) => count(g, "^"))),
        platforms: mean(grids.map((g) => count(g, "-"))),
        floor: mean(grids.map(widestFloor)),
      };
    };
    // One storey (16 rows), so the spread is the floor's steps and the platforms' tiers, not the bands.
    const flat = measure({ verticality: 0 }, 16);
    const steep = measure({ verticality: 1 }, 16);
    // Taller rooms: more bands (storeys) with verticality.
    const flatTall = measure({ verticality: 0 }, 60);
    const steepTall = measure({ verticality: 1 }, 60);
    const safe = measure({ hazards: 0 });
    const deadly = measure({ hazards: 1 });
    const sparse = measure({ density: 0 });
    const dense = measure({ density: 1 });
    const closed = measure({ open: 0, density: 0.8 });
    const wide = measure({ open: 1, density: 0.8 });
    console.log(JSON.stringify({ flat, steep, flatTall, steepTall, safe, deadly, sparse, dense, closed, wide }, (_, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v)));
    // Verticality: more distinct standing heights (floor steps, terraces, platform tiers) and shorter flat runs.
    expect(steep.levels).toBeGreaterThan(flat.levels * 1.4);
    expect(steep.floor).toBeLessThan(flat.floor);
    expect(steepTall.levels).toBeGreaterThan(flatTall.levels * 1.3);
    expect(safe.spikes).toBe(0);
    expect(deadly.spikes).toBeGreaterThan(4);
    expect(dense.platforms).toBeGreaterThan(sparse.platforms + 6);
    expect(wide.floor).toBeGreaterThan(closed.floor * 1.3);
  }, 300_000);

  it("a room that locks for a fight keeps a wide flat floor", () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const g = room(seed, { open: 0, density: 1, hazards: 1 }, { fight: true });
      expect(widestFloor(g)).toBeGreaterThanOrEqual(20);
    }
  }, 120_000);
});
