import { ProjectSpec } from "../../schema.ts";
import { MOVEMENT_ABILITIES, movementParams, type MovementAbility, type MovementParams } from "../../movement/params.ts";
import { OPPOSITE, type Door, type WorldRoom } from "../../world/world.ts";
import { linkDoorId, roomLinks, type ArchitectPlan, type RoomPlan } from "../plan.ts";
import { stageRooms, unchanged, type StageIssue, type StageOptions, type StageOutcome } from "../stages.ts";
import { composeRoom, type Composed, type DoorNeed, type RoomRequest } from "./compose.ts";
import { layoutPlan } from "./layout.ts";
import { minimumSize } from "./sizing.ts";
import { proveRoom, type Proof } from "./prove.ts";
import { unitsFor } from "./units.ts";

export { doorCapacity, bandsFit } from "./capacity.ts";
export { unitsFor, type Units } from "./units.ts";
export { composeRoom, type Composed, type DoorNeed, type RoomRequest } from "./compose.ts";
export { proveRoom, type Proof, type ProofDoor } from "./prove.ts";
export { unstandableRuns } from "./lint.ts";
export { minimumSize } from "./sizing.ts";

/**
 * Layout and geometry stages (agent K owns this folder).
 *
 * layoutStage: fill each unpinned plan room's map position (`RoomPlan.at`) and every
 * link end's `side`, so linked rooms sit next to each other on the world map and
 * doors face each other. Writes only `project.architect`. (layout.ts)
 *
 * geometryStage: for each unpinned plan room (or `options.rooms`), build the world
 * room with the same id: its tile grid (cols x rows) composed from bands, ladders and
 * proven gate chunks (compose.ts, blocks.ts), a door per link end named
 * `linkDoorId(link.id, end)` on the link's side, connected to the other end's door
 * (also when that room is pinned and has the door), `at`, `regionId` and `name` from
 * the plan. Gated links (`requires` with movement abilities) get a proven gate at the
 * `a` end's room. Each room is proven with the traversal checker (prove.ts): every
 * door reachable from every other with no abilities, gated doors with exactly their
 * abilities, one-way drops not climbable, no traps, no unstandable platforms; the
 * first proven attempt wins (sub-seeds, then plainer knobs), else the stage reports
 * it. Same plan + seed -> same room. Rebuilding clears the room's spawns, props and
 * handlers (population puts them back); pinned rooms are never touched.
 */

/** The player's movement, or null when the project has no player. */
export function playerMovement(project: ProjectSpec): MovementParams | null {
  const player = project.characters.find((c) => c.kind === "player");
  return player && player.kind === "player" ? movementParams(player, project.world.gravity) : null;
}

export function layoutStage(project: ProjectSpec, options: StageOptions = {}): StageOutcome {
  const params = playerMovement(project);
  if (!params) return { project, issues: [{ stage: "layout", code: "no-player", message: "the project has no player character to size rooms by" }], summary: "layout: no player" };
  if (!project.architect.rooms.length) return unchanged(project, "layout: the plan has no rooms");
  const units = unitsFor(params);
  const only = options.rooms ? new Set(options.rooms) : undefined;
  // Place, then grow rooms too small for their doors (gates, chutes, many doors on a side) and place again, sides kept.
  let plan = project.architect;
  let result = layoutPlan(plan, project.world, units, only);
  const grown = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    let grew = false;
    const rooms = result.plan.rooms.map((r) => {
      if (r.pinned || (only && !only.has(r.id))) return r;
      const min = minimumSize(params, units, roomDoorNeeds(project, result.plan, r).needs);
      if (min.cols <= r.cols && min.rows <= r.rows) return r;
      grew = true;
      grown.add(r.id);
      return { ...r, cols: Math.max(r.cols, min.cols), rows: Math.max(r.rows, min.rows) };
    });
    if (!grew) break;
    plan = { ...result.plan, rooms };
    result = layoutPlan(plan, project.world, units, only);
  }
  return {
    project: { ...project, architect: result.plan },
    issues: result.issues,
    summary: `layout: placed ${result.placed} room(s) on the map and chose the sides of ${project.architect.links.length} link(s)${grown.size ? `; grew ${grown.size} room(s) to fit their doors and gates (${[...grown].join(", ")})` : ""}`,
  };
}

/** Attempts per room: sub-seeds with the plan's knobs, then plainer rooms. */
const ATTEMPTS = 8;
const PLAIN_ATTEMPTS = 3;

