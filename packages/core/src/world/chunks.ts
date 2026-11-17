import { MOVEMENT_ABILITIES, type MovementAbility, type MovementParams } from "../movement/params.ts";
import { movementModel } from "../movement/model.ts";
import { gridCols, gridRows, TILE, TILE_CHAR, type TileGrid, type TileKind } from "./tiles.ts";
import { OPPOSITE, type DoorSide } from "./world.ts";
import { canTraverse, type TraversalOpening } from "./traversal.ts";

/**
 * Chunk library: small parameterized pieces of level the Architect assembles
 * rooms from. Each chunk is a walled tile grid with an entry and an exit
 * opening; generators size them from the player's movement (the model's
 * envelope, or the traversal checker itself where geometry matters), so
 * they adapt to the creator's tuning.
 *
 * `requires` is what you need to get from the entry to the exit. A gate
 * chunk also lists `holdsAgainst`: abilities it was built to resist. It is
 * not traversable with all of them (and without its own ability); walls
 * that could be climbed to bypass it are hazards, ceilings cap height.
 */

export type ChunkKind = "corridor" | "stairs" | "drop" | "hall" | "oneway_stairs" | "hazard_pit" | "gate";

export interface ChunkOpening {
  side: DoorSide;
  offset: number;
  size: number;
}

export interface Chunk {
  id: string;
  kind: ChunkKind;
  grid: TileGrid;
  /** [entry, exit]. */
  openings: [ChunkOpening, ChunkOpening];
  requires: MovementAbility[];
  gate?: { ability: MovementAbility; holdsAgainst: MovementAbility[] };
  describe: string;
  tags: string[];
}

const ALL = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];
const others = (a: MovementAbility) => ALL.filter((b) => b !== a);
/** Side openings are this many tiles tall, with floor right below. */
export const OPENING = 3;

/** A grid being drawn: starts solid. */
class Canvas {
  cells: string[][];
  cols: number;
  rows: number;
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => new Array<string>(cols).fill("#"));
  }
  fill(col: number, row: number, cols: number, rows: number, kind: TileKind) {
    for (let r = Math.max(0, row); r < Math.min(this.rows, row + rows); r++) for (let c = Math.max(0, col); c < Math.min(this.cols, col + cols); c++) this.cells[r]![c] = TILE_CHAR[kind];
    return this;
  }
  /** Carve an opening in the border. */
  open(o: ChunkOpening) {
    if (o.side === "left" || o.side === "right") this.fill(o.side === "left" ? 0 : this.cols - 1, o.offset, 1, o.size, "empty");
    else this.fill(o.offset, o.side === "top" ? 0 : this.rows - 1, o.size, 1, "empty");
    return this;
  }
  grid(): TileGrid {
    return { rows: this.cells.map((r) => r.join("")) };
  }
}

const doorsOf = (c: { openings: ChunkOpening[] }): TraversalOpening[] => c.openings.map((o, i) => ({ id: i === 0 ? "entry" : "exit", ...o }));

/** Is a chunk traversable from its entry to its exit with these abilities? */
export function chunkTraversable(chunk: Pick<Chunk, "grid" | "openings">, params: MovementParams, abilities: readonly MovementAbility[]): boolean {
  return canTraverse({ grid: chunk.grid, doors: doorsOf(chunk) }, "entry", "exit", params, abilities);
}

/** The chunk's openings as doors (ids "entry" and "exit"), for the traversal checker. */
export const chunkDoors = doorsOf;

const side = (s: DoorSide, offset: number, size = OPENING): ChunkOpening => ({ side: s, offset, size });
const heights = (p: MovementParams) => ({ single: movementModel(p, []).maxHeight, double: movementModel(p, ["double_jump"]).maxHeight });
/** Tiles of rise a plain jump clears with room to spare. */
const riseTiles = (p: MovementParams) => Math.max(1, Math.floor((heights(p).single - 40) / TILE));
const headroom = (p: MovementParams, rise: number) => Math.ceil((rise + p.height + 24) / TILE);

// ---------------------------------------------------------------- plain chunks

export function corridorChunk(_p: MovementParams, { length = 10, height = 4 } = {}): Chunk {
  const cols = Math.max(4, length);
  const rows = height + 2;
  const entry = side("left", rows - 1 - OPENING);
  const exit = side("right", rows - 1 - OPENING);
  const grid = new Canvas(cols, rows).fill(1, 1, cols - 2, height, "empty").open(entry).open(exit).grid();
  return { id: `corridor-${cols}`, kind: "corridor", grid, openings: [entry, exit], requires: [], describe: `A flat corridor, ${cols} tiles long.`, tags: ["flat", "two-way"] };
}

