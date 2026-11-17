import { createDefaultProject, type ProjectSpec } from "../src/index.ts";

/** `project` as saved before v6, when the arena (its first room) was `sandbox`, outside the world. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function legacy(project: ProjectSpec = createDefaultProject(), schemaVersion = 5): any {
  const [arena, ...rooms] = project.world.rooms;
  const { gravity, backgroundColor, platformColor, playtest, start, ...world } = project.world;
  const player = { id: "player_1", characterId: "player", x: playtest?.x ?? 160, y: playtest?.y ?? 0 };
  return JSON.parse(
    JSON.stringify({
      ...project,
      schemaVersion,
      world: { ...world, start: start?.room === arena!.id ? null : start, rooms },
      sandbox: { gravity, backgroundColor, platformColor, grid: arena!.grid, playerAbilities: playtest?.abilities ?? [], spawns: [player, ...arena!.spawns], dressing: arena!.dressing },
    }),
  );
}
