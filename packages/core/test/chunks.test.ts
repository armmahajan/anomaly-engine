import { describe, expect, it } from "vitest";
import {
  chainChunks,
  chunkDoors,
  chunkLibrary,
  chunkTraversable,
  createDefaultProject,
  dashGap,
  fillTiles,
  hallChunk,
  gateCheck,
  gateChunks,
  glideChasm,
  gridToSolids,
  mirrorChunk,
  movementModel,
  movementParams,
  MOVEMENT_ABILITIES,
  roomGraph,
  simulateMovement,
  stampChunk,
  canTraverse,
  wallJumpShaft,
  TILE,
  type Chunk,
  type FrameInput,
  type MovementAbility,
  type MovementParams,
  type PlayerCharacter,
} from "../src/index.ts";

const base = createDefaultProject();
const params = movementParams(base.characters[0] as PlayerCharacter, base.world.gravity);
const ALL = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];
const library = chunkLibrary(params);

describe("chunk library", () => {
  it.each(library.map((c) => [c.id, c] as const))("%s: traversable with exactly what it requires", (_id, chunk) => {
    expect(chunkTraversable(chunk, params, chunk.requires)).toBe(true);
    expect(chunkTraversable(chunk, params, ALL)).toBe(true);
    if (chunk.gate) {
      expect(chunk.requires).toEqual([chunk.gate.ability]);
      expect(chunk.gate.holdsAgainst).toEqual(ALL.filter((a) => a !== chunk.gate!.ability));
      expect(chunkTraversable(chunk, params, chunk.gate.holdsAgainst)).toBe(false);
      expect(chunkTraversable(chunk, params, [])).toBe(false);
    }
  });

  it("has one gate per ability", () => {
    expect(Object.entries(gateChunks(params)).map(([a, c]) => [a, c.gate?.ability])).toEqual(ALL.map((a) => [a, a]));
  });

  it("sizes gates from the movement model", () => {
    const { single, double } = { single: movementModel(params, []).maxHeight, double: movementModel(params, ["double_jump"]).maxHeight };
    const step = gateChunks(params).double_jump;
    const rise = (step.openings[0].offset - step.openings[1].offset) * TILE;
    expect(rise).toBeGreaterThan(single + 24);
    expect(rise).toBeLessThan(double - 24);
    const shaft = wallJumpShaft(params);
    expect((shaft.grid.rows.length - 1) * TILE - params.height / 2).toBeGreaterThan(movementModel(params, ALL.filter((a) => a !== "wall_jump")).maxHeight + 48);
  });

  it("adapts to other tuning", () => {
    const player = base.characters[0] as PlayerCharacter;
    const floaty: MovementParams = movementParams(
      { ...player, stats: { ...player.stats, jumpVelocity: 900, runSpeed: 380 }, abilities: { ...player.abilities, dash: { ...player.abilities.dash, distance: 300 } } },
      2000,
    );
    for (const chunk of Object.values(gateChunks(floaty))) {
      expect([chunk.id, chunkTraversable(chunk, floaty, chunk.requires), chunkTraversable(chunk, floaty, chunk.gate!.holdsAgainst)]).toEqual([chunk.id, true, false]);
    }
    expect(dashGap(floaty).grid.rows[0]!.length).toBeGreaterThan(dashGap(params).grid.rows[0]!.length);
  }, 60_000);
});

/**
 * Independent of the checker's plans: brute-force a wide family of open-loop
 * timings (always holding toward the exit) from the takeoff edge, and see
 * whether any lands on the far side without touching a hazard.
 */
function bruteForceCrosses(chunk: Chunk, abilities: MovementAbility[], timings: { delay: number[]; hold: number[]; air: (number | null)[]; dash: (number | null)[] }): boolean {
  const solids = gridToSolids(chunk.grid);
  const graph = roomGraph(chunk.grid, chunkDoors(chunk), params, abilities);
  const entry = graph.surfaces.find((s) => s.x0 <= 16 && s.x1 >= 15)!;
  const far = graph.surfaces.filter((s) => s.x0 > entry.x1 + 2 * TILE);
  const hazards = solids.filter((s) => s.kind === "hazard");
  const hw = params.width / 2;
  const touches = (x: number, y: number) => hazards.some((z) => x - hw - 1 < z.x + z.width && x + hw + 1 > z.x && y - params.height - 1 < z.y + z.height && y + 1 > z.y);
  for (const x of [entry.x1, entry.x1 - 3]) {
    for (const delay of timings.delay) for (const hold of timings.hold) for (const air of timings.air) for (const dash of timings.dash) {
      const jumpAt = 1 + delay;
      const inputs: FrameInput[] = [];
      let prev = false;
      for (let f = 0; f < 240; f++) {
        const jump = f >= jumpAt && (f < jumpAt + hold || (air !== null && f >= jumpAt + air)) && !(air !== null && f === jumpAt + air - 1);
        inputs.push({ right: f >= 1, jump, jumpPressed: jump && !prev, jumpReleased: !jump && prev, dashPressed: dash !== null && f === jumpAt + dash });
        prev = jump;
      }
      for (const s of simulateMovement(params, abilities, solids, { x, y: entry.y }, inputs)) {
        if (touches(s.x, s.y)) break;
        if (s.onFloor && far.some((t) => t.y === s.y && s.x >= t.x0 && s.x <= t.x1)) return true;
      }
    }
  }
  return false;
}