/** Solid steps up to the right, each a comfortable plain jump. */
export function stairsChunk(p: MovementParams, { steps = 3, stepWidth = 3 } = {}): Chunk {
  const rise = riseTiles(p);
  const top = headroom(p, rise * TILE) + 1;
  const floor = top + steps * rise;
  const cols = 5 + steps * stepWidth + 1;
  const c = new Canvas(cols, floor + 1).fill(1, 1, cols - 2, floor - 1, "empty");
  for (let i = 1; i <= steps; i++) c.fill(5 + (i - 1) * stepWidth, floor - i * rise, cols, i * rise, "solid");
  const entry = side("left", floor - OPENING);
  const exit = side("right", top - OPENING);
  c.open(entry).open(exit);
  return { id: `stairs-${steps}`, kind: "stairs", grid: c.grid(), openings: [entry, exit], requires: [], describe: `${steps} steps up, ${rise} tiles each.`, tags: ["climb", "two-way"] };
}

/** Off a ledge and down a shaft: one way. */
export function dropChunk(_p: MovementParams, { depth = 8, width = 10 } = {}): Chunk {
  const ledge = OPENING + 1;
  const floor = ledge + depth;
  const c = new Canvas(width, floor + 1).fill(1, 1, width - 2, floor - 1, "empty").fill(1, ledge, 3, depth, "solid");
  const entry = side("left", 1);
  const exit = side("right", floor - OPENING);
  c.open(entry).open(exit);
  return { id: `drop-${depth}`, kind: "drop", grid: c.grid(), openings: [entry, exit], requires: [], describe: `A ${depth}-tile drop from a ledge.`, tags: ["drop", "one-way"] };
}

/**
 * An open room shell: walls, a flat floor and a ceiling at least a double
 * jump high, to stamp features into (fillTiles, stampChunk). Openings go
 * anywhere on its sides (default: left and right at the floor).
 */
export function hallChunk(p: MovementParams, { width = 24, height = 0, openings }: { width?: number; height?: number; openings?: [ChunkOpening, ChunkOpening] } = {}): Chunk {
  const rows = Math.max(height, headroom(p, heights(p).double) + 2);
  const c = new Canvas(width, rows).fill(1, 1, width - 2, rows - 2, "empty");
  const [entry, exit] = openings ?? [side("left", rows - 1 - OPENING), side("right", rows - 1 - OPENING)];
  c.open(entry).open(exit);
  return { id: `hall-${width}x${rows}`, kind: "hall", grid: c.grid(), openings: [entry, exit], requires: [], describe: `An open ${width}x${rows} room.`, tags: ["open", "two-way"] };
}

/** One-way floors stacked up a shaft: jump up through each. */
export function onewayStairsChunk(p: MovementParams, { steps = 3, width = 8 } = {}): Chunk {
  const rise = riseTiles(p);
  const top = headroom(p, rise * TILE) + 1;
  const floor = top + steps * rise;
  const c = new Canvas(width, floor + 1).fill(1, 1, width - 2, floor - 1, "empty");
  for (let i = 1; i <= steps; i++) c.fill(1, floor - i * rise, width - 2, 1, "oneway");
  const entry = side("left", floor - OPENING);
  const exit = side("right", top - OPENING);
  c.open(entry).open(exit);
  return { id: `oneway-stairs-${steps}`, kind: "oneway_stairs", grid: c.grid(), openings: [entry, exit], requires: [], describe: `${steps} one-way floors, ${rise} tiles apart.`, tags: ["climb", "one-way-platforms"] };
}

/** A spike pit a plain jump clears. */
export function hazardPitChunk(p: MovementParams, { ledge = 4 } = {}): Chunk {
  const gap = Math.max(1, Math.floor((movementModel(p, []).maxGap(0) - 64) / TILE));
  const air = headroom(p, heights(p).single);
  const floor = air + 1;
  const cols = 2 + 2 * ledge + gap;
  const c = new Canvas(cols, floor + 3).fill(1, 1, cols - 2, air, "empty").fill(1 + ledge, floor, gap, 1, "empty").fill(1 + ledge, floor + 1, gap, 1, "hazard");
  const entry = side("left", floor - OPENING);
  const exit = side("right", floor - OPENING);
  c.open(entry).open(exit);
  return { id: `hazard-pit-${gap}`, kind: "hazard_pit", grid: c.grid(), openings: [entry, exit], requires: [], describe: `Jump a ${gap}-tile spike pit.`, tags: ["jump", "hazard", "two-way"] };
}

