import type { ProjectSpec } from "../schema.ts";
import { gridSize, gridToSolids, type GridSolid } from "./tiles.ts";
import { ruleHandlers } from "../events/rules.ts";

/**
 * What the game runtime is sent: the project without its design documents
 * (wiki, progression), plus geometry derived from each room's tiles (size
 * and merged collision rectangles), so collision is computed in one place.
 * The game rules arrive as handlers (presets) before the world's own.
 */
export type RuntimeRoom = ProjectSpec["world"]["rooms"][number] & { width: number; height: number; solids: GridSolid[] };
export type RuntimeProject = Omit<ProjectSpec, "world"> & { world: Omit<ProjectSpec["world"], "rooms"> & { rooms: RuntimeRoom[] } };

export function toRuntimeProject(project: ProjectSpec): RuntimeProject {
  const thickness = project.world.ledgeThickness;
  return {
    ...project,
    wiki: { pages: [] },
    progression: { abilities: [], regions: [], connections: [], beats: [] },
    world: {
      ...project.world,
      handlers: [...ruleHandlers(project.world.rules), ...project.world.handlers],
      rooms: project.world.rooms.map((room) => ({ ...room, ...gridSize(room.grid), solids: gridToSolids(room.grid, thickness) })),
    },
  };
}
