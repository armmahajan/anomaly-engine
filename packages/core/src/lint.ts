import type { ProjectSpec } from "./schema.ts";
import { lintArt, type ArtWarningCode } from "./art/lint.ts";
import { gridSize, gridToSolids } from "./world/tiles.ts";
import { lintEvents } from "./events/lint.ts";
import { lintProps } from "./props/lint.ts";
import { lintModals } from "./modals/lint.ts";
import { lintCombat } from "./combat/lint.ts";
import { lintProgressionWorld } from "./progression/lint.ts";
import { lintPlatforms } from "./world/platformLint.ts";
import { lintLegibility } from "./architect/population/lint.ts";

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
  | "endless_state"
  | "movement_mismatch"
  | ArtWarningCode
  // Domain lints (events, props, modals, combat) add their own codes.
  | (string & {});

export interface ProjectWarning {
  code: WarningCode;
  message: string;
  /** Dotted path to the offending part of the project. */
  path: string;
}

/** Actions meant to be temporary: without a way out the character is stuck doing them. */
const TEMPORARY_ACTIONS = new Set(["charge", "telegraph"]);

/** Actions that only do something for one movement type. */
const MOVEMENT_ONLY: Record<string, { movement: "ground" | "flying"; otherwise: string }> = {
  jump: { movement: "ground", otherwise: "flyers can't jump" },
  hover: { movement: "flying", otherwise: "ground characters just stand still" },
};

export function lintProject(project: ProjectSpec): ProjectWarning[] {
  const warnings: ProjectWarning[] = [];
  // Spawns (and the playtest spot) must be inside their room and not stuck in a solid.
  const points = project.world.rooms.flatMap((room, r) => [
    ...room.spawns.map((spawn, i) => ({ room, path: `world.rooms.${r}.spawns.${i}`, label: `spawn "${spawn.id}"`, x: spawn.x, y: spawn.y })),
    ...(project.world.playtest?.room === room.id ? [{ room, path: "world.playtest", label: "the playtest spot", x: project.world.playtest.x, y: project.world.playtest.y }] : []),
  ]);
  for (const { room, path, label, x, y } of points) {
    const size = gridSize(room.grid);
    if (x < 0 || x > size.width || y < 0 || y > size.height) {
      warnings.push({ code: "spawn_out_of_bounds", path, message: `${label} at (${x}, ${y}) is outside room "${room.id}" (${size.width}x${size.height})` });
    }
    // Feet strictly inside a solid (not resting on its top edge) means stuck in it.
    const embedded = gridToSolids(room.grid, project.world.ledgeThickness)
      .filter((s) => s.kind !== "oneway")
      .find((p) => x > p.x && x < p.x + p.width && y > p.y + 1 && y < p.y + p.height);
    if (embedded) {
      warnings.push({
        code: "spawn_inside_platform",
        path,
        message: `${label} at (${x}, ${y}) in room "${room.id}" is inside a platform; put its feet on the platform's top (y = ${embedded.y})`,
      });
    }
  }

  const summoned = new Set(project.characters.flatMap((c) => (c.kind === "enemy" ? Object.values(c.behavior.states).flatMap((s) => (s.action.type === "summon" ? [s.action.character] : [])) : [])));
  project.characters.forEach((character, i) => {
    if (character.kind !== "enemy") return;
    const inRooms = summoned.has(character.id) || project.world.rooms.some((r) => r.spawns.some((s) => s.characterId === character.id));
    if (!inRooms) {
      warnings.push({
        code: "unplaced_character",
        path: `characters.${i}`,
        message: `"${character.id}" has no spawn, so it won't appear in any room (use addRoomSpawn)`,
      });
    }

    const { behavior } = character;
    const entry = [behavior.initial, ...behavior.interrupts.map((t) => t.to)];
    const reachable = new Set(entry);
    const queue = [...reachable];
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
      const only = MOVEMENT_ONLY[state.action.type];
      if (only && only.movement !== character.movement) {
        warnings.push({
          code: "movement_mismatch",
          path,
          message: `"${character.id}" state "${stateId}" uses ${state.action.type}, but "${character.id}" is ${character.movement}: ${only.otherwise}`,
        });
      }
      const noWayOut = state.transitions.length === 0 && behavior.interrupts.length === 0;
      if (TEMPORARY_ACTIONS.has(state.action.type) && noWayOut) {
        warnings.push({
          code: "endless_state",
          path,
          message: `"${character.id}" state "${stateId}" (${state.action.type}) has no transitions, so it never ends`,
        });
      }
    }
  });

  warnings.push(...lintArt(project), ...lintEvents(project), ...lintProps(project), ...lintModals(project), ...lintCombat(project), ...lintProgressionWorld(project), ...lintPlatforms(project), ...lintLegibility(project));
  return warnings;
}
