import { describe, expect, it } from "vitest";
import { applyOperation, createDefaultProject, roomFingerprint, type ProjectSpec } from "@anomaly/core";
import { lookForRoom, lookUsage, nameList, regionGroups, roomArt, roomsDressedBy } from "./scenery.ts";

/** The default project with two regions, three more rooms and a look whose dressing dresses one of them. */
function project(): ProjectSpec {
  let p = createDefaultProject();
  const op = (name: string, input: unknown) => {
    const result = applyOperation(p, name, input);
    if (!result.ok) throw new Error(result.error.message);
    p = result.project;
  };
  op("createRegion", { region: { id: "caves", name: "The Caves", rooms: 2, status: "canon" } });
  op("createRegion", { region: { id: "spire", name: "The Spire", rooms: 3, status: "canon" } });
  op("createWorldRoom", { name: "Cave 1", cols: 12, rows: 8, regionId: "caves" });
  op("createWorldRoom", { name: "Cave 2", cols: 12, rows: 8, regionId: "caves" });
  op("createWorldRoom", { name: "Spire 1", cols: 12, rows: 8, regionId: "spire" });
  const look = { id: "dank", kind: "biome", name: "The Caves", brief: "", kit: null, rooms: [{ id: "dank_1", name: "Dank 1" }] };
  const rooms = p.world.rooms.map((r) => (r.id === "cave_1" ? { ...r, dressing: { biome: "dank", room: "dank_1", tiles: roomFingerprint(r) } } : r));
  return { ...p, art: { ...p.art, assets: [...p.art.assets, look as never] }, world: { ...p.world, rooms } };
}

describe("scenery: looks, dressings and the game rooms they dress", () => {
  it("groups game rooms by region, then the rooms in none", () => {
    const groups = regionGroups(project());
    expect(groups.map((g) => [g.id, g.name, g.planned, g.rooms.map((r) => r.id)])).toEqual([
      ["caves", "The Caves", 2, ["cave_1", "cave_2"]],
      ["spire", "The Spire", 3, ["spire_1"]],
      ["", "No region", null, ["arena"]],
    ]);
  });

  it("tells a room's scenery: plain, dressed, or dressed around tiles that changed since", () => {
    const p = project();
    const cave = p.world.rooms.find((r) => r.id === "cave_1")!;
    expect(roomArt(p, p.world.rooms.find((r) => r.id === "cave_2")!).state).toBe("plain");
    expect(roomArt(p, cave)).toMatchObject({ state: "dressed", look: { id: "dank" }, dressing: { id: "dank_1" } });
    const changed = { ...cave, grid: { ...cave.grid, rows: cave.grid.rows.map((row, i) => (i === 3 ? `#${"=".repeat(row.length - 2)}#` : row)) } };
    expect(roomArt(p, changed).state).toBe("stale");
  });

  it("finds where a look is used and the look a plain room would use", () => {
    const p = project();
    const look = p.art.assets.find((a) => a.id === "dank")!;
    expect(roomsDressedBy(p, "dank", "dank_1").map((r) => r.id)).toEqual(["cave_1"]);
    expect(lookUsage(p, look as never)).toMatchObject({ rooms: [{ id: "cave_1" }], regions: ["The Caves"] });
    expect(lookForRoom(p, p.world.rooms.find((r) => r.id === "cave_2")!)?.id).toBe("dank");
  });

  it("lists names in prose", () => {
    expect(nameList(["Arena"])).toBe("Arena");
    expect(nameList(["Arena", "Hall"])).toBe("Arena and Hall");
    expect(nameList(["A", "B", "C", "D"])).toBe("A, B and 2 more");
  });
});
