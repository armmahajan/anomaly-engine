import type { MovementAbility, MovementParams } from "../../movement/params.ts";
import { chainChunks, gateChunks, mirrorChunk, OPENING, wallJumpShaft, type Chunk, type ChunkOpening } from "../../world/chunks.ts";
import { gridCols, gridRows, TILE_CHAR, type TileGrid, type TileKind } from "../../world/tiles.ts";
import type { DoorSide } from "../../world/world.ts";
import type { Units } from "./units.ts";

/**
 * Blocks: walled pieces a room is built around, each flush with the room's
 * edge where its door is. A gated door's block chains the gate chunks of the
 * link's movement abilities (chunks.ts, proven to need exactly their
 * ability) from an entry facing into the room to the door; a top or bottom
 * door's block ends in a riser (a rung ladder up to the door) or a dropper (a
 * shaft down to it). Two-way links use gate variants you can also pass back
 * through with the ability (glide and ground pound get a return valve: a stack
 * of one-way floors, which you can climb but never drop down).
 */

export interface Block {
  id: string;
  grid: TileGrid;
  /** The opening into the rest of the room (left or right side of the block). */
  entry: ChunkOpening;
  /** The door, on the room's edge. */
  door: ChunkOpening;
  /** Rows of its riser or dropper (top and bottom doors), 0 for side doors. */
  leg: number;
}

/** A grid being drawn: starts solid. */
export class Paint {
  cells: string[][];
  readonly cols: number;
  readonly rows: number;
  constructor(cols: number, rows: number, fill = "#") {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => new Array<string>(cols).fill(fill));
  }
  static from(grid: TileGrid): Paint {
    const p = new Paint(gridCols(grid), gridRows(grid));
    p.cells = grid.rows.map((r) => r.split(""));
    return p;
  }
  get(c: number, r: number): string {
    return this.cells[r]?.[c] ?? "#";
  }
  set(c: number, r: number, ch: string) {
    if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) this.cells[r]![c] = ch;
  }
  fill(col: number, row: number, cols: number, rows: number, kind: TileKind) {
    const ch = TILE_CHAR[kind];
    for (let r = Math.max(0, row); r < Math.min(this.rows, row + rows); r++) for (let c = Math.max(0, col); c < Math.min(this.cols, col + cols); c++) this.cells[r]![c] = ch;
    return this;
  }
  open(o: ChunkOpening) {
    if (o.side === "left" || o.side === "right") this.fill(o.side === "left" ? 0 : this.cols - 1, o.offset, 1, o.size, "empty");
    else this.fill(o.offset, o.side === "top" ? 0 : this.rows - 1, o.size, 1, "empty");
    return this;
  }
  stamp(grid: TileGrid, col: number, row: number) {
    grid.rows.forEach((line, r) => {
      for (let c = 0; c < line.length; c++) this.set(col + c, row + r, line[c]!);
    });
  }
  grid(): TileGrid {
    return { rows: this.cells.map((r) => r.join("")) };
  }
}

const opening = (side: DoorSide, offset: number, size = OPENING): ChunkOpening => ({ side, offset, size });

/** Rung rows from `top` down toward a floor at `floor`: evenly spaced, at most `rise` apart, the lowest 2+ rows above the floor. */
export function rungRows(top: number, floor: number, rise: number): number[] {
  const span = floor - top;
  if (span <= 2) return [top];
  const n = Math.max(1, Math.ceil(span / rise));
  const rows: number[] = [];
  for (let i = 0; i < n; i++) rows.push(top + Math.round((span * i) / n));
  return rows.filter((r, i) => i === 0 || floor - r >= 2);
}

/**
 * A riser: a walled shaft with a ladder of one-way rungs zig-zagging up to a
 * door in its top (the top rung right under it: a plain jump leaves), entered
 * at the bottom of its left side.
 */
export function riser(u: Units, height: number): Chunk {
  const a = u.hatch;
  const b = u.half;
  const cols = a + 1 + b + 2;
  const rows = Math.max(height, u.topRung + 2 * u.rise + 2);
  const floor = rows - 1;
  const c = new Paint(cols, rows).fill(1, 1, cols - 2, floor - 1, "empty");
  rungRows(u.topRung, floor, u.rise).forEach((r, i) => (i % 2 === 0 ? c.fill(1, r, a, 1, "oneway") : c.fill(2 + a, r, b, 1, "oneway")));
  const entry = opening("left", floor - OPENING);
  const exit = opening("top", 1, a);
  c.open(entry).open(exit);
  return { id: `riser-${rows}`, kind: "stairs", grid: c.grid(), openings: [entry, exit], requires: [], describe: `A ${rows}-row rung ladder up to a door in its top.`, tags: ["climb", "two-way"] };
}

