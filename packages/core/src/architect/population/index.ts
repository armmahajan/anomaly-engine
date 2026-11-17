import type { ProjectSpec } from "../../schema.ts";
import { unchanged, type StageOptions, type StageOutcome } from "../stages.ts";

/**
 * Population and screens stages (agent L owns this folder).
 *
 * populationStage: turn each unpinned plan room's `contents` into the built world
 * room's spawns, props and handlers, on spots the player can reach (found from the
 * room's traversal graph): enemies on surfaces; `lockRoom` enemies close the room's
 * doors (solid barrier props shown while a flag is unset) until the last falls, then
 * grant their `grants` and set the flag; pickups grant an ability or key item; save
 * points; the world start; the ending (endGame). Everything through existing
 * primitives (props, handlers, items, flags, abilities, modals): nothing role-specific.
 *
 * screensStage: a title screen on gameStarted, an ending screen, a message (modal)
 * for every ability or key the player gets, and the map turned on.
 */
export function populationStage(project: ProjectSpec, _options?: StageOptions): StageOutcome {
  return unchanged(project, "population: not implemented yet");
}

export function screensStage(project: ProjectSpec, _options?: StageOptions): StageOutcome {
  return unchanged(project, "screens: not implemented yet");
}