/** The doors a plan room needs: one per link end, with its side, gate and flow, and where the map would like it. */
export function roomDoorNeeds(project: ProjectSpec, plan: ArchitectPlan, room: RoomPlan): { needs: DoorNeed[]; issues: StageIssue[] } {
  const issues: StageIssue[] = [];
  const needs: DoorNeed[] = [];
  const mechanic = new Map(project.progression.abilities.map((a) => [a.id, a.mechanic as string]));
  const position = (id: string) => plan.rooms.find((r) => r.id === id)?.at ?? project.world.rooms.find((r) => r.id === id)?.at;
  for (const { link, here, other } of roomLinks(plan, room.id)) {
    const side = link[here].side;
    if (!side) {
      issues.push({ stage: "geometry", code: "no-side", message: `link ${link.id} has no side in ${room.id}; run the layout stage first`, roomId: room.id, linkId: link.id });
      continue;
    }
    const gate = here === "a" ? link.requires.map((r) => mechanic.get(r)).filter((m): m is MovementAbility => !!m && m in MOVEMENT_ABILITIES) : [];
    const flow = link.oneWay ? (here === "a" ? "out" : "in") : "both";
    // Where the map would like it: facing the other room (its door, if it is pinned and has one).
    let prefer: number | undefined;
    const mine = room.at;
    const there = position(other);
    const otherEnd = here === "a" ? "b" : "a";
    const otherRoom = plan.rooms.find((r) => r.id === other);
    const pinnedDoor = otherRoom?.pinned ? project.world.rooms.find((r) => r.id === other)?.doors.find((d) => d.id === linkDoorId(link.id, otherEnd)) : undefined;
    if (mine && there) {
      const along = side === "left" || side === "right";
      if (pinnedDoor) prefer = along ? there.y + pinnedDoor.offset + pinnedDoor.size - mine.y : there.x + pinnedDoor.offset - mine.x;
      else if (otherRoom) {
        const [a0, a1] = along ? [mine.y, mine.y + room.rows] : [mine.x, mine.x + room.cols];
        const [b0, b1] = along ? [there.y, there.y + otherRoom.rows] : [there.x, there.x + otherRoom.cols];
        const lo = Math.max(a0, b0);
        const hi = Math.min(a1, b1);
        if (hi > lo) prefer = Math.round((lo + hi) / 2) - (along ? mine.y : mine.x) + (along ? 2 : -2);
      }
    }
    needs.push({ id: linkDoorId(link.id, here), side, gate: [...new Set(gate)], flow, ...(prefer !== undefined && { prefer }) });
  }
  return { needs, issues };
}

/** The request for composing a plan room. */
export function roomRequest(room: RoomPlan, doors: DoorNeed[]): RoomRequest {
  return {
    cols: room.cols,
    rows: room.rows,
    seed: room.seed,
    terrain: room.terrain,
    fight: room.contents.some((c) => c.kind === "enemy" && c.lockRoom),
    doors,
  };
}

/** Compose and prove a room: the first attempt the checker proves, else the one with the fewest problems. */
export function buildRoom(req: RoomRequest, params: MovementParams, options: { ledgeThickness?: number } = {}): { built: Composed | null; proof: Proof | null; attempts: number; errors: string[] } {
  let best: { built: Composed; proof: Proof } | null = null;
  const errors: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS + PLAIN_ATTEMPTS; attempt++) {
    const out = composeRoom(req, params, attempt, attempt >= ATTEMPTS);
    if ("error" in out) {
      errors.push(out.error);
      continue;
    }
    const doors = out.doors.map((d) => {
      const need = req.doors.find((n) => n.id === d.id)!;
      return { ...d, gate: need.gate, flow: need.flow };
    });
    const proof = proveRoom(out.grid, doors, params, options);
    if (proof.ok) return { built: out, proof, attempts: attempt + 1, errors };
    if (!best || proof.problems.length < best.proof.problems.length) best = { built: out, proof };
  }
  return { built: best?.built ?? null, proof: best?.proof ?? null, attempts: ATTEMPTS + PLAIN_ATTEMPTS, errors };
}

