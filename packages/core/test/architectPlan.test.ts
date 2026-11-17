import { describe, expect, it } from "vitest";
import { applyOperation, fixtureReferenceProject, migrateProject, ProjectSpec, regionOrder, roomLinks, seedPlan, SCHEMA_VERSION, type ProjectSpec as Project } from "../src/index.ts";

const ok = (project: Project, name: string, input: unknown): Project => {
  const result = applyOperation(project, name, input);
  if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  return result.project;
};

describe("the Architect's plan", () => {
  const base = fixtureReferenceProject();

  it("older projects migrate to an empty plan", () => {
    const old = { ...base, schemaVersion: 7 } as Record<string, unknown>;
    delete old.architect;
    const project = ProjectSpec.parse(migrateProject(old));
    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(project.architect.rooms).toEqual([]);
    expect(project.architect.target.minutes).toEqual([15, 25]);
  });

  it("seeds a valid plan from the progression alone: regions in order, gates copied, start, ending and every ability placed", () => {
    const plan = seedPlan(base);
    const project = ProjectSpec.parse({ ...base, architect: plan });
    const order = regionOrder(base);
    expect([...new Set(project.architect.rooms.map((r) => r.regionId))]).toEqual(order);
    expect(project.architect.rooms.filter((r) => r.contents.some((c) => c.kind === "start"))).toHaveLength(1);
    expect(project.architect.rooms.filter((r) => r.contents.some((c) => c.kind === "ending"))).toHaveLength(1);
    const granted = project.architect.rooms.flatMap((r) => r.contents.flatMap((c) => (c.kind === "pickup" ? [c.grants] : c.kind === "enemy" ? c.grants : [])));
    for (const ability of base.progression.abilities.filter((a) => a.obtainedIn)) expect(granted).toContain(ability.id);
    for (const c of base.progression.connections) {
      const link = project.architect.links.find((l) => l.id === c.id)!;
      expect(link.requires).toEqual(c.requires);
    }
    // Every room is reachable by links.
    const seen = new Set([project.architect.rooms[0]!.id]);
    for (const id of seen) for (const { other } of roomLinks(project.architect, id)) seen.add(other);
    expect(seen.size).toBe(project.architect.rooms.length);
  });

  it("plan operations edit it, and pinned rooms are the creator's", () => {
    let p = ok(base, "seedArchitectPlan", {});
    const room = p.architect.rooms[1]!;
    p = ok(p, "updateRoomPlan", { roomId: room.id, changes: { cols: 60, terrain: { verticality: 0.9 }, notes: "a tall shaft" } });
    const edited = p.architect.rooms.find((r) => r.id === room.id)!;
    expect([edited.cols, edited.terrain.verticality, edited.terrain.hazards, edited.notes]).toEqual([60, 0.9, room.terrain.hazards, "a tall shaft"]);

    p = ok(p, "setRoomPinned", { roomId: room.id, pinned: true });
    const refused = applyOperation(p, "updateRoomPlan", { roomId: room.id, changes: { cols: 30 } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("pinned");
    expect(applyOperation(p, "deleteRoomPlan", { roomId: room.id }).ok).toBe(false);

    // A new plan (the plan stage's output) never replaces a pinned room.
    p = ok(p, "setArchitectPlan", { plan: { rooms: [{ id: room.id, name: "Other", regionId: room.regionId, cols: 20 }] } });
    expect(p.architect.rooms.find((r) => r.id === room.id)).toEqual({ ...edited, pinned: true });
    // Re-seeding keeps it too.
    p = ok(p, "seedArchitectPlan", {});
    expect(p.architect.rooms.find((r) => r.id === room.id)!.notes).toBe("a tall shaft");
  });

  it("guidance, pauses, links and stage status", () => {
    let p = ok(base, "seedArchitectPlan", {});
    const region = base.progression.regions[0]!.id;
    p = ok(p, "setArchitectGuidance", { guidance: "melancholy, vertical", region: { regionId: region, notes: "tight corridors" }, targetMinutes: [10, 20] });
    expect(p.architect.regionNotes).toEqual([{ regionId: region, notes: "tight corridors" }]);
    p = ok(p, "setArchitectGuidance", { region: { regionId: region, notes: "" } });
    expect(p.architect.regionNotes).toEqual([]);
    p = ok(p, "setArchitectPause", { pauseAfter: ["plan", "geometry", "plan"] });
    expect(p.architect.pauseAfter).toEqual(["plan", "geometry"]);

    const [a, b] = p.architect.rooms;
    p = ok(p, "linkRooms", { link: { id: "shortcut", a: { room: a!.id, side: "top" }, b: { room: b!.id } } });
    p = ok(p, "updateRoomLink", { linkId: "shortcut", changes: { aSide: null, oneWay: true } });
    expect(p.architect.links.find((l) => l.id === "shortcut")).toMatchObject({ a: { room: a!.id }, oneWay: true });
    expect(p.architect.links.find((l) => l.id === "shortcut")!.a.side).toBeUndefined();
    expect(applyOperation(p, "linkRooms", { link: { id: "bad", a: { room: a!.id }, b: { room: "nowhere" } } }).ok).toBe(false);
    p = ok(p, "unlinkRooms", { linkId: "shortcut" });

    p = ok(p, "setStageStatus", { stage: "plan", status: { status: "done", summary: "12 rooms" } });
    expect(p.architect.stages.plan).toMatchObject({ status: "done", summary: "12 rooms" });
  });
});
