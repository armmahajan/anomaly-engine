import { MIN_WARNING, type Action, type Behavior, type Transition } from "../behavior.ts";
import type { EnemyCharacter, ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";
import { roomSize } from "../world/opHelpers.ts";

/**
 * Fairness checks on every enemy: the player must be able to see an attack
 * coming, dodge it inside the rooms it fights in, and hit back. The schema
 * already forces a windup of at least MIN_WARNING on every attack primitive
 * and a cap on every summon; these catch what it can't.
 */

/** Recovery (s) after a strike long enough to answer with a sword swing. */
const OPENING = 0.3;

/** Actions that hurt or can't be hurt: a behavior made only of these never lets the player hit back. */
function isOpening(action: Action): boolean {
  switch (action.type) {
    case "charge":
    case "shoot":
    case "leap":
    case "slam":
    case "teleport":
      return false;
    case "strike":
      return action.recovery >= OPENING;
    default:
      return true;
  }
}

/** Horizontal px an action can carry the enemy from where it starts (or from home). */
function reach(action: Action): number {
  switch (action.type) {
    case "leap":
      return action.maxDistance;
    case "jump":
      return action.distance;
    case "teleport":
      return action.to === "behindPlayer" ? action.range : action.to === "random" ? action.range * 2 : 0;
    default:
      return 0;
  }
}

function reachableStates(behavior: Behavior): Set<string> {
  const reachable = new Set([behavior.initial, ...behavior.interrupts.map((t) => t.to)]);
  const queue = [...reachable];
  while (queue.length > 0) {
    for (const t of behavior.states[queue.shift()!]?.transitions ?? []) {
      if (!reachable.has(t.to)) {
        reachable.add(t.to);
        queue.push(t.to);
      }
    }
  }
  return reachable;
}

/** A transition out of a telegraph that waits at least MIN_WARNING first. */
const warned = (from: Action | undefined, t: Transition) =>
  from?.type === "telegraph" && [t.when, ...(t.and ?? [])].some((c) => c.type === "after" && c.seconds >= MIN_WARNING);

export function lintCombat(project: ProjectSpec): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  const enemies = new Map(project.characters.flatMap((c) => (c.kind === "enemy" ? [[c.id, c] as const] : [])));
  const summons = (c: EnemyCharacter) => Object.values(c.behavior.states).flatMap((s) => (s.action.type === "summon" ? [s.action] : []));

  project.characters.forEach((character, i) => {
    if (character.kind !== "enemy") return;
    const { behavior, stats } = character;
    const at = `characters.${i}`;
    const name = `"${character.id}"`;

    if (stats.contactDamage > 0 && stats.knockback === 0) {
      warnings.push({
        code: "contact_no_knockback",
        path: `${at}.stats`,
        message: `${name} hurts on touch but has knockback 0: the player isn't thrown clear and is hurt again each time their invulnerability ends`,
      });
    }

    const reachable = reachableStates(behavior);
    const states = [...reachable].flatMap((id) => (behavior.states[id] ? [[id, behavior.states[id]] as const] : []));
    if (states.length > 0 && !states.some(([, s]) => isOpening(s.action))) {
      warnings.push({
        code: "no_opening",
        path: `${at}.behavior`,
        message: `${name} is always attacking or untouchable: give it a state to recover in (wait, a telegraph, or a strike recovery of at least ${OPENING} s)`,
      });
    }

    // A charge hurts by contact the moment it starts: it needs a telegraph before it.
    const into = (id: string) => behavior.states[id]?.action.type === "charge";
    if (into(behavior.initial)) {
      warnings.push({ code: "unwarned_attack", path: `${at}.behavior.initial`, message: `${name} starts in a charge with no warning: start in a telegraph instead` });
    }
    behavior.interrupts.forEach((t, j) => {
      if (into(t.to)) {
        warnings.push({ code: "unwarned_attack", path: `${at}.behavior.interrupts.${j}`, message: `${name} can charge from any state without a warning: interrupt into a telegraph instead` });
      }
    });
    for (const [id, state] of Object.entries(behavior.states)) {
      state.transitions.forEach((t, j) => {
        if (into(t.to) && !warned(state.action, t)) {
          warnings.push({
            code: "unwarned_attack",
            path: `${at}.behavior.states.${id}.transitions.${j}`,
            message: `${name} charges ("${t.to}") from "${id}" without a warning: go through a telegraph for at least ${MIN_WARNING} s (after) first`,
          });
        }
      });
    }

    const rooms = project.world.rooms.filter((r) => r.spawns.some((s) => s.characterId === character.id));
    for (const [id, state] of states) {
      const path = `${at}.behavior.states.${id}.action`;
      const { action } = state;
      const tooFar = rooms.find((room) => reach(action) > roomSize(room).width - character.size.width);
      if (tooFar) {
        warnings.push({
          code: "range_exceeds_room",
          path,
          message: `${name} state "${id}" (${action.type}) reaches ${reach(action)} px, more than room "${tooFar.id}" is wide (${roomSize(tooFar).width} px): the player can't get out of its way`,
        });
      }
      if (action.type === "leap" && character.movement === "flying") {
        warnings.push({ code: "movement_mismatch", path, message: `${name} state "${id}" uses leap, but ${name} is flying: flyers can't leap` });
      }
      if (action.type === "summon") {
        const summoned = enemies.get(action.character);
        if (!summoned) {
          warnings.push({ code: "summon_unknown", path, message: `${name} state "${id}" summons "${action.character}", which is not an enemy character` });
        } else if (summons(summoned).length > 0) {
          warnings.push({
            code: "summon_chain",
            path,
            message: `${name} summons "${summoned.id}", which summons too: each summon's cap is its own, so the count multiplies`,
          });
        }
      }
    }
  });
  return warnings;
}
