import { describe, expect, it } from "vitest";
import { applyOperation, createDefaultProject, fixtureReferenceProject, lintProgressionWorld, type ProjectSpec } from "../src/index.ts";

const apply = (project: ProjectSpec, name: string, input: unknown) => {
  const r = applyOperation(project, name, input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.project;
};
const codes = (project: ProjectSpec) => lintProgressionWorld(project).map((w) => w.code);
const mapRooms = (project: ProjectSpec, f: (r: ProjectSpec["world"]["rooms"][number]) => ProjectSpec["world"]["rooms"][number]): ProjectSpec => ({
  ...project,
  world: { ...project.world, rooms: project.world.rooms.map(f) },
});

describe("progression lint", () => {
  it("passes the reference game", () => {
    expect(lintProgressionWorld(fixtureReferenceProject())).toEqual([]);
  });

  it("stays silent until a room is in a region", () => {
    const p = fixtureReferenceProject();
    expect(lintProgressionWorld(mapRooms(p, ({ regionId: _, ...r }) => r))).toEqual([]);
    expect(lintProgressionWorld(createDefaultProject())).toEqual([]);
  });

  it("warns when an ability is never granted in its region", () => {
    const p = mapRooms(fixtureReferenceProject(), (r) => ({ ...r, spawns: r.spawns.map((s) => ({ ...s, handlers: [] })) }));
    const [w] = lintProgressionWorld(p);
    expect(w).toMatchObject({ code: "ability_not_granted", path: "progression.abilities.1" });
    expect(w!.message).toContain("Double jump (double_jump) is obtained in The Spire");
    expect(w!.message).toContain("grantAbility double_jump");
  });

  it("checks a key ability by the item given (its id or last words), only in its region", () => {
    const base = fixtureReferenceProject();
    const noKey = mapRooms(base, (r) => (r.id === "entrance" ? { ...r, props: [] } : r));
    expect(lintProgressionWorld(noKey)[0]!.message).toContain('Hatch key (hatch_key) is obtained in The Undercroft, but none of its rooms gives it: add a giveItem of an item "hatch_key"');
    // The key moved to a room of another region doesn't count.
    const moved = apply(base, "updateWorldRoom", { roomId: "entrance", changes: { regionId: "spire" } });
    expect(codes(moved)).toContain("ability_not_granted");
  });

  it("warns about a region with no rooms", () => {
    const p = mapRooms(fixtureReferenceProject(), (r) => (r.regionId === "summit" ? { ...r, regionId: "spire" } : r));
    const warnings = lintProgressionWorld(p);
    expect(warnings.map((w) => w.code)).toEqual(["region_without_rooms"]);
    expect(warnings[0]!.message).toContain("region The Summit (summit) has no rooms");
  });

  it("warns about a connection with no door between its regions", () => {
    const p = apply(fixtureReferenceProject(), "connectDoors", { from: { roomId: "sanctum", doorId: "up" }, to: null });
    const warnings = lintProgressionWorld(p);
    expect(warnings.map((w) => w.code)).toEqual(["connection_without_door"]);
    expect(warnings[0]!.message).toContain("connection up_to_summit (The Spire -> The Summit) has no door between their rooms");
  });
});
