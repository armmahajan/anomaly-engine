import { describe, expect, it } from "vitest";
import {
  createDefaultProject,
  defaultArenaGrid,
  gridToSolids,
  migrateProject,
  ProjectSpec,
  rectsToGrid,
  TILE,
  tileAt,
  toRuntimeProject,
  validateProject,
  type TileGrid,
} from "../src/index.ts";

const grid = (...rows: string[]): TileGrid => ({ rows });

/** Every tile covered by exactly one solid of its kind (thin tiles: the top of their cell). */
function coverage(g: TileGrid, thickness = 20) {
  const solids = gridToSolids(g, thickness);
  return g.rows.map((row, r) =>
    row
      .split("")
      .map((_, c) => {
        const cx = c * TILE + TILE / 2;
        const cy = r * TILE + 1;
        const hits = solids.filter((s) => cx > s.x && cx < s.x + s.width && cy > s.y && cy < s.y + s.height);
        return hits.length === 0 ? "." : hits.length > 1 ? "!" : ({ solid: "#", ledge: "=", oneway: "-", hazard: "^", breakable: "%" } as const)[hits[0]!.kind];
      })
      .join(""),
  );
}

describe("tile grids", () => {
  const sample = grid(
    "##########",
    "#........#",
    "#..===...#",
    "#.....--.#",
    "#^^..%%..#",
    "#....%...#",
    "#.%......#",
    "##########",
  );

  it("turn into the fewest rectangles that cover each tile exactly once", () => {
    expect(coverage(sample)).toEqual(sample.rows);
    const solids = gridToSolids(sample);
    expect(solids.filter((s) => s.kind === "solid")).toEqual([
      { x: 0, y: 0, width: 320, height: 32, kind: "solid" },
      { x: 0, y: 32, width: 32, height: 224, kind: "solid" },
      { x: 288, y: 32, width: 32, height: 224, kind: "solid" },
      { x: 32, y: 224, width: 256, height: 32, kind: "solid" },
    ]);
    expect(solids.find((s) => s.kind === "ledge")).toEqual({ x: 96, y: 64, width: 96, height: 20, kind: "ledge" });
    expect(solids.find((s) => s.kind === "oneway")).toEqual({ x: 192, y: 96, width: 64, height: 20, kind: "oneway" });
    expect(gridToSolids(sample, 12).find((s) => s.kind === "ledge")!.height).toBe(12);
  });

  it("number each connected breakable area, so it smashes together", () => {
    const breakables = gridToSolids(sample).filter((s) => s.kind === "breakable");
    expect(breakables.map((s) => [s.x / TILE, s.y / TILE, s.width / TILE, s.group])).toEqual([
      [5, 4, 2, 1],
      [5, 5, 1, 1],
      [2, 6, 1, 2],
    ]);
  });

  it("rasterize old platform rectangles", () => {
    const g = rectsToGrid(
      [
        { x: 0, y: 160, width: 320, height: 64 },
        { x: 64, y: 70, width: 100, height: 20 },
        { x: 200, y: 96, width: 64, height: 20, breakable: true },
      ],
      10,
      8,
    );
    expect(g.rows).toEqual(["..........", "..........", "..===.....", "......%%..", "..........", "#########.".replace(".", "#"), "##########", ".........."]);
    expect(tileAt(g, 3, 2)).toBe("ledge");
    expect(tileAt(g, -1, 0)).toBe("empty");
  });

  it("are validated: one width, known characters", () => {
    const project = createDefaultProject();
    const bad = (rows: string[]) => validateProject({ ...project, sandbox: { ...project.sandbox, grid: { rows } } }).ok;
    expect(bad(["....", "....", "....", "...."])).toBe(true);
    expect(bad(["....", ".....", "....", "...."])).toBe(false);
    expect(bad(["....", "..x.", "....", "...."])).toBe(false);
  });
});

describe("the arena on a grid", () => {
  it("old arenas migrate onto the grid: outside walls and ceiling become its border", () => {
    const { grid: _grid, ...sandbox } = createDefaultProject().sandbox;
    const old = {
      ...createDefaultProject(),
      schemaVersion: 4,
      sandbox: {
        ...sandbox,
        width: 1600,
        height: 720,
        platforms: [
          { x: 0, y: 660, width: 1600, height: 60 },
          { x: -40, y: 0, width: 40, height: 720 },
          { x: 1600, y: 0, width: 40, height: 720 },
          { x: -40, y: -40, width: 1680, height: 40 },
          { x: 380, y: 530, width: 220, height: 20 },
          { x: 720, y: 420, width: 220, height: 20, breakable: true },
        ],
        spawns: [
          { id: "player_1", characterId: "player", x: 160, y: 660 },
          { id: "crawler_1", characterId: "crawler", x: 10, y: 700 },
        ],
      },
    };
    const migrated = ProjectSpec.parse(migrateProject(old));
    expect(migrated.sandbox.grid).toEqual(defaultArenaGrid());
    expect(migrated.sandbox.spawns).toEqual([
      { id: "player_1", characterId: "player", x: 160, y: 660 },
      { id: "crawler_1", characterId: "crawler", x: 48, y: 672 }, // out of the wall and the floor
    ]);
  });

  it("the runtime gets the arena's size and collision, computed once", () => {
    const runtime = toRuntimeProject(createDefaultProject());
    expect([runtime.sandbox.width, runtime.sandbox.height]).toEqual([1600, 736]);
    expect(runtime.sandbox.solids).toEqual(gridToSolids(defaultArenaGrid()));
    expect(runtime.wiki.pages).toEqual([]);
  });
});

describe("the world", () => {
  const room = (id: string, doors: unknown[] = [], extra = {}) => ({ id, name: id, grid: { rows: Array(8).fill("..........") }, doors, ...extra });

  it("checks doors lead to each other on opposite sides, and spawns are enemies", () => {
    const base = createDefaultProject();
    const check = (rooms: unknown[], start: unknown = null) => {
      const result = validateProject({ ...base, world: { rooms, start } });
      return result.ok ? [] : result.issues.map((i) => i.message);
    };
    const a = room("a", [{ id: "east", side: "right", offset: 2, size: 3, to: { room: "b", door: "west" } }]);
    const b = room("b", [{ id: "west", side: "left", offset: 2, size: 3, to: { room: "a", door: "east" } }], { spawns: [{ id: "c1", characterId: "crawler", x: 100, y: 200 }] });
    expect(check([a, b], { room: "a", x: 64, y: 192 })).toEqual([]);
    expect(check([a])).toEqual(['door "east" leads to unknown room "b"']);
    expect(check([a, room("b", [{ id: "west", side: "top", offset: 2, size: 3, to: { room: "a", door: "east" } }])])).toContain(
      'door "east" (right) must lead to a left door; "west" is top',
    );
    expect(check([room("a", [{ id: "d", side: "left", offset: 6, size: 3 }])])).toEqual(['door "d" runs past the room\'s left side (8 tiles)']);
    expect(check([room("a", [], { spawns: [{ id: "p", characterId: "player", x: 1, y: 1 }] })])[0]).toContain('unknown enemy "player"');
    expect(check([a, b], { room: "nowhere", x: 0, y: 0 })).toEqual(['unknown room "nowhere"']);
  });
});
