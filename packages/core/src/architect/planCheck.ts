import type { ProjectSpec } from "../schema.ts";
import { roomLinks, type RoomContent } from "./plan.ts";
import type { StageIssue } from "./stages.ts";

/**
 * Static checks of the plan before anything is built: what the plan stage (the
 * model or the creator) must fix. Issues are "plan" stage issues. Characters the
 * plan names that don't exist yet are fine: the cast stage creates them (listed in
 * `toCast`).
 */
export function planIssues(project: ProjectSpec): { issues: StageIssue[]; toCast: string[] } {
  const plan = project.architect;
  const p = project.progression;
  const issues: StageIssue[] = [];
  const issue = (code: string, message: string, roomId?: string) => issues.push({ stage: "plan", code, message, ...(roomId ? { roomId } : {}) });

  if (plan.rooms.length === 0) {
    issue("no-rooms", "the plan has no rooms (start from the progression: seedArchitectPlan)");
    return { issues, toCast: [] };
  }
  for (const region of p.regions) {
    if (!plan.rooms.some((r) => r.regionId === region.id)) issue("empty-region", `region "${region.id}" has no rooms`);
  }
  const contents = (kind: RoomContent["kind"]) => plan.rooms.filter((r) => r.contents.some((c) => c.kind === kind));
  const starts = contents("start");
  if (starts.length !== 1) issue("start", `the plan needs exactly one room with a start (has ${starts.length}: ${starts.map((r) => r.id).join(", ") || "none"})`);
  if (contents("ending").length === 0) issue("ending", "no room has the ending");
  if (starts[0] && p.start && starts[0].regionId !== p.start) issue("start-region", `the start is in "${starts[0].regionId}" but the progression starts in "${p.start}"`, starts[0].id);
  for (const room of contents("ending")) {
    if (p.ending && room.regionId !== p.ending) issue("ending-region", `the ending is in "${room.regionId}" but the progression ends in "${p.ending}"`, room.id);
  }

  // Every room joined to the start by links (gates aside: the checker proves those later).
  if (starts[0]) {
    const seen = new Set([starts[0].id]);
    for (const id of seen) for (const { other } of roomLinks(plan, id)) seen.add(other);
    for (const room of plan.rooms) if (!seen.has(room.id)) issue("unlinked", `room "${room.id}" isn't linked to the rest of the world`, room.id);
  }

  // Every ability the progression places is granted somewhere in its region.
  const granted = new Map<string, string[]>();
  for (const room of plan.rooms) {
    for (const c of room.contents) {
      const ids = c.kind === "pickup" ? [c.grants] : c.kind === "enemy" ? c.grants : [];
      for (const id of ids) granted.set(id, [...(granted.get(id) ?? []), room.id]);
    }
  }
  for (const ability of p.abilities) {
    const rooms = granted.get(ability.id) ?? [];
    if (ability.obtainedIn && rooms.length === 0) issue("ungranted", `nothing gives "${ability.id}" (the progression puts it in "${ability.obtainedIn.regionId}")`);
    if (rooms.length > 1) issue("granted-twice", `"${ability.id}" is given in ${rooms.length} rooms: ${rooms.join(", ")}`, rooms[1]);
    for (const id of rooms) {
      const room = plan.rooms.find((r) => r.id === id)!;
      if (ability.obtainedIn && room.regionId !== ability.obtainedIn.regionId) {
        issue("grant-region", `"${ability.id}" is given in "${room.regionId}" but the progression puts it in "${ability.obtainedIn.regionId}"`, id);
      }
    }
  }

  // Region joins: every progression connection has a link between its regions with the same requirements.
  for (const c of p.connections) {
    const joins = plan.links.filter((l) => {
      const ra = plan.rooms.find((r) => r.id === l.a.room)?.regionId;
      const rb = plan.rooms.find((r) => r.id === l.b.room)?.regionId;
      return (ra === c.from && rb === c.to) || (!c.oneWay && ra === c.to && rb === c.from);
    });
    if (joins.length === 0) issue("missing-join", `no link joins "${c.from}" to "${c.to}" (progression connection "${c.id}")`);
    else if (c.requires.length && !joins.some((l) => c.requires.every((r) => l.requires.includes(r)))) {
      issue("ungated-join", `the links from "${c.from}" to "${c.to}" don't require ${c.requires.join(", ")} as connection "${c.id}" does`);
    }
    const alsoOpen = p.connections.some((o) => o.requires.length === 0 && ((o.from === c.from && o.to === c.to) || (o.from === c.to && o.to === c.from)));
    if (c.requires.length && !alsoOpen) {
      const open = joins.filter((l) => !c.requires.every((r) => l.requires.includes(r)));
      for (const l of open) issue("gate-bypass-link", `link "${l.id}" joins "${c.from}" and "${c.to}" without ${c.requires.join(", ")}`, l.a.room);
    }
  }

  // Routes around a gate. Built links gate only the a -> b direction (from b you just drop or walk back
  // through), and one-way links go a -> b only. A region a connection gates must stay unreachable without
  // its requirements, whichever links lead there.
  for (const leak of gateLeaks(project)) {
    issue("gate-bypass-route", `${leak.to} can be reached without ${leak.requires.join(" + ")} (connection "${leak.connection}") through link${leak.links.length > 1 ? "s" : ""} ${leak.links.join(", ")}: a link back to an earlier region must be oneWay from the later room (a) down to the earlier room (b), or gated in that direction`, leak.roomId);
  }

  const characters = new Set(project.characters.map((c) => c.id));
  const toCast = [...new Set(plan.rooms.flatMap((r) => r.contents.flatMap((c) => (c.kind === "enemy" && !characters.has(c.characterId) ? [c.characterId] : []))))];
  for (const room of plan.rooms) {
    if (room.contents.some((c) => c.kind === "enemy" && c.lockRoom) && room.terrain.open < 0.4) {
      issue("cramped-arena", `room "${room.id}" locks its doors for a fight but has little open floor (terrain.open ${room.terrain.open})`, room.id);
    }
  }
  return { issues, toCast };
}

