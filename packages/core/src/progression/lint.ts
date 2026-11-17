import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";
import type { Effect, Handler } from "../events/events.ts";
import { MOVEMENT_ABILITIES } from "../movement/params.ts";
import type { Ability } from "./progression.ts";

/**
 * The progression against the world, static checks only (it runs on every
 * edit). Silent until some room is in a region, then:
 * - every region has a room;
 * - an ability obtained in a region is given by a handler on one of that
 *   region's rooms, props or spawns: a movement mechanic by grantAbility of
 *   the mechanic; a "key" by giveItem of an item whose id is the ability's id
 *   or its last words (hatch_key <- key); "swim" isn't playable, so unchecked;
 * - every connection has a door between a room of each of its two regions.
 */

/** Does this effect give the player the progression ability (see above)? */
export function grantsAbility(ability: Ability, effect: Effect): boolean {
  if (ability.mechanic === "key") return effect.type === "giveItem" && (effect.item === ability.id || ability.id.endsWith(`_${effect.item}`));
  return effect.type === "grantAbility" && effect.ability === ability.mechanic;
}

/** Where the world gives an ability: "room/prop", "room/spawn" or "room", in any region. */
export function abilityGrants(project: ProjectSpec, ability: Ability): string[] {
  const gives = (handlers: Handler[]) => handlers.some((h) => h.do.some((e) => grantsAbility(ability, e)));
  return project.world.rooms.flatMap((room) => [
    ...(gives(room.handlers) ? [room.id] : []),
    ...[...room.props, ...room.spawns].filter((x) => gives(x.handlers)).map((x) => `${room.id}/${x.id}`),
  ]);
}

export function lintProgressionWorld(project: ProjectSpec): DomainWarning[] {
  const { progression: p, world } = project;
  if (!world.rooms.some((r) => r.regionId)) return [];
  const warnings: DomainWarning[] = [];
  const roomsIn = (regionId: string) => world.rooms.filter((r) => r.regionId === regionId);
  const name = (regionId: string) => p.regions.find((r) => r.id === regionId)?.name ?? regionId;

  p.regions.forEach((region, i) => {
    if (roomsIn(region.id).length === 0) {
      warnings.push({ code: "region_without_rooms", path: `progression.regions.${i}`, message: `region ${region.name} (${region.id}) has no rooms: create rooms for it or set a room's region (updateWorldRoom regionId)` });
    }
  });

  p.abilities.forEach((ability, i) => {
    const regionId = ability.obtainedIn?.regionId;
    const rooms = regionId ? roomsIn(regionId).map((r) => r.id) : [];
    if (rooms.length === 0 || !(ability.mechanic === "key" || ability.mechanic in MOVEMENT_ABILITIES)) return;
    if (abilityGrants(project, ability).some((at) => rooms.includes(at.split("/")[0]!))) return;
    const how = ability.mechanic === "key" ? `a giveItem of an item "${ability.id}"` : `a grantAbility ${ability.mechanic}`;
    warnings.push({
      code: "ability_not_granted",
      path: `progression.abilities.${i}`,
      message: `${ability.name} (${ability.id}) is obtained in ${name(regionId!)}, but none of its rooms gives it: add ${how} to a handler of a prop, spawn or room there (e.g. a pickup prop's touch)`,
    });
  });

  const regionOf = new Map(world.rooms.map((r) => [r.id, r.regionId]));
  p.connections.forEach((c, i) => {
    if (roomsIn(c.from).length === 0 || roomsIn(c.to).length === 0) return;
    // connectDoors joins both doors, but check both directions in case one side was left dangling.
    const joins = (a: string, b: string) => roomsIn(a).some((room) => room.doors.some((d) => d.to && regionOf.get(d.to.room) === b));
    const joined = joins(c.from, c.to) || joins(c.to, c.from);
    if (!joined) {
      warnings.push({
        code: "connection_without_door",
        path: `progression.connections.${i}`,
        message: `connection ${c.id} (${name(c.from)} -> ${name(c.to)}) has no door between their rooms: connectDoors a room of ${c.from} to a room of ${c.to}`,
      });
    }
  });
  return warnings;
}
