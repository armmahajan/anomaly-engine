import { describe, expect, it } from "vitest";
import {
  checkGame,
  fixtureReferenceProject,
  gateChecks,
  geometryStage,
  layoutStage,
  lintProject,
  linkDoorId,
  movementParams,
  OPPOSITE,
  ProjectSpec,
  reachableFrom,
  roomGraph,
  seedPlan,
  type PlayerCharacter,
  type ProjectSpec as Project,
  type WorldRoom,
} from "../src/index.ts";

/** A spot to stand on in a room, reachable from its first door with no abilities. */
function standingSpot(project: Project, room: WorldRoom): { x: number; y: number } {
  const player = project.characters.find((c) => c.kind === "player") as PlayerCharacter;
  const params = movementParams(player, project.world.gravity);
  const g = roomGraph(room.grid, room.doors, params, [], { ledgeThickness: project.world.ledgeThickness });
  const reached = [...reachableFrom(g, `in:${room.doors[0]!.id}`)].filter((n) => /^s\d+$/.test(n));
  const widest = reached.map((n) => g.surface(n)!).sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))[0]!;
  return { x: Math.round((widest.x0 + widest.x1) / 2), y: widest.y };
}

function prop(id: string, at: { x: number; y: number }, effect: Record<string, unknown>) {
  return { id, x: at.x - 16, y: at.y - 32, width: 32, height: 32, handlers: [{ on: { type: "touch" }, do: [effect] }] };
}

describe("geometry stage on the reference game", () => {
  const base = fixtureReferenceProject();
  const planned = ProjectSpec.parse({ ...base, architect: seedPlan(base), world: { ...base.world, rooms: [], start: null, playtest: null } });
  const laid = layoutStage(planned);
  const t0 = performance.now();
  const out = geometryStage(laid.project);
  const ms = Math.round(performance.now() - t0);
  const project = out.project;
  const plan = project.architect;

  it("builds every plan room, proven, with doors linked per the plan", () => {
    console.log(`geometry: ${out.summary} in ${ms} ms`);
    expect(out.issues).toEqual([]);
    for (const r of plan.rooms) {
      const room = project.world.rooms.find((w) => w.id === r.id)!;
      expect(room, r.id).toBeDefined();
      expect([room.grid.rows.length, room.grid.rows[0]!.length, room.regionId, room.name]).toEqual([r.rows, r.cols, r.regionId, r.name]);
      expect(room.at).toEqual(r.at);
    }
    for (const l of plan.links) {
      const a = project.world.rooms.find((w) => w.id === l.a.room)!.doors.find((d) => d.id === linkDoorId(l.id, "a"))!;
      const b = project.world.rooms.find((w) => w.id === l.b.room)!.doors.find((d) => d.id === linkDoorId(l.id, "b"))!;
      expect([a.side, b.side], l.id).toEqual([l.a.side, l.b.side]);
      expect(b.side).toBe(OPPOSITE[a.side]);
      expect(a.to).toEqual({ room: l.b.room, door: b.id });
      expect(b.to).toEqual({ room: l.a.room, door: a.id });
    }
    expect(lintProject(project).filter((w) => w.code === "unstandable_platform")).toEqual([]);
  });

  it("is beatable with no dead states, and its gates hold, once a start, the guardian's gift and an ending are added", () => {
    const startRoom = plan.rooms.find((r) => r.contents.some((c) => c.kind === "start"))!;
    const endRoom = plan.rooms.find((r) => r.contents.some((c) => c.kind === "ending"))!;
    const world = structuredClone(project.world);
    const room = (id: string) => world.rooms.find((r) => r.id === id)!;
    world.start = { room: startRoom.id, ...standingSpot(project, room(startRoom.id)) };
    for (const r of plan.rooms) {
      for (const c of r.contents) {
        const grants = c.kind === "enemy" ? c.grants : c.kind === "pickup" ? [c.grants] : [];
        for (const id of grants) {
          const ability = project.progression.abilities.find((a) => a.id === id)!;
          const effect = ability.mechanic === "key" ? { type: "giveItem", item: id } : { type: "grantAbility", ability: ability.mechanic };
          room(r.id).props.push(prop(`gift_${id}`, standingSpot(project, room(r.id)), effect) as never);
          if (ability.mechanic === "key" && !world.items.some((i) => i.id === id)) world.items.push({ id, name: ability.name } as never);
        }
      }
    }
    room(endRoom.id).props.push(prop("ending", standingSpot(project, room(endRoom.id)), { type: "endGame" }) as never);
    const game = ProjectSpec.parse({ ...project, world });
    const t = performance.now();
    const check = checkGame(game);
    console.log(`checkGame: ${check.stats.states} states, ${Math.round(performance.now() - t)} ms; route ${check.route?.length} steps`);
    expect(check.beatable).toBe(true);
    expect(check.deadStates.map((d) => d.why)).toEqual([]);
    const gates = gateChecks(game, check);
    expect(gates.length).toBeGreaterThan(0);
    for (const g of gates) expect(g, g.connection).toMatchObject({ holdsWithout: true, reachableWith: true });
  });

  it("is deterministic, and leaves pinned rooms alone", () => {
    expect(geometryStage(laid.project).project).toEqual(project);
    const pinnedId = plan.rooms[1]!.id;
    const pinnedPlan = ProjectSpec.parse({
      ...project,
      architect: { ...plan, rooms: plan.rooms.map((r) => (r.id === pinnedId ? { ...r, pinned: true } : { ...r, seed: r.seed + 1 })) },
    });
    const again = geometryStage(pinnedPlan);
    expect(again.project.world.rooms.find((r) => r.id === pinnedId)).toEqual(project.world.rooms.find((r) => r.id === pinnedId));
    expect(again.issues).toEqual([]);
    // Other rooms changed with their seeds, and still link to the pinned room's doors.
    const changed = again.project.world.rooms.filter((r) => JSON.stringify(r.grid) !== JSON.stringify(project.world.rooms.find((w) => w.id === r.id)!.grid));
    expect(changed.length).toBeGreaterThan(0);
  });
});