// ---------------------------------------------------------------- gates

/** The middle of the widths (tiles) at which `build` is a gate, or null. */
function sizeGate(widths: number[], build: (w: number) => Chunk, p: MovementParams, ability: MovementAbility): Chunk | null {
  const ok = widths.filter((w) => {
    const chunk = build(w);
    return chunkTraversable(chunk, p, [ability]) && !chunkTraversable(chunk, p, others(ability));
  });
  return ok.length ? build(ok[Math.floor((ok.length - 1) / 2)]!) : null;
}

const gateMemo = new Map<string, Chunk>();
function memo(key: string, p: MovementParams, make: () => Chunk | null): Chunk {
  const k = JSON.stringify([key, p]);
  let chunk = gateMemo.get(k);
  if (!chunk) {
    const made = make();
    if (!made) throw new Error(`no ${key} gate fits this movement tuning`);
    gateMemo.set(k, (chunk = made));
  }
  return chunk;
}

/**
 * Dash: a spike strip in the floor of a low tunnel (too low to jump or
 * glide far), wider than you can clear airborne, within a dash.
 */
export function dashGap(p: MovementParams): Chunk {
  return memo("dash", p, () => {
    const build = (w: number): Chunk => {
      const lead = 3;
      const tunnel = 2;
      const floor = OPENING + 1;
      const cols = 2 + 2 * (lead + tunnel) + w;
      const c = new Canvas(cols, floor + 2)
        .fill(1, 1, cols - 2, OPENING, "empty")
        .fill(1 + lead, 1, 2 * tunnel + w, OPENING - 2, "solid")
        .fill(1 + lead + tunnel, floor, w, 1, "hazard");
      const entry = side("left", 1);
      const exit = side("right", 1);
      c.open(entry).open(exit);
      return {
        id: "gate-dash",
        kind: "gate",
        grid: c.grid(),
        openings: [entry, exit],
        requires: ["dash"],
        gate: { ability: "dash", holdsAgainst: others("dash") },
        describe: `Dash over a ${w}-tile spike strip in a low tunnel.`,
        tags: ["gate", "dash", "hazard"],
      };
    };
    return sizeGate(range(2, 14), build, p, "dash");
  });
}

/**
 * Double jump: a step higher than a jump, within a double jump. Its face
 * and the wall behind you are spikes, so wall jumps can't climb it.
 */
export function doubleJumpLedge(p: MovementParams): Chunk {
  return memo("double_jump", p, () => {
    const { single, double } = heights(p);
    const lo = Math.ceil((single + 24) / TILE);
    const hi = Math.floor((double - 24) / TILE);
    if (lo > hi) return null;
    const rise = Math.floor((lo + hi) / 2);
    const floor = Math.max(rise + OPENING + 2, headroom(p, double) + 1);
    const cols = 12;
    const top = floor - rise;
    const c = new Canvas(cols, floor + 1)
      .fill(1, 1, cols - 2, floor - 1, "empty")
      .fill(6, top, cols - 6, rise, "solid")
      .fill(6, top, 1, rise, "hazard")
      .fill(0, 1, 1, floor - OPENING - 1, "hazard");
    const entry = side("left", floor - OPENING);
    const exit = side("right", top - OPENING);
    c.open(entry).open(exit);
    return {
      id: "gate-double-jump",
      kind: "gate",
      grid: c.grid(),
      openings: [entry, exit],
      requires: ["double_jump"],
      gate: { ability: "double_jump", holdsAgainst: others("double_jump") },
      describe: `A ${rise}-tile step with a spiked face: too high for one jump.`,
      tags: ["gate", "double_jump", "hazard"],
    };
  });
}

/** Wall jump: a bare shaft taller than any jump, out through the top (or the right side at the top). */
export function wallJumpShaft(p: MovementParams, { width = 4, exitSide = "top" as "top" | "right" } = {}): Chunk {
  return memo(`wall_jump-${width}-${exitSide}`, p, () => {
    const reach = heights(p).double + 64;
    const floor = exitSide === "top" ? Math.ceil((reach + p.height / 2) / TILE) : Math.ceil((reach + (OPENING + 1) * TILE) / TILE);
    const cols = width + 2;
    const c = new Canvas(cols, floor + 1).fill(1, 1, width, floor - 1, "empty");
    const entry = side("left", floor - OPENING);
    const exit = exitSide === "top" ? side("top", 1, width) : side("right", 1);
    c.open(entry).open(exit);
    return {
      id: `gate-wall-jump-${exitSide}`,
      kind: "gate",
      grid: c.grid(),
      openings: [entry, exit],
      requires: ["wall_jump"],
      gate: { ability: "wall_jump", holdsAgainst: others("wall_jump") },
      describe: `A bare ${floor}-tile shaft: climb it by wall jumps.`,
      tags: ["gate", "wall_jump", "shaft", "one-way"],
    };
  });
}

