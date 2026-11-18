import type { ProjectSpec } from "../schema.ts";
import { roomLinks, type RoomContent } from "./plan.ts";
import type { StageIssue } from "./stages.ts";
import { designedReach } from "../world/logic/gates.ts";

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
  for (const [id, rooms] of granted) {
    if (rooms.length > 1 && !p.abilities.some((a) => a.id === id)) issue("granted-twice", `"${id}" is given in ${rooms.length} rooms: ${rooms.join(", ")}`, rooms[1]);
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

  // Grants the progression puts behind abilities inside their region (obtainedIn.requires) must be behind them in the plan too.
  for (const g of unguardedGrants(project)) {
    issue("unguarded-grant", `"${g.ability}" is given in room "${g.roomId}", which can be reached without ${g.requires.join(" + ")}; the progression says getting it needs them: put it in a room reached only through a link that requires them`, g.roomId);
  }

  // Weapons the plan gives and gates with (the progression doesn't place them, so the plan alone must be right).
  for (const w of weaponGrantIssues(project)) issue(w.code, w.message, w.roomId);

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
 * start region never having the connection's requirements (other abilities as they're picked up), walking
 * the plan's links as geometry builds them. `links` are the region-crossing links used on the way in.
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
    const reach = planReach(project, lacking);
    // The way in without the requirements: a link walked backwards from outside (its gate is on the far side),
    // else one walked forwards that doesn't require them.
    const entry =
      plan.links.find((l) => !l.oneWay && region.get(l.a.room) === c.to && region.get(l.b.room) !== c.to && reach.has(l.b.room)) ??
      plan.links.find((l) => region.get(l.b.room) === c.to && region.get(l.a.room) !== c.to && reach.has(l.a.room) && !l.requires.some((r) => lacking.has(r)));
    const via = new Map<string, string | null>([...reach].map((id) => [id, entry?.id ?? null]));
    // The progression itself may offer another way in (either/or connections): not a leak then.
    const designed = designedReach(project, lacking);
    const inside = [...via.keys()].find((id) => region.get(id) === c.to);
    if (inside && region.get(start.id) !== c.to && !designed.has(c.to)) {
      const used = via.get(inside);
      const link = plan.links.find((l) => l.id === used);
      leaks.push({ connection: c.id, to: c.to, requires: c.requires, links: used ? [used] : [], ...(link ? { roomId: link.a.room } : {}) });
    }
  }
  return leaks;
}

/**
 * Plan rooms reachable from the start room never having the `lacking` abilities, the way geometry builds
 * links (gated a -> b only; one-way a -> b): abilities and keys are picked up in the rooms reached
 * (pickups, guardians' grants), and a link's gate opens once everything it requires is held.
 */
export function planReach(project: ProjectSpec, lacking: ReadonlySet<string>): Set<string> {
  const plan = project.architect;
  const start = plan.rooms.find((r) => r.contents.some((c) => c.kind === "start"));
  const seen = new Set<string>(start ? [start.id] : []);
  // The loadout's starting weapons are held from the start.
  const have = new Set<string>(startingWeapons(project).filter((w) => !lacking.has(w)));
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of seen) {
      for (const c of byId.get(id)?.contents ?? []) {
        for (const g of c.kind === "pickup" ? [c.grants] : c.kind === "enemy" ? c.grants : []) {
          if (!lacking.has(g) && !have.has(g)) {
            have.add(g);
            grew = true;
          }
        }
      }
    }
    for (const l of plan.links) {
      const forward = seen.has(l.a.room) && !seen.has(l.b.room) && l.requires.every((r) => have.has(r));
      const backward = seen.has(l.b.room) && !seen.has(l.a.room) && !l.oneWay;
      if (forward) seen.add(l.b.room);
      if (backward) seen.add(l.a.room);
      if (forward || backward) grew = true;
    }
  }
  return seen;
}