/**
 * A dropper: entered at the top of its left side, a shaft down to a door in
 * its bottom. Two-way: zig-zag rungs back up, and a half-cover over the door
 * to land on when coming up through it.
 */
export function dropper(u: Units, height: number, twoWay: boolean): Chunk {
  const a = u.hatch;
  const b = u.half;
  const top = OPENING + 1;
  const cols = a + 1 + b + 2;
  const rows = Math.max(height, twoWay ? top + 2 * u.rise + 3 : top + 2);
  const c = new Paint(cols, rows).fill(1, 1, cols - 2, rows - 2, "empty");
  const entry = opening("left", 1);
  let exit: ChunkOpening;
  if (twoWay) {
    // Rungs from the entry floor down; the door under the first half, with a cover over its left half.
    const coverRow = rows - 2;
    const rungs = rungRows(top, coverRow, u.rise);
    rungs.forEach((r, i) => (i % 2 === 0 ? c.fill(1, r, a, 1, "oneway") : c.fill(2 + a, r, b, 1, "oneway")));
    exit = opening("bottom", 1, a);
    c.fill(1, coverRow, Math.floor(a / 2), 1, "oneway");
  } else {
    // A ledge to stand on at the entry, the shaft beside it.
    c.fill(1, top, b + 1, 1, "solid");
    exit = opening("bottom", 2 + b, a);
  }
  c.open(entry).open(exit);
  return { id: `dropper-${rows}${twoWay ? "-2" : ""}`, kind: "drop", grid: c.grid(), openings: [entry, exit], requires: [], describe: `A ${rows}-row drop to a door in its bottom.`, tags: ["drop", twoWay ? "two-way" : "one-way"] };
}

/** Gate chunks for a link's movement abilities, in an order that chains. */
function gates(p: MovementParams, abilities: readonly MovementAbility[], twoWay: boolean, u: Units): Chunk[] {
  const lib = gateChunks(p);
  return [...new Set(abilities)].map((a) => {
    if (a === "wall_jump") return wallJumpShaft(p, { exitSide: "right" });
    if (twoWay && a === "ground_pound") return groundPoundTwoWay(p, u);
    if (twoWay && a === "glide") return glideTwoWay(p, u);
    return lib[a];
  });
}

/** Mirror a whole assembly left to right. */
function mirror(chunk: Pick<Chunk, "grid" | "openings">): Chunk {
  return mirrorChunk({ id: "block", kind: "gate", requires: [], describe: "", tags: [], ...chunk } as Chunk);
}

/**
 * The block for a gated door on `side`. `facing`: which way its entry faces
 * (for side doors, always into the room; for top and bottom doors, the side
 * the rest of the room is on). `height` sizes a riser or dropper (top and
 * bottom doors) so the block spans from the room's edge to where its entry
 * should be; it is grown as needed.
 */
export function gateBlock(
  p: MovementParams,
  u: Units,
  abilities: readonly MovementAbility[],
  side: DoorSide,
  options: { twoWay: boolean; facing?: "left" | "right"; height?: number },
): Block {
  const chain = gates(p, abilities, options.twoWay, u);
  let flow: Chunk[] = chain;
  let leg = 0;
  if (side === "top" || side === "bottom") {
    const base = chainChunks(chain);
    const exit = base.openings[1];
    if (side === "top") {
      const need = exit.offset + exit.size + 1;
      flow = [...chain, riser(u, Math.max(options.height ?? 0, need))];
      leg = gridRows(flow.at(-1)!.grid);
    } else {
      const need = gridRows(base.grid) - exit.offset + 1;
      flow = [...chain, dropper(u, Math.max(options.height ?? 0, need), options.twoWay)];
      leg = gridRows(flow.at(-1)!.grid);
    }
  }
  const assembly = chainChunks(flow);
  // Entry faces left as built; a right-side door's block faces left (into the room), a left door's faces right.
  const facing = side === "left" ? "right" : side === "right" ? "left" : (options.facing ?? "left");
  const built = facing === "left" ? assembly : mirror({ grid: assembly.grid, openings: assembly.openings });
  const [entry, door] = built.openings;
  return { id: `${side}:${abilities.join("+")}${options.twoWay ? ":2" : ""}`, grid: built.grid, entry, door, leg };
}

// ---------------------------------------------------------------- two-way gates

const twoWayMemo = new Map<string, Chunk>();