/**
 * Glide: a chasm with a spiked floor and spiked faces, the far side `drop`
 * tiles lower, wider than dash + double jump reach under its ceiling.
 */
export function glideChasm(p: MovementParams, { drop = 6 } = {}): Chunk {
  return memo(`glide-${drop}`, p, () => {
    const air = headroom(p, heights(p).single);
    const top = air + 1;
    const floor = top + drop;
    const build = (w: number): Chunk => {
      const ledge = 4;
      const cols = 2 + ledge + w + ledge;
      const c = new Canvas(cols, floor + 2)
        .fill(1, 1, cols - 2, floor - 1, "empty")
        .fill(1, top, ledge, drop, "solid")
        .fill(ledge, top, 1, drop, "hazard")
        .fill(ledge + 1, floor, w, 1, "hazard")
        .fill(0, 1, 1, top - OPENING - 1, "hazard");
      const entry = side("left", top - OPENING);
      const exit = side("right", floor - OPENING);
      c.open(entry).open(exit);
      return {
        id: "gate-glide",
        kind: "gate",
        grid: c.grid(),
        openings: [entry, exit],
        requires: ["glide"],
        gate: { ability: "glide", holdsAgainst: others("glide") },
        describe: `Glide over a ${w}-tile spiked chasm to a ledge ${drop} tiles lower.`,
        tags: ["gate", "glide", "hazard", "one-way"],
      };
    };
    const lo = movementModel(p, others("glide")).maxGap(drop * TILE);
    const hi = movementModel(p, ["glide"]).maxGap(drop * TILE);
    const mid = Math.round((lo + hi) / 2 / TILE);
    return sizeGate([mid, mid - 2, mid + 2, mid - 4, mid + 4], build, p, "glide");
  });
}

/** Ground pound: a breakable floor from wall to wall over the way on. */
export function groundPoundFloor(_p: MovementParams, { width = 10, depth = 5 } = {}): Chunk {
  const shelf = OPENING + 1;
  const floor = shelf + depth;
  const c = new Canvas(width, floor + 1).fill(1, 1, width - 2, floor - 1, "empty").fill(1, shelf, width - 2, 1, "breakable");
  const entry = side("left", 1);
  const exit = side("right", floor - OPENING);
  c.open(entry).open(exit);
  return {
    id: "gate-ground-pound",
    kind: "gate",
    grid: c.grid(),
    openings: [entry, exit],
    requires: ["ground_pound"],
    gate: { ability: "ground_pound", holdsAgainst: others("ground_pound") },
    describe: "A breakable floor, wall to wall, over the way on.",
    tags: ["gate", "ground_pound", "breakable", "one-way"],
  };
}

/** One gate chunk per movement ability. */
export function gateChunks(p: MovementParams): Record<MovementAbility, Chunk> {
  return { dash: dashGap(p), double_jump: doubleJumpLedge(p), wall_jump: wallJumpShaft(p), glide: glideChasm(p), ground_pound: groundPoundFloor(p) };
}

/** Every chunk with default settings. */
export function chunkLibrary(p: MovementParams): Chunk[] {
  return [corridorChunk(p), stairsChunk(p), dropChunk(p), hallChunk(p), onewayStairsChunk(p), hazardPitChunk(p), ...Object.values(gateChunks(p))];
}

// ---------------------------------------------------------------- assembly

/** A copy of `grid` with the chunk's tiles written at (col, row), clipped to the grid. */
export function stampChunk(grid: TileGrid, chunk: Pick<Chunk, "grid">, col: number, row: number): TileGrid {
  const cols = gridCols(grid);
  return {
    rows: grid.rows.map((line, r) => {
      const src = chunk.grid.rows[r - row];
      if (src === undefined) return line;
      const cells = line.split("");
      for (let c = Math.max(0, col); c < Math.min(cols, col + src.length); c++) cells[c] = src[c - col]!;
      return cells.join("");
    }),
  };
}