const span = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

describe("gates hold by brute force", () => {
  it("dash: no jump, double jump or glide timing clears the spike strip; a dash does", () => {
    const chunk = dashGap(params);
    const others = ALL.filter((a) => a !== "dash");
    expect(bruteForceCrosses(chunk, others, { delay: [0, 1, 2], hold: [...span(1, 20), 999], air: [null, ...span(2, 40)], dash: [null] })).toBe(false);
    expect(bruteForceCrosses(chunk, ["dash"], { delay: [0], hold: [999], air: [null], dash: span(1, 8) })).toBe(true);
  }, 60_000);

  it("glide: no dash + double jump timing clears the chasm; a glide does", () => {
    const chunk = glideChasm(params);
    const others = ALL.filter((a) => a !== "glide");
    expect(bruteForceCrosses(chunk, others, { delay: [0, 3, 6], hold: [999], air: [null, ...span(4, 60, 2)], dash: [null, ...span(0, 70, 2)] })).toBe(false);
    expect(bruteForceCrosses(chunk, ["glide"], { delay: [0], hold: [999], air: [null], dash: [null] })).toBe(true);
  }, 60_000);
});

describe("assembly", () => {
  it("stamps a chunk into a grid", () => {
    const g = stampChunk({ rows: ["......", "......", "......", "......"] }, { grid: { rows: ["##", "#."] } }, 4, 3);
    expect(g.rows).toEqual(["......", "......", "......", "....##"]);
  });

  it("takes features stamped into a hall, with doors anywhere", () => {
    const shell = hallChunk(params, { width: 30, openings: [{ side: "left", offset: 10, size: 3 }, { side: "top", offset: 24, size: 3 }] });
    expect(shell.grid.rows).toHaveLength(14); // floor on row 13
    let grid = fillTiles(shell.grid, { col: 8, row: 10, cols: 2, rows: 3 }, "solid"); // a pillar
    grid = fillTiles(grid, { col: 12, row: 13, cols: 6, rows: 1 }, "hazard"); // spikes in the floor
    grid = fillTiles(grid, { col: 13, row: 10, cols: 4, rows: 1 }, "oneway");
    grid = fillTiles(grid, { col: 19, row: 7, cols: 4, rows: 1 }, "ledge");
    grid = fillTiles(grid, { col: 23, row: 4, cols: 5, rows: 1 }, "ledge");
    const room = { ...shell, grid };
    expect(chunkTraversable(shell, params, [])).toBe(false); // the top door is out of reach of the bare floor
    expect(chunkTraversable(room, params, [])).toBe(true);
    expect(chunkTraversable({ ...room, grid: fillTiles(grid, { col: 19, row: 7, cols: 4, rows: 1 }, "empty") }, params, [])).toBe(false);
  });

  it("mirrors a chunk to run right to left", () => {
    const m = mirrorChunk(dashGap(params));
    expect(m.openings.map((o) => o.side)).toEqual(["right", "left"]);
    expect([chunkTraversable(m, params, ["dash"]), chunkTraversable(m, params, ALL.filter((a) => a !== "dash"))]).toEqual([true, false]);
  });

  it("chains chunks into a room that needs every gate's ability", () => {
    const lib = Object.fromEntries(library.map((c) => [c.kind === "gate" ? c.gate!.ability : c.kind, c]));
    const room = chainChunks([lib.corridor!, lib.dash!, lib.stairs!, lib.double_jump!, wallJumpShaft(params, { exitSide: "right" }), lib.glide!, lib.ground_pound!, lib.hall!]);
    expect(room.placements).toHaveLength(8);
    const doors = chunkDoors(room);
    const reaches = (abilities: MovementAbility[]) => canTraverse({ grid: room.grid, doors }, "entry", "exit", params, abilities);
    for (const ability of ALL) expect([ability, gateCheck(reaches, ALL, ability).holds]).toEqual([ability, true]);
    expect(() => chainChunks([lib.corridor!, wallJumpShaft(params), lib.corridor!])).toThrow(/enters on the left/);
  }, 60_000);
});
