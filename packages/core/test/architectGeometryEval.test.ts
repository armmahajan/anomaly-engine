import { describe, expect, it } from "vitest";
import a1 from "./fixtures/architectEval-a1.json" with { type: "json" };
import b4 from "./fixtures/architectEval-b4.json" with { type: "json" };
import c7 from "./fixtures/architectEval-c7.json" with { type: "json" };
import c9 from "./fixtures/architectEval-c9.json" with { type: "json" };
import { geometryStage, layoutStage, linkDoorId, migrateProject, ProjectSpec, roomLinks, type ProjectSpec as Project } from "../src/index.ts";

/**
 * Plans from the real-model eval that the geometry stage once couldn't build
 * (fixtures: the projects with their art and rebuilt world rooms stripped).
 *
 * - b4: waxen_stair_5, side doors left and right and a two-way wall-jump gate on its top.
 * - c7: the_bindery_4, side doors left and right, a one-way glide drop out of its bottom, a top door.
 * - c9: the_belfry_terraces_4, whose two-way wall-jump gate on its top leads to the room with the
 *   key (unbuilt, the key room's door led nowhere and the game couldn't be finished).
 * - a1: every room built; its "can't be reached through veil_to_crown even with glide" came from
 *   checkGame stopping at its 100k-state cap (the game is beatable at 118,876 states).
 *
 * Each builds every room, proven, both as planned and when the run sends the room back to layout
 * (its links' sides cleared, its seed changed, it and its neighbours re-laid out and rebuilt).
 */

const FIXTURES: Record<string, unknown> = { a1, b4, c7, c9 };
const load = (name: string): Project => ProjectSpec.parse(migrateProject(structuredClone(FIXTURES[name])));

const BLOCKING = new Set(["room-unbuilt", "room-unproven", "door-unlinked", "door-sides"]);

function expectBuilt(project: Project, issues: { code: string; message: string }[]) {
  expect(issues.filter((i) => BLOCKING.has(i.code)).map((i) => `${i.code}: ${i.message}`)).toEqual([]);
  for (const r of project.architect.rooms) {
    const room = project.world.rooms.find((w) => w.id === r.id);
    expect(room, r.id).toBeDefined();
    for (const { link, here } of roomLinks(project.architect, r.id)) {
      const door = room!.doors.find((d) => d.id === linkDoorId(link.id, here));
      expect(door?.to, `${r.id} ${link.id}`).toBeTruthy();
    }
  }
}

const CASES: [string, string][] = [
  ["b4", "waxen_stair_5"],
  ["c7", "the_bindery_4"],
  ["c9", "the_belfry_terraces_4"],
  ["a1", "smoke_veil_5"],
];

describe("geometry on the eval's plans", () => {
  it.each(CASES)("%s: every room built and proven, as planned", (name) => {
    const laid = layoutStage(load(name));
    const built = geometryStage(laid.project);
    expectBuilt(built.project, built.issues);
  }, 300_000);

  it.each(CASES)("%s: sent back to layout (%s's sides cleared, reseeded), it and its neighbours rebuild", (name, roomId) => {
    const first = layoutStage(load(name)).project;
    const built = geometryStage(first).project;
    const plan = structuredClone(built.architect);
    const neighbours = new Set([roomId, ...roomLinks(plan, roomId).map((l) => l.other)]);
    for (const l of plan.links) {
      if (l.a.room !== roomId && l.b.room !== roomId) continue;
      delete l.a.side;
      delete l.b.side;
    }
    plan.rooms = plan.rooms.map((r) => (r.id === roomId ? { ...r, seed: r.seed + 1 } : r));
    const sent = ProjectSpec.parse({ ...built, architect: plan });
    const laid = layoutStage(sent, { rooms: [...neighbours] });
    // The rest of the map stays put; every link has opposite sides; a gated two-way link leaves from a side wall.
    for (const r of laid.project.architect.rooms) if (!neighbours.has(r.id)) expect(r.at, r.id).toEqual(sent.architect.rooms.find((x) => x.id === r.id)!.at);
    for (const l of laid.project.architect.links) expect(l.a.side && l.b.side, l.id).toBeTruthy();
    const abilities = new Map(sent.progression.abilities.map((a) => [a.id, a.mechanic]));
    for (const { link } of roomLinks(laid.project.architect, roomId)) {
      const movement = link.requires.some((r) => ["dash", "double_jump", "wall_jump", "glide", "ground_pound"].includes(abilities.get(r) ?? ""));
      if (movement && !link.oneWay) expect(["left", "right"], link.id).toContain(link.a.side);
    }
    const rebuilt = geometryStage(laid.project, { rooms: [...neighbours] });
    expectBuilt(rebuilt.project, rebuilt.issues);
  }, 300_000);
});
