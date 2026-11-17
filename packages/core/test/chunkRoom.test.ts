import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, gateChecks, MOVEMENT_ABILITIES, type MovementAbility, type ProjectSpec } from "../src/index.ts";

/** a (start, gives the ability) -> gate room -> b (ends the game), with a progression that gates b on the ability. */
function gated(ability: MovementAbility): ProjectSpec {
  const base = createDefaultProject();
  const empty = { ...base, world: { ...base.world, rooms: [], start: null, playtest: null } };
  const result = applyBatch(empty, [
    { name: "createRegion", input: { region: { id: "near", name: "Near", status: "canon" } } },
    { name: "createRegion", input: { region: { id: "far", name: "Far", status: "canon" } } },
    { name: "createAbility", input: { ability: { id: ability, name: ability, mechanic: ability, obtainedIn: { regionId: "near", source: "pickup" }, status: "canon" } } },
    { name: "createConnection", input: { connection: { id: "near_far", from: "near", to: "far", requires: [ability], status: "canon" } } },
    { name: "createWorldRoom", input: { name: "A", id: "a", cols: 20, rows: 14, regionId: "near" } },
    { name: "createChunkRoom", input: { name: "Gate", id: "gate", chunk: "gate", ability, regionId: "near" } },
    { name: "createWorldRoom", input: { name: "B", id: "b", cols: 20, rows: 30, regionId: "far" } },
  ]);
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
}

describe("createChunkRoom", () => {
  it("makes a room from a library chunk, with unconnected entry and exit doors", () => {
    const p = gated("dash");
    const gate = p.world.rooms.find((r) => r.id === "gate")!;
    expect(gate.doors.map((d) => [d.id, d.to])).toEqual([["entry", null], ["exit", null]]);
    expect(gate.regionId).toBe("near");
  });

  it.each(Object.keys(MOVEMENT_ABILITIES) as MovementAbility[])("builds a %s gate that the checker proves holds", (ability) => {
    let p = gated(ability);
    const gate = p.world.rooms.find((r) => r.id === "gate")!;
    const [entry, exit] = gate.doors;
    // Doors of A and B facing the gate's openings, and an ending and the ability pickup.
    const facing = (side: string) => ({ left: "right", right: "left", top: "bottom", bottom: "top" })[side]!;
    const offset = (side: string, rows: number) => (side === "left" || side === "right" ? rows - 4 : 8);
    const result = applyBatch(p, [
      { name: "setDoor", input: { roomId: "a", door: { id: "out", side: facing(entry!.side), offset: offset(facing(entry!.side), 14), size: entry!.size } } },
      { name: "setDoor", input: { roomId: "b", door: { id: "in", side: facing(exit!.side), offset: offset(facing(exit!.side), 30), size: exit!.size } } },
      { name: "connectDoors", input: { from: { roomId: "a", doorId: "out" }, to: { roomId: "gate", doorId: "entry" } } },
      { name: "connectDoors", input: { from: { roomId: "gate", doorId: "exit" }, to: { roomId: "b", doorId: "in" } } },
      { name: "setWorldStart", input: { roomId: "a", x: 96, y: 416 } },
      { name: "addProp", input: { roomId: "a", id: "relic", x: 200, y: 384, width: 32, height: 32 } },
      { name: "addHandler", input: { roomId: "a", propId: "relic", handler: { on: { type: "touch" }, do: [{ type: "grantAbility", ability }] } } },
    ]);
    if (!result.ok) throw new Error(result.error.message);
    p = result.project;
    const [check] = gateChecks(p);
    expect(check).toMatchObject({ connection: "near_far", needs: [ability], holdsWithout: true, reachableWith: true });
  });
});
