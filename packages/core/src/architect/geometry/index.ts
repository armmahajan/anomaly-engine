import type { ProjectSpec } from "../../schema.ts";
import { movementParams, type MovementParams } from "../../movement/params.ts";
import { unchanged, type StageOptions, type StageOutcome } from "../stages.ts";
import { layoutPlan } from "./layout.ts";
import { unitsFor } from "./units.ts";

export { doorCapacity, bandsFit } from "./capacity.ts";
export { unitsFor, type Units } from "./units.ts";

/**
 * Layout and geometry stages (agent K owns this folder).
 *
 * layoutStage: fill each unpinned plan room's map position (`RoomPlan.at`) and every
 * link end's `side`, so linked rooms sit next to each other on the world map and
 * doors face each other. Writes only `project.architect`.
 *
 * geometryStage: for each unpinned plan room (or `options.rooms`), build the world
 * room with the same id: its tile grid (cols x rows) from proven chunks, a door per
 * link end named `linkDoorId(link.id, end)` on the link's side, connected to the
 * other end's door (also when that room is pinned and has the door), `at`,
 * `regionId` and `name` from the plan. Gated links (`requires`) get a proven gate
 * at the `a` end's room (createChunkRoom-style gate chunks), so the far side is
 * unreachable without the abilities and reachable with them. Every door must be
 * reachable from every other door of the room with the abilities the player can
 * have there. Same plan + seed -> same room. Rebuilding clears the room's spawns,
 * props and handlers (population puts them back); pinned rooms are never touched.
 */

/** The player's movement, or null when the project has no player. */
export function playerMovement(project: ProjectSpec): MovementParams | null {
  const player = project.characters.find((c) => c.kind === "player");
  return player && player.kind === "player" ? movementParams(player, project.world.gravity) : null;
}

export function layoutStage(project: ProjectSpec, options: StageOptions = {}): StageOutcome {
  const params = playerMovement(project);
  if (!params) return { project, issues: [{ stage: "layout", code: "no-player", message: "the project has no player character to size rooms by" }], summary: "layout: no player" };
  if (!project.architect.rooms.length) return unchanged(project, "layout: the plan has no rooms");
  const result = layoutPlan(project.architect, project.world, unitsFor(params), options.rooms ? new Set(options.rooms) : undefined);
  return {
    project: { ...project, architect: result.plan },
    issues: result.issues,
    summary: `layout: placed ${result.placed} room(s) on the map and chose the sides of ${project.architect.links.length} link(s)`,
  };
}

export function geometryStage(project: ProjectSpec, _options?: StageOptions): StageOutcome {
  return unchanged(project, "geometry: not implemented yet");
}
