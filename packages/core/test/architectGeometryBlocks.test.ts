import { describe, expect, it } from "vitest";
import { chunkTraversable, createDefaultProject, movementParams, MOVEMENT_ABILITIES, unitsFor, type MovementAbility, type PlayerCharacter } from "../src/index.ts";
import { gateBlock, glideTwoWay, groundPoundTwoWay } from "../src/architect/geometry/blocks.ts";

const base = createDefaultProject();
const params = movementParams(base.characters[0] as PlayerCharacter, base.world.gravity);
const u = unitsFor(params);
const ALL = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];

describe("gate blocks", () => {
  it.each(ALL)("%s: passable with it, not without it (with every other ability), on every side; two-way ones lead back", (ability) => {
    const others = ALL.filter((a) => a !== ability);
    for (const side of ["left", "right", "top", "bottom"] as const) {
      for (const twoWay of [true, false]) {
        for (const facing of ["left", "right"] as const) {
          const b = gateBlock(params, u, [ability], side, { twoWay, facing });
          const chunk = { grid: b.grid, openings: [b.entry, b.door] as [typeof b.entry, typeof b.door] };
          const back = { grid: b.grid, openings: [b.door, b.entry] as [typeof b.entry, typeof b.door] };
          const what = `${ability} ${side} ${twoWay ? "two-way" : "one-way"} facing ${facing}`;
          expect(new Set(b.grid.rows.map((r) => r.length)).size, what).toBe(1);
          expect(chunkTraversable(chunk, params, [ability]), what).toBe(true);
          expect(chunkTraversable(chunk, params, others), what).toBe(false);
          if (twoWay) expect(chunkTraversable(back, params, [ability]), `${what}: back`).toBe(true);
          if (side === "top" || side === "bottom") expect(b.door.side).toBe(side);
        }
      }
    }
  }, 120_000);

  it("the glide and ground pound gates have return valves the plain chunks lack", () => {
    for (const chunk of [glideTwoWay(params, u), groundPoundTwoWay(params, u)]) {
      const back = { grid: chunk.grid, openings: [chunk.openings[1], chunk.openings[0]] as typeof chunk.openings };
      expect(chunkTraversable(back, params, chunk.requires), chunk.id).toBe(true);
      expect(chunkTraversable(chunk, params, ALL.filter((a) => a !== chunk.gate!.ability)), chunk.id).toBe(false);
    }
  });
});
