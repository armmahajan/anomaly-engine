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
}

export function gateChecks(project: ProjectSpec, base: CheckResult = checkGame(project)): GateCheck[] {
  const { progression, world } = project;
  return progression.connections.flatMap((c) => {
    const needs = c.requires
      .map((id) => progression.abilities.find((a) => a.id === id)?.mechanic)
      .filter((m): m is MovementAbility => !!m && m in MOVEMENT_ABILITIES);
    if (needs.length === 0) return [];
    const far = world.rooms.filter((r) => r.regionId === c.to).map((r) => r.id);
    const without = checkGame(project, { withoutAbilities: needs }).reachableRooms;
    return [{ connection: c.id, from: c.from, to: c.to, needs, holdsWithout: !far.some((r) => without.includes(r)), reachableWith: far.some((r) => base.reachableRooms.includes(r)) }];
  });
}
