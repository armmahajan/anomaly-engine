import type { ProjectSpec } from "../schema.ts";
import { gridSize, gridToSolids, type GridSolid } from "./tiles.ts";

/**
 * What the game runtime is sent: the project without its design documents
 * (wiki, progression), plus geometry derived from the tile grids (size and
 * merged collision rectangles), so collision is computed in one place.
 */
export type RuntimeProject = Omit<ProjectSpec, "sandbox" | "world"> & {
  sandbox: ProjectSpec["sandbox"] & { width: number; height: number; solids: GridSolid[] };
  world: Omit<ProjectSpec["world"], "rooms"> & {
    rooms: (ProjectSpec["world"]["rooms"][number] & { width: number; height: number; solids: GridSolid[] })[];
  };
};

export function toRuntimeProject(project: ProjectSpec): RuntimeProject {
  const thickness = project.world.ledgeThickness;
  return {
    ...project,
    wiki: { pages: [] },
    progression: { abilities: [], regions: [], connections: [], beats: [] },
    sandbox: { ...project.sandbox, ...gridSize(project.sandbox.grid), solids: gridToSolids(project.sandbox.grid, thickness) },
    world: {
      ...project.world,
      rooms: project.world.rooms.map((room) => ({ ...room, ...gridSize(room.grid), solids: gridToSolids(room.grid, thickness) })),
    },
  };
}
