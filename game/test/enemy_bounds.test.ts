import { describe, expect, it } from "vitest";
import { ARENA_FLOOR, gridSize, ProjectSpec, TILE } from "@anomaly/core";
import { arena, entity, FPS, range, simulate } from "./simulate.ts";

// Doorways are for the player: an enemy that charges or patrols into one meets an invisible
// wall at the room's edge (and stops, turns or fires hit_wall) instead of leaving the room,
// falling out of the world and reappearing at home.

describe("enemies stay in their room (headless runtime)", () => {
  it("a charger stops at a floor-level doorway and a patroller turns there", () => {
    const base = arena([
      { id: "charger", at: [1300, ARENA_FLOOR], initial: "rush", states: { rush: { action: { type: "charge", speed: 700, direction: "horizontal" }, go: [[{ type: "actionDone" }, "done"]] }, done: { action: { type: "wait" } } } },
      { id: "walker", at: [300, ARENA_FLOOR], initial: "walk", states: { walk: { action: { type: "patrol", speed: 300, distance: 4000, turnAtWall: true, turnAtLedge: false } } } },
    ], [800, ARENA_FLOOR]);
    // Open both side walls at floor level, three tiles tall, like a door.
    const room = base.world.rooms[0]!;
    const floorRow = ARENA_FLOOR / TILE;
    const rows = room.grid.rows.map((row, r) => (r >= floorRow - 3 && r < floorRow ? "." + row.slice(1, -1) + "." : row));
    const project = ProjectSpec.parse({ ...base, world: { ...base.world, rooms: [{ ...room, grid: { rows } }] } });
    const { width } = gridSize({ rows });
    const frames = 7 * FPS;
    const [samples] = simulate([{ project, frames, samples: range(0, frames, 5) }]);
    const charger = samples!.map((s) => entity(s, "charger_1"));
    const walker = samples!.map((s) => entity(s, "walker_1"));
    for (const e of [...charger, ...walker]) {
      expect(e.x).toBeGreaterThanOrEqual(0);
      expect(e.x).toBeLessThanOrEqual(width);
    }
    // The charger faced the player (left) or right; either way it ends at a wall and its charge is done.
    expect(charger.at(-1)!.behaviorState).toBe("done");
    expect(Math.min(...charger.map((e) => e.x), width - Math.max(...charger.map((e) => e.x)))).toBeLessThan(40);
    // The walker reached an edge and came back.
    const xs = walker.map((e) => e.x);
    const edge = xs.findIndex((x) => x < 40 || x > width - 40);
    expect(edge).toBeGreaterThan(-1);
    expect(xs.slice(edge).some((x) => Math.abs(x - xs[edge]!) > 100)).toBe(true);
  }, 90_000);
});
