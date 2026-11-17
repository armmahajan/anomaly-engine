import { z } from "zod";

/**
 * Level geometry as a grid of 32 px tiles, one character per tile, rows
 * top to bottom. The grid is the source of truth; collision rectangles are
 * derived from it (gridToSolids), never stored.
 *
 *   .  empty
 *   #  solid: a full tile
 *   =  ledge: thin and solid (the top `ledgeThickness` px of its cell)
 *   -  one-way: thin; you can jump up through it and land on it
 *   ^  hazard: a full solid tile that hurts on touch
 *   %  breakable: a full solid tile a ground pound smashes, with every
 *      breakable tile connected to it
 */

export const TILE = 32;

export const TILE_KINDS = {
  ".": "empty",
  "#": "solid",
  "=": "ledge",
  "-": "oneway",
  "^": "hazard",
  "%": "breakable",
} as const;
export type TileChar = keyof typeof TILE_KINDS;
export type TileKind = (typeof TILE_KINDS)[TileChar];
export const TILE_CHAR = Object.fromEntries(Object.entries(TILE_KINDS).map(([c, k]) => [k, c])) as Record<TileKind, TileChar>;

const ROW = /^[.#=\-^%]+$/;

export const TileGrid = z
  .strictObject({
    rows: z
      .array(z.string().regex(ROW, "tiles are . # = - ^ %"))
      .min(4)
      .max(300)
      .describe("Rows top to bottom, one character per 32 px tile: . empty, # solid, = ledge (thin solid), - one-way, ^ hazard, % breakable."),
  })
  .superRefine((grid, ctx) => {
    const width = grid.rows[0]?.length ?? 0;
    if (width < 4 || width > 600) ctx.addIssue({ code: "custom", path: ["rows"], message: "a grid is 4 to 600 tiles wide" });
    grid.rows.forEach((row, i) => {
      if (row.length !== width) ctx.addIssue({ code: "custom", path: ["rows", i], message: `row ${i} is ${row.length} tiles; rows must all be ${width}` });
    });
  });
export type TileGrid = z.infer<typeof TileGrid>;

/** Default thickness of ledges and one-way platforms, px. */
export const DEFAULT_LEDGE_THICKNESS = 20;

export const gridCols = (grid: TileGrid) => grid.rows[0]?.length ?? 0;
export const gridRows = (grid: TileGrid) => grid.rows.length;
/** Size in px. */
export const gridSize = (grid: TileGrid) => ({ width: gridCols(grid) * TILE, height: gridRows(grid) * TILE });

/** The tile at a cell; outside the grid is empty. */
export function tileAt(grid: TileGrid, col: number, row: number): TileKind {
  const ch = grid.rows[row]?.[col];
  return ch === undefined ? "empty" : TILE_KINDS[ch as TileChar];
}

/** An empty grid with a solid border (walls, floor and ceiling). */
export function borderedGrid(cols: number, rows: number): TileGrid {
  return {
    rows: Array.from({ length: rows }, (_, r) => (r === 0 || r === rows - 1 ? "#".repeat(cols) : `#${".".repeat(cols - 2)}#`)),
  };
}

/** A copy with a rectangle of cells (in tiles, clipped to the grid) set to one kind. */
export function fillTiles(grid: TileGrid, area: { col: number; row: number; cols: number; rows: number }, kind: TileKind): TileGrid {
  const ch = TILE_CHAR[kind];
  return {
    rows: grid.rows.map((row, r) => {
      if (r < area.row || r >= area.row + area.rows) return row;
      const cells = row.split("");
      for (let c = Math.max(0, area.col); c < Math.min(cells.length, area.col + area.cols); c++) cells[c] = ch;
      return cells.join("");
    }),
  };
}

/** A collision rectangle derived from the grid, in px. */
export interface GridSolid {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: Exclude<TileKind, "empty">;
  /** Breakable tiles: all solids of one connected breakable area share a group, and smash together. */
  group?: number;
}

/**
 * The fewest rectangles covering the grid's tiles, one kind per rectangle.
 * Full tiles (solid, hazard, breakable) merge into rectangles; thin tiles
 * (ledge, one-way) merge along their row. Deterministic: scans top to
 * bottom, left to right.
 */
export function gridToSolids(grid: TileGrid, ledgeThickness = DEFAULT_LEDGE_THICKNESS): GridSolid[] {
  const cols = gridCols(grid);
  const rows = gridRows(grid);
  const used = grid.rows.map(() => new Array<boolean>(cols).fill(false));
  const kindAt = (c: number, r: number) => tileAt(grid, c, r);
  const groups = breakableGroups(grid);
  const solids: GridSolid[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kind = kindAt(c, r);
      if (kind === "empty" || used[r]![c]) continue;
      const group = kind === "breakable" ? groups[r]![c]! : undefined;
      const same = (cc: number, rr: number) => !used[rr]![cc] && kindAt(cc, rr) === kind && (group === undefined || groups[rr]![cc] === group);
      let width = 1;
      while (c + width < cols && same(c + width, r)) width++;
      let height = 1;
      const thin = kind === "ledge" || kind === "oneway";
      if (!thin) {
        while (r + height < rows && Array.from({ length: width }, (_, i) => same(c + i, r + height)).every(Boolean)) height++;
      }
      for (let rr = r; rr < r + height; rr++) for (let cc = c; cc < c + width; cc++) used[rr]![cc] = true;
      solids.push({
        x: c * TILE,
        y: r * TILE,
        width: width * TILE,
        height: thin ? ledgeThickness : height * TILE,
        kind,
        ...(group !== undefined && { group }),
      });
    }
  }
  return solids;
}