export function geometryStage(project: ProjectSpec, options: StageOptions = {}): StageOutcome {
  const params = playerMovement(project);
  if (!params) return { project, issues: [{ stage: "geometry", code: "no-player", message: "the project has no player character to build rooms for" }], summary: "geometry: no player" };
  const plan = project.architect;
  const ids = stageRooms(project, options);
  if (!ids.length) return unchanged(project, "geometry: no rooms to build");
  const issues: StageIssue[] = [];
  const built = new Map<string, WorldRoom>();
  let tries = 0;
  for (const id of ids) {
    const room = plan.rooms.find((r) => r.id === id)!;
    const { needs, issues: doorIssues } = roomDoorNeeds(project, plan, room);
    issues.push(...doorIssues);
    const result = buildRoom(roomRequest(room, needs), params, { ledgeThickness: project.world.ledgeThickness });
    tries += result.attempts;
    if (!result.built) {
      issues.push({ stage: "geometry", code: "room-unbuilt", message: `couldn't build ${id}: ${[...new Set(result.errors)].slice(0, 3).join("; ")}`, roomId: id });
      continue;
    }
    if (!result.proof?.ok) {
      issues.push({ stage: "geometry", code: "room-unproven", message: `${id}: ${result.proof?.problems.slice(0, 3).join("; ")}`, roomId: id });
    }
    const existing = project.world.rooms.find((r) => r.id === id);
    const doors: Door[] = result.built.doors.map((d) => ({ id: d.id, side: d.side, offset: d.offset, size: d.size, to: null }));
    const sameTiles = existing && JSON.stringify(existing.grid.rows) === JSON.stringify(result.built.grid.rows);
    built.set(id, {
      id,
      name: room.name,
      grid: result.built.grid,
      at: room.at ?? existing?.at ?? { x: 0, y: 0 },
      doors,
      spawns: [],
      dressing: sameTiles ? (existing?.dressing ?? null) : null,
      regionId: room.regionId,
      props: [],
      handlers: [],
    });
  }

  // Connect doors: to the other end's door, rebuilt now or already in the world.
  const rooms = project.world.rooms.map((r) => built.get(r.id) ?? r);
  for (const r of built.values()) if (!project.world.rooms.some((w) => w.id === r.id)) rooms.push(r);
  const byId = new Map(rooms.map((r) => [r.id, r]));
  for (const r of built.values()) {
    for (const { link, here, other } of roomLinks(plan, r.id)) {
      const door = r.doors.find((d) => d.id === linkDoorId(link.id, here));
      if (!door) continue;
      const otherEnd = here === "a" ? "b" : "a";
      const target = byId.get(other)?.doors.find((d) => d.id === linkDoorId(link.id, otherEnd));
      if (!target) {
        issues.push({ stage: "geometry", code: "door-unlinked", message: `${other} has no door ${linkDoorId(link.id, otherEnd)} for link ${link.id}`, roomId: r.id, linkId: link.id });
        continue;
      }
      if (target.side !== OPPOSITE[door.side]) {
        issues.push({ stage: "geometry", code: "door-sides", message: `link ${link.id}: ${r.id}'s door is on the ${door.side}, ${other}'s on the ${target.side}`, roomId: r.id, linkId: link.id });
        continue;
      }
      if (!built.has(other) && (target.to?.room !== r.id || target.to.door !== door.id)) {
        issues.push({ stage: "geometry", code: "door-unlinked", message: `${other}'s door ${target.id} doesn't lead back to ${r.id}; link ${link.id} is one-sided`, roomId: r.id, linkId: link.id });
        continue;
      }
      door.to = { room: other, door: target.id };
    }
  }
  // Doors elsewhere that led into rebuilt rooms must still be led back to; unpinned rooms' broken ones lead nowhere now,
  // pinned rooms are never changed (reported).
  const pinned = new Set(plan.rooms.filter((r) => r.pinned).map((r) => r.id));
  const linkedBack = (from: string, d: Door) => {
    if (!d.to || !built.has(d.to.room)) return true;
    const t = built.get(d.to.room)!.doors.find((x) => x.id === d.to!.door);
    return !!t && t.to?.room === from && t.to.door === d.id;
  };
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i]!;
    if (built.has(r.id)) continue;
    const broken = r.doors.filter((d) => !linkedBack(r.id, d));
    if (!broken.length) continue;
    if (pinned.has(r.id)) {
      for (const d of broken) issues.push({ stage: "geometry", code: "door-dangling", message: `pinned room ${r.id}'s door ${d.id} leads to ${d.to!.room}/${d.to!.door}, which doesn't lead back`, roomId: r.id });
      continue;
    }
    rooms[i] = { ...r, doors: r.doors.map((d) => (linkedBack(r.id, d) ? d : { ...d, to: null })) };
  }

  const next = { ...project, world: { ...project.world, rooms } };
  const parsed = ProjectSpec.safeParse(next);
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { project, issues: [...issues, { stage: "geometry", code: "invalid-result", message: why }], summary: "geometry: the built world didn't validate; nothing changed" };
  }
  const unproven = issues.filter((i) => i.code === "room-unproven" || i.code === "room-unbuilt").length;
  return { project: parsed.data, issues, summary: `geometry: built ${built.size} room(s), ${built.size - unproven} proven by the checker (${tries} attempt(s))` };
}