/** A chunk mirrored left to right (its openings swap sides). */
export function mirrorChunk(chunk: Chunk): Chunk {
  const flip = (o: ChunkOpening): ChunkOpening =>
    o.side === "left" || o.side === "right" ? { ...o, side: OPPOSITE[o.side] } : { ...o, offset: gridCols(chunk.grid) - o.offset - o.size };
  return {
    ...chunk,
    id: `${chunk.id}-mirrored`,
    grid: { rows: chunk.grid.rows.map((r) => r.split("").reverse().join("")) },
    openings: [flip(chunk.openings[0]), flip(chunk.openings[1])],
  };
}

export interface Assembly {
  grid: TileGrid;
  /** Entry of the first chunk, exit of the last. */
  openings: [ChunkOpening, ChunkOpening];
  placements: { chunk: Chunk; col: number; row: number }[];
}

/**
 * Chain chunks into one room: each chunk's entry meets the previous one's
 * exit (opposite sides, side openings aligned at the bottom, top/bottom at
 * the left). Everything around them is solid. Throws if chunks would overlap
 * or an exit faces an entry on the wrong side.
 */
export function chainChunks(chunks: readonly Chunk[]): Assembly {
  if (!chunks.length) throw new Error("no chunks to chain");
  const placed: { chunk: Chunk; col: number; row: number }[] = [{ chunk: chunks[0]!, col: 0, row: 0 }];
  for (let i = 1; i < chunks.length; i++) {
    const prev = placed[i - 1]!;
    const out = prev.chunk.openings[1];
    const next = chunks[i]!;
    const into = next.openings[0];
    if (into.side !== OPPOSITE[out.side]) throw new Error(`chunk ${i} (${next.id}) enters on the ${into.side}; the previous exit is on the ${out.side}`);
    const [pc, pr] = [gridCols(prev.chunk.grid), gridRows(prev.chunk.grid)];
    const [nc, nr] = [gridCols(next.grid), gridRows(next.grid)];
    let col: number;
    let row: number;
    if (out.side === "right" || out.side === "left") {
      col = out.side === "right" ? prev.col + pc : prev.col - nc;
      row = prev.row + out.offset + out.size - (into.offset + into.size);
    } else {
      row = out.side === "bottom" ? prev.row + pr : prev.row - nr;
      col = prev.col + out.offset - into.offset;
    }
    for (const p of placed) {
      const [w, h] = [gridCols(p.chunk.grid), gridRows(p.chunk.grid)];
      if (col < p.col + w && col + nc > p.col && row < p.row + h && row + nr > p.row) throw new Error(`chunk ${i} (${next.id}) overlaps ${p.chunk.id}`);
    }
    placed.push({ chunk: next, col, row });
  }
  const minCol = Math.min(...placed.map((p) => p.col));
  const minRow = Math.min(...placed.map((p) => p.row));
  const cols = Math.max(...placed.map((p) => p.col + gridCols(p.chunk.grid))) - minCol;
  const rows = Math.max(...placed.map((p) => p.row + gridRows(p.chunk.grid))) - minRow;
  let grid: TileGrid = { rows: Array.from({ length: rows }, () => "#".repeat(cols)) };
  const placements = placed.map((p) => ({ chunk: p.chunk, col: p.col - minCol, row: p.row - minRow }));
  for (const p of placements) grid = stampChunk(grid, p.chunk, p.col, p.row);
  const shift = (o: ChunkOpening, p: { chunk: Chunk; col: number; row: number }): ChunkOpening => {
    const vertical = o.side === "left" || o.side === "right";
    return { ...o, offset: o.offset + (vertical ? p.row : p.col) };
  };
  const first = placements[0]!;
  const last = placements.at(-1)!;
  const edge = (o: ChunkOpening, p: { chunk: Chunk; col: number; row: number }) => {
    const ok =
      (o.side === "left" && p.col === 0) ||
      (o.side === "right" && p.col + gridCols(p.chunk.grid) === cols) ||
      (o.side === "top" && p.row === 0) ||
      (o.side === "bottom" && p.row + gridRows(p.chunk.grid) === rows);
    if (!ok) throw new Error(`the ${o.side} opening of ${p.chunk.id} is not on the room's edge`);
  };
  edge(first.chunk.openings[0], first);
  edge(last.chunk.openings[1], last);
  return { grid, openings: [shift(first.chunk.openings[0], first), shift(last.chunk.openings[1], last)], placements };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
