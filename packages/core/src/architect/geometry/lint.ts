import type { MovementParams } from "../../movement/params.ts";
import { DEFAULT_LEDGE_THICKNESS, gridCols, gridRows, gridSize, gridToSolids, TILE, tileAt, type TileGrid, type TileKind } from "../../world/tiles.ts";
import { standingSurfaces } from "../../world/traversal.ts";

/** Tiles whose top reads as somewhere to stand (as world/platformLint.ts). */
const STANDABLE: ReadonlySet<TileKind> = new Set(["solid", "ledge", "oneway", "breakable"]);

export interface Unstandable {
  row: number;
  c0: number;
  c1: number;
  /** Rows of open air above its most open column. */
  air: number;
}

/**
 * Runs of tile tops that look standable but where the player can't stand
 * (the `unstandable_platform` lint, world/platformLint.ts, for one grid).
 */
export function unstandableRuns(grid: TileGrid, p: MovementParams, ledgeThickness = DEFAULT_LEDGE_THICKNESS): Unstandable[] {
  const size = gridSize(grid);
  const solids = gridToSolids(grid, ledgeThickness);
  const surfaces = [...standingSurfaces(solids, p, size), ...standingSurfaces(solids.filter((s) => s.kind !== "breakable"), p, size)];
  const hw = p.width / 2;
  const out: Unstandable[] = [];
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
      if (surfaces.some((s) => Math.abs(s.y - y) < 0.5 && s.x0 - hw < x1 && s.x1 + hw > x0)) continue;
      let air = 0;
      for (let col = c0; col < c; col++) {
        let k = 0;
        while (r - 1 - k >= 0 && ["empty", "breakable"].includes(tileAt(grid, col, r - 1 - k))) k++;
        air = Math.max(air, k);
      }
      out.push({ row: r, c0, c1: c - 1, air });
    }
  }
  return out;
}

/** Fill the air over runs too low to stand under (pockets nobody fits in), until none are left. */
export function fixUnstandable(grid: TileGrid, p: MovementParams, ledgeThickness = DEFAULT_LEDGE_THICKNESS): TileGrid {
  let rows = grid.rows.slice();
  for (let pass = 0; pass < 6; pass++) {
    const runs = unstandableRuns({ rows }, p, ledgeThickness).filter((u) => u.air * TILE < p.height + 8);
    if (!runs.length) break;
    const cells = rows.map((r) => r.split(""));
    for (const run of runs) {
      for (let c = run.c0; c <= run.c1; c++) {
        for (let r = run.row - 1; r >= 0 && cells[r]![c] === "."; r--) cells[r]![c] = "#";
      }
    }
    rows = cells.map((r) => r.join(""));
  }
  return { rows };
}