/** Abilities whose progression source needs other abilities (obtainedIn.requires) but whose plan room can be reached without them. */
export function unguardedGrants(project: ProjectSpec): { ability: string; roomId: string; requires: string[] }[] {
  const out: { ability: string; roomId: string; requires: string[] }[] = [];
  for (const a of project.progression.abilities) {
    const requires = a.obtainedIn?.requires ?? [];
    if (requires.length === 0) continue;
    const room = project.architect.rooms.find((r) => r.contents.some((c) => (c.kind === "pickup" && c.grants === a.id) || (c.kind === "enemy" && c.grants.includes(a.id))));
    if (room && planReach(project, new Set(requires)).has(room.id)) out.push({ ability: a.id, roomId: room.id, requires });
  }
  return out;
}

/** Weapon ids the loadout starts with. */
export const startingWeapons = (project: ProjectSpec): string[] => project.weapons.loadout.slots.flatMap((s) => (s.start ? [s.start] : []));

const grantsOf = (c: RoomContent): string[] => (c.kind === "pickup" ? [c.grants] : c.kind === "enemy" ? c.grants : []);

/**
 * Weapons in the plan (grants and link requirements that are game weapons, not progression abilities;
 * the progression doesn't place weapons, so the plan alone must get them right):
 * - weapon-unreachable: given in a room the player can never reach;
 * - weapon-ungranted: a link needs it but nothing gives it (and the loadout doesn't start with it);
 * - weapon-behind-gate: a link needs it but it is only given past that need (unreachable without it);
 * - weapon-gate-bypass: the room behind a link that needs it is reachable without it (the gate holds nothing back).
 */
export function weaponGrantIssues(project: ProjectSpec): { code: string; message: string; roomId?: string }[] {
  const plan = project.architect;
  const abilities = new Set(project.progression.abilities.map((a) => a.id));
  const weapons = new Set(project.weapons.list.map((w) => w.id).filter((id) => !abilities.has(id)));
  if (weapons.size === 0) return [];
  const out: { code: string; message: string; roomId?: string }[] = [];
  const starting = new Set(startingWeapons(project));
  const givenIn = new Map<string, string[]>();
  for (const room of plan.rooms) {
    for (const id of room.contents.flatMap(grantsOf)) if (weapons.has(id)) givenIn.set(id, [...(givenIn.get(id) ?? []), room.id]);
  }
  const all = planReach(project, new Set());
  for (const [id, rooms] of givenIn) {
    for (const roomId of rooms) if (!all.has(roomId)) out.push({ code: "weapon-unreachable", message: `the weapon "${id}" is given in room "${roomId}", which the player can't reach`, roomId });
  }
  const needed = new Set(plan.links.flatMap((l) => l.requires.filter((r) => weapons.has(r))));
  for (const id of needed) {
    if (starting.has(id)) continue;
    const gates = plan.links.filter((l) => l.requires.includes(id));
    const names = gates.map((l) => l.id).join(", ");
    const rooms = givenIn.get(id) ?? [];
    if (rooms.length === 0) {
      out.push({ code: "weapon-ungranted", message: `${names} need${gates.length > 1 ? "" : "s"} the weapon "${id}", but nothing gives it (a pickup or a guardian's grants) and the loadout doesn't start with it`, roomId: gates[0]!.a.room });
      continue;
    }
    const without = planReach(project, new Set([id]));
    if (!rooms.some((r) => without.has(r))) {
      out.push({ code: "weapon-behind-gate", message: `the weapon "${id}" is needed to pass ${names} but is only given in ${rooms.join(", ")}, which can't be reached without it: give it on the way there`, roomId: rooms[0] });
    }
    for (const l of gates) {
      if (without.has(l.b.room)) out.push({ code: "weapon-gate-bypass", message: `room "${l.b.room}" behind link "${l.id}" (it needs the weapon "${id}") can be reached without it, so the gate holds nothing back`, roomId: l.a.room });
    }
  }
  return out;
}
