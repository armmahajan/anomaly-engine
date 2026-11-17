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

  const characters = new Set(project.characters.map((c) => c.id));
  const toCast = [...new Set(plan.rooms.flatMap((r) => r.contents.flatMap((c) => (c.kind === "enemy" && !characters.has(c.characterId) ? [c.characterId] : []))))];
  for (const room of plan.rooms) {
    if (room.contents.some((c) => c.kind === "enemy" && c.lockRoom) && room.terrain.open < 0.4) {
      issue("cramped-arena", `room "${room.id}" locks its doors for a fight but has little open floor (terrain.open ${room.terrain.open})`, room.id);
    }
  }
  return { issues, toCast };
}
