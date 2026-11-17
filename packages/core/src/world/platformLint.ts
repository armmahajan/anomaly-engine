import type { ProjectSpec } from "../schema.ts";
import { movementParams } from "../movement/params.ts";
import { gridCols, gridRows, gridSize, gridToSolids, TILE, tileAt, type TileKind } from "./tiles.ts";
import { standingSurfaces } from "./traversal.ts";

/** Tiles whose top reads as somewhere to stand. */
const STANDABLE: ReadonlySet<TileKind> = new Set(["solid", "ledge", "oneway", "breakable"]);

/**
 * Platforms that look standable but aren't: a run of tile tops with open air above
 * where the player can't stand anywhere (a ceiling too low for the player's height,
 * or something else in the way). They mislead the player, who sees a platform and
 * can never reach it, so every one is a warning.
 */
export function lintPlatforms(project: ProjectSpec): { code: string; message: string; path: string }[] {
  const player = project.characters.find((c) => c.id === "player");
  if (!player) return [];
  if (player.kind !== "player") return [];
  const params = movementParams(player, project.world.gravity);
  const out: { code: string; message: string; path: string }[] = [];
  project.world.rooms.forEach((room, index) => {
    const { grid } = room;
    const size = gridSize(grid);
    const solids = gridToSolids(grid, project.world.ledgeThickness);
    // Standable with the room intact, or once its breakables are smashed (a pocket under a breakable floor).
    const surfaces = [...standingSurfaces(solids, params, size), ...standingSurfaces(solids.filter((s) => s.kind !== "breakable"), params, size)];
    const hw = params.width / 2;
    for (let r = 1; r < gridRows(grid); r++) {
      for (let c = 0; c < gridCols(grid); ) {
        const top = (col: number) => STANDABLE.has(tileAt(grid, col, r)) && tileAt(grid, col, r - 1) === "empty";
        if (!top(c)) {
          c++;
          continue;
        }
        const c0 = c;
        while (c < gridCols(grid) && top(c)) c++;
        const [x0, x1] = [c0 * TILE, c * TILE];
        const y = r * TILE;
        const standable = surfaces.some((s) => Math.abs(s.y - y) < 0.5 && s.x0 - hw < x1 && s.x1 + hw > x0);
        if (standable) continue;
        // Headroom: the most open air above any column of the run.
        let air = 0;
        for (let col = c0; col < c; col++) {
          let k = 0;
          while (r - 1 - k >= 0 && ["empty", "breakable"].includes(tileAt(grid, col, r - 1 - k))) k++;
          air = Math.max(air, k === r ? Infinity : k * TILE);
        }
        const cols = c - c0 === 1 ? `column ${c0}` : `columns ${c0}–${c - 1}`;
        const why =
          air < params.height
            ? `only ${air} px between it and the ceiling, and the player is ${params.height} px tall. Lower the platform, raise the ceiling, or remove it`
            : "something beside or above it leaves no room to stand. Move or remove it";
        out.push({ code: "unstandable_platform", path: `world.rooms.${index}.grid`, message: `Room "${room.id}": the platform at row ${r}, ${cols} looks standable but the player can't stand on it: ${why}.` });
      }
    }
  });
  return out;
}