/** Connected (4-neighbour) breakable areas, numbered from 1 in scan order; 0 elsewhere. */
function breakableGroups(grid: TileGrid): number[][] {
  const cols = gridCols(grid);
  const ids = grid.rows.map(() => new Array<number>(cols).fill(0));
  let next = 0;
  for (let r = 0; r < grid.rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      if (tileAt(grid, c, r) !== "breakable" || ids[r]![c]) continue;
      next++;
      const stack: [number, number][] = [[c, r]];
      ids[r]![c] = next;
      while (stack.length) {
        const [cc, rr] = stack.pop()!;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const [nc, nr] = [cc + dc, rr + dr];
          if (tileAt(grid, nc, nr) === "breakable" && ids[nr]![nc] === 0) {
            ids[nr]![nc] = next;
            stack.push([nc, nr]);
          }
        }
      }
    }
  }
  return ids;
}

/** The grid's walkable shapes as plain rectangles (breakables left out: they can vanish), e.g. for art snapping. */
export function gridPlatforms(grid: TileGrid, ledgeThickness = DEFAULT_LEDGE_THICKNESS): { x: number; y: number; width: number; height: number }[] {
  return gridToSolids(grid, ledgeThickness)
    .filter((s) => s.kind !== "breakable" && s.height >= 8)
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
}

/**
 * Rasterize old-style platform rectangles onto a grid (for migrations and
 * accepted layouts). Rectangles thinner than a tile become ledges in the row
 * nearest their top; thicker ones fill the rows and columns they mostly
 * cover. Breakable rectangles become breakable tiles.
 */
export function rectsToGrid(rects: { x: number; y: number; width: number; height: number; breakable?: boolean }[], cols: number, rows: number): TileGrid {
  let grid: TileGrid = { rows: Array.from({ length: rows }, () => ".".repeat(cols)) };
  const sorted = [...rects].sort((a, b) => Number(!!a.breakable) - Number(!!b.breakable)); // breakable wins overlaps
  for (const r of sorted) {
    const thin = r.height < TILE;
    const col = Math.round(r.x / TILE);
    const span = Math.max(1, Math.round((r.x + r.width) / TILE) - col);
    const row = Math.round(r.y / TILE);
    const rowSpan = thin ? 1 : Math.max(1, Math.round((r.y + r.height) / TILE) - row);
    const kind: TileKind = r.breakable ? "breakable" : thin ? "ledge" : "solid";
    grid = fillTiles(grid, { col, row, cols: span, rows: rowSpan }, kind);
  }
  return grid;
}

/** True where a box (feet at x, y; size w x h) overlaps no solid tile; thin tiles block only their top part. */
export function isOpen(grid: TileGrid, x: number, y: number, w: number, h: number, ledgeThickness = DEFAULT_LEDGE_THICKNESS): boolean {
  const box = { left: x - w / 2, right: x + w / 2, top: y - h, bottom: y };
  return !gridToSolids(grid, ledgeThickness).some(
    (s) => s.kind !== "oneway" && box.left < s.x + s.width && box.right > s.x && box.top < s.y + s.height && box.bottom > s.y,
  );
}
