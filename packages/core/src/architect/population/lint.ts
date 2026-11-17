import type { ProjectSpec } from "../../schema.ts";
import type { Effect, Handler } from "../../events/events.ts";
import { allHandlers, type DomainWarning } from "../../events/lint.ts";
import { grantsAbility } from "../../progression/lint.ts";
import { progressionReport } from "../../progression/report.ts";
import { checkGame } from "../../world/logic/check.ts";
import type { WorldRoom } from "../../world/world.ts";

/**
 * Legibility lints: is it apparent to the player what they got, and what they
 * have to do to get it?
 *
 * silent_grant: a handler gives a movement ability (grantAbility) with no
 *   message: nothing in the same handler (or a twin handler on the same thing
 *   for the same event and conditions) shows a modal or ends the game with one.
 *   Abilities have no other sign (items show on the HUD's items row, so a
 *   giveItem is never silent).
 *
 * skippable_guardian: an enemy whose death gives an ability on the
 *   progression's critical path, in a room the player can leave onward without
 *   beating it. Proven with the logic checker on the real game: with the
 *   guardian gone (never beaten, so never granting) the player reaches rooms
 *   that are only reachable through its room. Those rooms are "onward". Its
 *   death counts through its own enemyKilled handlers, the room's or the
 *   world's enemyKilled for it (by spawn or character), and the room's
 *   roomCleared (every enemy in the room is then a guardian). Only runs the
 *   checker when such an enemy exists.
 */
export function lintLegibility(project: ProjectSpec): DomainWarning[] {
  return [...silentGrants(project), ...skippableGuardians(project)];
}

const shows = (h: Handler) => h.do.some((e) => e.type === "showModal" || (e.type === "endGame" && e.modal !== undefined));
const same = (a: Handler, b: Handler) => JSON.stringify([a.on, a.when]) === JSON.stringify([b.on, b.when]);

export function silentGrants(project: ProjectSpec): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  for (const { path, handlers } of allHandlers(project)) {
    handlers.forEach((h, i) => {
      const abilities = h.do.flatMap((e) => (e.type === "grantAbility" ? [e.ability] : []));
      if (!abilities.length || shows(h) || handlers.some((o) => o !== h && same(o, h) && shows(o))) return;
      warnings.push({
        code: "silent_grant",
        path: `${path}.${i}`,
        message: `${owner(project, path)} grants ${abilities.join(", ")} on ${h.on.type} with no message: the player isn't told they can now ${abilities.length > 1 ? "do more" : "use it"}. Show a modal ("You got ...") in the same handler`,
      });
    });
  }
  return warnings;
}

/** "spawn "queen" (cinder_queen) in room "hollow_3"" from a handlers path. */
function owner(project: ProjectSpec, path: string): string {
  const m = /^world\.rooms\.(\d+)(?:\.(props|spawns)\.(\d+))?\.handlers$/.exec(path);
  if (!m) return "the world";
  const room = project.world.rooms[Number(m[1])]!;
  if (m[2] === "spawns") {
    const s = room.spawns[Number(m[3])]!;
    return `spawn "${s.id}" (${s.characterId}) in room "${room.id}"`;
  }
  if (m[2] === "props") return `prop "${room.props[Number(m[3])]!.id}" in room "${room.id}"`;
  return `room "${room.id}"`;
}

/** Recent results by what they depend on (lint runs on every edit; most edits don't touch the world). */
const recent = new Map<string, DomainWarning[]>();
const RECENT = 16;

export function skippableGuardians(project: ProjectSpec): DomainWarning[] {
  if (!project.progression.abilities.length || !(project.world.start ?? project.world.playtest)) return [];
  const key = JSON.stringify([project.world, project.characters, project.progression]);
  let found = recent.get(key);
  if (!found) {
    found = findSkippableGuardians(project);
    recent.set(key, found);
    if (recent.size > RECENT) recent.delete(recent.keys().next().value!);
  }
  return found.map((w) => ({ ...w }));
}

function findSkippableGuardians(project: ProjectSpec): DomainWarning[] {
  const { world, progression } = project;
  const critical = progressionReport(project)
    .criticalPath.map((id) => progression.abilities.find((a) => a.id === id))
    .filter((a) => a !== undefined);
  if (!critical.length) return [];
  const begin = world.start ?? world.playtest;
  if (!begin) return [];
  const grants = (effects: Effect[]) => critical.filter((a) => effects.some((e) => grantsAbility(a, e))).map((a) => a.id);
  const handled = (list: Handler[], type: string, match: (h: Handler) => boolean) => list.filter((h) => h.on.type === type && match(h)).flatMap((h) => h.do);

  const warnings: DomainWarning[] = [];
  world.rooms.forEach((room, r) => {
    const cleared = grants([...handled(room.handlers, "roomCleared", () => true), ...handled(world.handlers, "roomCleared", (h) => "room" in h.on && h.on.room === room.id)]);
    const guardians = room.spawns.flatMap((s, i) => {
      const given = new Set([
        ...grants(handled(s.handlers, "enemyKilled", () => true)),
        ...grants(handled(room.handlers, "enemyKilled", (h) => h.on.type === "enemyKilled" && (h.on.spawn === s.id || h.on.character === s.characterId))),
        ...grants(handled(world.handlers, "enemyKilled", (h) => h.on.type === "enemyKilled" && h.on.character === s.characterId)),
        ...cleared,
      ]);
      return given.size ? [{ spawn: s, index: i, gives: [...given] }] : [];
    });
    if (!guardians.length) return;

    // The game with the guardians never beaten (gone, and nothing fires for the room being cleared while they'd live) ...
    const ids = new Set(guardians.map((g) => g.spawn.id));
    const without: WorldRoom = { ...room, spawns: room.spawns.filter((s) => !ids.has(s.id)), handlers: room.handlers.filter((h) => h.on.type !== "roomCleared") };
    const variant: ProjectSpec = {
      ...project,
      world: {
        ...world,
        handlers: world.handlers.filter((h) => !(h.on.type === "roomCleared" && h.on.room === room.id)),
        rooms: world.rooms.map((x) => (x.id === room.id ? without : x)),
      },
    };
    const reached = checkGame(variant).reachableRooms;
    // ... against the game without the room at all: what is only reachable through it.
    let around: string[] = [];
    if (begin.room !== room.id) {
      const rooms = world.rooms.filter((x) => x.id !== room.id).map((x) => ({ ...x, doors: x.doors.map((d) => (d.to?.room === room.id ? { ...d, to: null } : d)) }));
      around = checkGame({ ...project, world: { ...world, rooms, playtest: world.playtest?.room === room.id ? null : world.playtest } }).reachableRooms;
    }
    const onward = reached.filter((id) => id !== room.id && !around.includes(id));
    if (!onward.length) return;
    for (const g of guardians) {
      const name = project.characters.find((c) => c.id === g.spawn.characterId)?.name ?? g.spawn.characterId;
      const what = g.gives.map((id) => progression.abilities.find((a) => a.id === id)?.name ?? id).join(", ");
      warnings.push({
        code: "skippable_guardian",
        path: `world.rooms.${r}.spawns.${g.index}`,
        message: `${name} (spawn "${g.spawn.id}" in room "${room.id}") gives ${what}, which the game can't be finished without, but its room can be left onward (to ${onward.slice(0, 3).join(", ")}) without beating it, so nothing tells the player they must fight it. Seal the room while it lives (barriers over the doors until it falls)`,
      });
    }
  });
  return warnings;
}