/**
 * Ground pound, two-way: a breakable floor over a shaft down to the exit, and
 * beside it a shaft of one-way floors back up (you climb them; nobody drops
 * down them), both under the hall you enter.
 */
export function groundPoundTwoWay(p: MovementParams, u: Units): Chunk {
  const key = JSON.stringify(["gp", p]);
  const hit = twoWayMemo.get(key);
  if (hit) return hit;
  const shelf = OPENING + 1;
  const pit = 4;
  const stack = Math.max(4, u.half + 1);
  const depth = Math.max(5, 2 * u.rise);
  const floor = shelf + depth;
  const cols = 1 + pit + 1 + stack + 1;
  const c = new Paint(cols, floor + 1).fill(1, 1, cols - 2, shelf - 1, "empty");
  // The pit under the breakable floor, the wall between, the stack, and the bottom hall.
  c.fill(1, shelf, pit, 1, "breakable").fill(1, shelf + 1, pit, depth - 1, "empty");
  c.fill(pit + 2, shelf, stack, depth - 1, "empty");
  c.fill(1, floor - OPENING, cols - 2, OPENING, "empty");
  for (const r of rungRows(shelf, floor, u.rise)) c.fill(pit + 2, r, stack, 1, "oneway");
  const entry = opening("left", 1);
  const exit = opening("right", floor - OPENING);
  c.open(entry).open(exit);
  const chunk: Chunk = {
    id: "gate-ground-pound-2",
    kind: "gate",
    grid: c.grid(),
    openings: [entry, exit],
    requires: ["ground_pound"],
    gate: { ability: "ground_pound", holdsAgainst: ["dash", "double_jump", "wall_jump", "glide"] },
    describe: "A breakable floor over the way on, and one-way floors to climb back.",
    tags: ["gate", "ground_pound", "breakable", "two-way"],
  };
  twoWayMemo.set(key, chunk);
  return chunk;
}

/**
 * Glide, two-way: the glide chasm, with a shaft of one-way floors at the far
 * side up to a tunnel over the chasm that ends above the near ledge (climb up,
 * walk back, drop down; nobody gets from the tunnel down to the far side).
 */
export function glideTwoWay(p: MovementParams, u: Units): Chunk {
  const key = JSON.stringify(["glide", p]);
  const hit = twoWayMemo.get(key);
  if (hit) return hit;
  const base = gateChunks(p).glide;
  const g = base.grid;
  const w = gridCols(g);
  const h = gridRows(g);
  const tunnel = u.body + 2;
  const stack = Math.max(4, u.half + 1);
  const cols = w + stack + 1;
  const top = tunnel + 1; // rows added above the chasm
  const rows = h + top;
  const c = new Paint(cols, rows);
  c.stamp(g, 0, top);
  const exitFloor = base.openings[1].offset + base.openings[1].size + top;
  // Close the chasm's own right wall above the exit; the far floor runs on under the stack to the room's edge.
  c.fill(w - 1, top, 1, h, "solid");
  c.fill(w - 1, exitFloor - OPENING, stack + 1, OPENING, "empty");
  c.fill(w - 1, exitFloor, stack + 2, 1, "solid");
  // The stack: from above the walkway to the tunnel.
  c.fill(w, 1, stack, exitFloor - OPENING - 1, "empty");
  for (const r of rungRows(top, exitFloor, u.rise)) c.fill(w, r, stack, 1, "oneway");
  c.fill(w, top, stack, 1, "oneway");
  // The tunnel over the chasm, ending in a hole above the near ledge.
  c.fill(1, 1, w + stack - 1, tunnel, "empty");
  const ledge = base.openings[0].offset + base.openings[0].size + top;
  c.fill(1, tunnel + 1, 3, ledge - OPENING - tunnel - 1, "empty");
  const entry = { ...base.openings[0], offset: base.openings[0].offset + top };
  const exit = opening("right", exitFloor - OPENING);
  c.fill(cols - 1, 0, 1, rows, "solid");
  c.open(entry).open(exit);
  const chunk: Chunk = {
    id: "gate-glide-2",
    kind: "gate",
    grid: c.grid(),
    openings: [entry, exit],
    requires: ["glide"],
    gate: { ability: "glide", holdsAgainst: ["dash", "double_jump", "wall_jump", "ground_pound"] },
    describe: "Glide over a spiked chasm; climb one-way floors and walk back through a tunnel above it.",
    tags: ["gate", "glide", "hazard", "two-way"],
  };
  twoWayMemo.set(key, chunk);
  return chunk;
}
