import type { ProjectSpec } from "./schema.ts";

/**
 * Semantic checks the schema can't express. A project with warnings is still
 * valid and playable; warnings flag likely mistakes (for the AI and, later,
 * the UI).
 */

export type WarningCode =
  | "spawn_out_of_bounds"
  | "spawn_inside_platform"
  | "unplaced_character"
  | "unreachable_state"
  | "endless_state";

export interface ProjectWarning {
  code: WarningCode;
  message: string;
  /** Dotted path to the offending part of the project. */
  path: string;
}

/** Actions meant to be temporary: without a way out the character is stuck doing them. */
const TEMPORARY_ACTIONS = new Set(["charge", "telegraph"]);

export function lintProject(project: ProjectSpec): ProjectWarning[] {
  const warnings: ProjectWarning[] = [];
  const { sandbox } = project;

  sandbox.spawns.forEach((spawn, i) => {
    const path = `sandbox.spawns.${i}`;
    if (spawn.x < 0 || spawn.x > sandbox.width || spawn.y < 0 || spawn.y > sandbox.height) {
      warnings.push({
        code: "spawn_out_of_bounds",
        path,
        message: `spawn "${spawn.id}" at (${spawn.x}, ${spawn.y}) is outside the ${sandbox.width}x${sandbox.height} arena`,
      });
    }
    // Feet strictly inside a solid (not resting on its top edge) means stuck in it.
    const embedded = sandbox.platforms.find(
      (p) => spawn.x > p.x && spawn.x < p.x + p.width && spawn.y > p.y + 1 && spawn.y < p.y + p.height,
    );
    if (embedded) {
      warnings.push({
        code: "spawn_inside_platform",
        path,
        message: `spawn "${spawn.id}" at (${spawn.x}, ${spawn.y}) is inside a platform; put its feet on the platform's top (y = ${embedded.y})`,
      });
    }
  });

  project.characters.forEach((character, i) => {
    if (character.kind !== "enemy") return;
    if (!sandbox.spawns.some((s) => s.characterId === character.id)) {
      warnings.push({
        code: "unplaced_character",
        path: `characters.${i}`,
        message: `"${character.id}" has no spawn, so it won't appear in the arena (use addSpawn)`,
      });
    }

    const { behavior } = character;
    const reachable = new Set([behavior.initial]);
    const queue = [behavior.initial];
    while (queue.length > 0) {
      for (const t of behavior.states[queue.shift()!]?.transitions ?? []) {
        if (!reachable.has(t.to)) {
          reachable.add(t.to);
          queue.push(t.to);
        }
      }
    }
    for (const [stateId, state] of Object.entries(behavior.states)) {
      const path = `characters.${i}.behavior.states.${stateId}`;
      if (!reachable.has(stateId)) {
        warnings.push({
          code: "unreachable_state",
          path,
          message: `"${character.id}" state "${stateId}" can never be reached from "${behavior.initial}"`,
        });
      }
      if (TEMPORARY_ACTIONS.has(state.action.type) && state.transitions.length === 0) {
        warnings.push({
          code: "endless_state",
          path,
          message: `"${character.id}" state "${stateId}" (${state.action.type}) has no transitions, so it never ends`,
        });
      }
    }
  });

  return warnings;
}