/**
 * Progression connections whose gate the plan's links get around: the `to` region is reachable from the
 * start region without the connection's requirements (everything else allowed), walking the plan's links
 * as geometry builds them. `links` are the region-crossing links used on the way in.
 */
export function gateLeaks(project: ProjectSpec): { connection: string; to: string; requires: string[]; links: string[]; roomId?: string }[] {
  const plan = project.architect;
  const p = project.progression;
  const start = plan.rooms.find((r) => r.contents.some((c) => c.kind === "start"));
  if (!start) return [];
  const region = new Map(plan.rooms.map((r) => [r.id, r.regionId]));
  const leaks: { connection: string; to: string; requires: string[]; links: string[]; roomId?: string }[] = [];
  for (const c of p.connections.filter((c) => c.requires.length > 0)) {
    const lacking = new Set(c.requires);
    // Breadth first over rooms; remember the region-crossing link that first reached each room.
    const via = new Map<string, string | null>([[start.id, null]]);
    const queue = [start.id];
    for (let i = 0; i < queue.length; i++) {
      const here = queue[i]!;
      for (const l of plan.links) {
        const forward = l.a.room === here && !l.requires.some((r) => lacking.has(r));
        const backward = l.b.room === here && !l.oneWay;
        if (!forward && !backward) continue;
        const next = forward ? l.b.room : l.a.room;
        if (via.has(next)) continue;
        via.set(next, region.get(next) !== region.get(here) ? l.id : via.get(here)!);
        queue.push(next);
      }
    }
    // The progression itself may offer another way in (either/or connections): not a leak then.
    const designed = new Set(p.start ? [p.start] : []);
    for (let grew = true; grew; ) {
      grew = false;
      for (const o of p.connections) {
        if (o.requires.some((r) => lacking.has(r))) continue;
        for (const [x, y] of o.oneWay ? [[o.from, o.to]] : [[o.from, o.to], [o.to, o.from]]) {
          if (designed.has(x!) && !designed.has(y!)) {
            designed.add(y!);
            grew = true;
          }
        }
      }
    }
    const inside = [...via.keys()].find((id) => region.get(id) === c.to);
    if (inside && region.get(start.id) !== c.to && !designed.has(c.to)) {
      const used = via.get(inside);
      const link = plan.links.find((l) => l.id === used);
      leaks.push({ connection: c.id, to: c.to, requires: c.requires, links: used ? [used] : [], ...(link ? { roomId: link.a.room } : {}) });
    }
  }
  return leaks;
}
