import type { ProjectSpec } from "../../schema.ts";
import { MOVEMENT_ABILITIES, type MovementAbility } from "../../movement/params.ts";
import { checkGame, type CheckResult } from "./check.ts";

/**
 * Do the progression's ability gates hold in the built game? For each
 * connection that needs a movement ability, the checker must reach a room of
 * the far region with the ability and none without it. (Key gates need no
 * extra check: a key that can't be had makes the game unbeatable or leaves a
 * dead state, which checkGame reports.)
 */
export interface GateCheck {
  connection: string;
  from: string;
  to: string;
  needs: MovementAbility[];
  /** No room of `to` is reachable without the abilities. */
  holdsWithout: boolean;
  /** Some room of `to` is reachable in the game as it is. */
  reachableWith: boolean;
  /** The progression reaches `to` another way without these abilities: nothing to hold. */
  shortcut?: boolean;
}

/**
 * Regions the progression reaches from its start never having the `lacking` abilities: the player only
 * gets an ability once its region is reached and its own needs (obtainedIn.requires) are met, and
 * passes a connection only with everything it requires (both ways unless one-way).
 */
export function designedReach(project: ProjectSpec, lacking: ReadonlySet<string>): Set<string> {
  const p = project.progression;
  const reached = new Set(p.start ? [p.start] : []);
  const have = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of p.abilities) {
      if (have.has(a.id) || lacking.has(a.id) || !a.obtainedIn || !reached.has(a.obtainedIn.regionId)) continue;
      if (a.obtainedIn.requires.every((r) => have.has(r))) {
        have.add(a.id);
        grew = true;
      }
    }
    for (const o of p.connections) {
      if (!o.requires.every((r) => have.has(r))) continue;
      for (const [x, y] of o.oneWay ? [[o.from, o.to]] : [[o.from, o.to], [o.to, o.from]]) {
        if (reached.has(x!) && !reached.has(y!)) {
          reached.add(y!);
          grew = true;
        }
      }
    }
  }
  return reached;
}

export function gateChecks(project: ProjectSpec, base: CheckResult = checkGame(project), maxStates?: number): GateCheck[] {
  const { progression, world } = project;
  return progression.connections.flatMap((c) => {
    const needs = c.requires
      .map((id) => progression.abilities.find((a) => a.id === id)?.mechanic)
      .filter((m): m is MovementAbility => !!m && m in MOVEMENT_ABILITIES);
    if (needs.length === 0) return [];
    // The design may offer another way in without these abilities (an either/or route, or a shortcut that
    // only opens later): then the region is meant to be reachable without them and this gate is a shortcut.
    const lacking = new Set(progression.abilities.filter((a) => (needs as string[]).includes(a.mechanic)).map((a) => a.id));
    if (designedReach(project, lacking).has(c.to)) {
      return [{ connection: c.id, from: c.from, to: c.to, needs, holdsWithout: true, reachableWith: true, shortcut: true }];
    }
    const far = world.rooms.filter((r) => r.regionId === c.to).map((r) => r.id);
    const without = checkGame(project, { withoutAbilities: needs, ...(maxStates ? { maxStates } : {}) }).reachableRooms;
    return [{ connection: c.id, from: c.from, to: c.to, needs, holdsWithout: !far.some((r) => without.includes(r)), reachableWith: far.some((r) => base.reachableRooms.includes(r)) }];
  });
}

/**
 * Is each movement ability on the progression's critical path really needed?
 * Wherever the design puts the requirement (a connection, or reaching another
 * ability's source), the game must not be beatable without it.
 */
export interface AbilityCheck {
  ability: string;
  mechanic: MovementAbility;
  /** The game can't be finished without it. */
  needed: boolean;
}

export function abilityChecks(project: ProjectSpec, criticalPath: readonly string[], maxStates?: number): AbilityCheck[] {
  return criticalPath.flatMap((id) => {
    const mechanic = project.progression.abilities.find((a) => a.id === id)?.mechanic;
    if (!mechanic || !(mechanic in MOVEMENT_ABILITIES)) return [];
    const m = mechanic as MovementAbility;
    return [{ ability: id, mechanic: m, needed: !checkGame(project, { withoutAbilities: [m], ...(maxStates ? { maxStates } : {}) }).beatable }];
  });
}
