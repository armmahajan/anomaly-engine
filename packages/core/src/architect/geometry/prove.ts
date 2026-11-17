import { movementModel } from "../../movement/model.ts";
import { MOVEMENT_ABILITIES, type MovementAbility, type MovementParams } from "../../movement/params.ts";
import { DEFAULT_LEDGE_THICKNESS, gridCols, gridRows, TILE, tileAt, type TileGrid } from "../../world/tiles.ts";
import { reachableFrom, roomGraph, type RoomGraph, type TraversalOpening } from "../../world/traversal.ts";
import { unstandableRuns } from "./lint.ts";

/**
 * Proving a built room with the traversal checker (the runtime's physics):
 *
 * - every door you can enter by reaches every door you can leave by, with no
 *   abilities (gated doors aside);
 * - a gated door is reachable with exactly its link's abilities, and not with
 *   all the other abilities while missing any one of them; for a two-way link
 *   you can come back from it with its abilities;
 * - a one-way door in (a drop) can't be reached from inside, with no abilities;
 * - no traps: from everywhere you can get to with no abilities you can still
 *   reach every door you can leave by (and, when `deep`, with every ability
 *   some door);
 * - no unstandable platforms; doors don't open onto hazards.
 *
 * Big rooms prove "not without" on a crop around the gated door (`crop`): every
 * surface in the crop counts as reachable and the crop's cut edges become walls,
 * both of which only add ways in, so a gate that holds there holds in the room.
 */

export interface ProofDoor extends TraversalOpening {
  gate: MovementAbility[];
  flow: "both" | "out" | "in";
  /** A gated door's block (tiles, inclusive): the way to the door is through it. */
  area?: Area;
}

export interface Area {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

export interface ProofOptions {
  ledgeThickness?: number;
  /** Also check for traps with every ability. */
  deep?: boolean;
  /** Prove gates hold on a crop around them (default: rooms over 4000 tiles). */
  crop?: boolean;
}

export interface Proof {
  ok: boolean;
  problems: string[];
  /** Standing surfaces reachable with no abilities. */
  surfaces: number;
  ms: number;
}

const ALL = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];

export function proveRoom(grid: TileGrid, doors: readonly ProofDoor[], p: MovementParams, options: ProofOptions = {}): Proof {
  const t0 = performance.now();
  const ledge = options.ledgeThickness ?? DEFAULT_LEDGE_THICKNESS;
  const crop = options.crop ?? gridCols(grid) * gridRows(grid) > 4000;
  const problems: string[] = [];
  const graphs = new Map<string, RoomGraph>();
  const graph = (abilities: MovementAbility[]) => {
    const key = [...abilities].sort().join(",");
    let g = graphs.get(key);
    if (!g) graphs.set(key, (g = roomGraph(grid, doors, p, abilities, { ledgeThickness: ledge })));
    return g;
  };
  const plain = (d: ProofDoor) => d.gate.length === 0;
  const sources = doors.filter((d) => d.flow !== "out" && plain(d));
  const targets = doors.filter((d) => d.flow !== "in" && plain(d));
  const g0 = graph([]);
  const reach = new Map(sources.map((s) => [s.id, reachableFrom(g0, `in:${s.id}`)]));

  for (const s of sources) {
    const r = reach.get(s.id)!;
    for (const t of targets) if (t.id !== s.id && !r.has(`out:${t.id}`)) problems.push(`can't get from door ${s.id} to door ${t.id}`);
    for (const d of doors) {
      if (d.flow === "in" && r.has(`out:${d.id}`)) problems.push(`the drop-in door ${d.id} can be climbed back up from ${s.id}`);
      if (!plain(d) && r.has(`out:${d.id}`)) problems.push(`the gated door ${d.id} is reachable from ${s.id} with no abilities`);
    }
  }

  // No traps with no abilities: every reachable surface reaches every exit.
  if (sources.length && targets.length) {
    const nodes = new Set<string>();
    for (const r of reach.values()) for (const n of r) nodes.add(n);
    const back = backEdges(g0, nodes);
    for (const t of targets) {
      const seen = backReach(back, [`out:${t.id}`]);
      const stuck = [...nodes].filter((n) => n.startsWith("s") && !seen.has(n));
      if (stuck.length) problems.push(`stuck: from ${stuck.length} reachable surface(s) (e.g. ${describe(g0, stuck[0]!)}) there is no way to door ${t.id}`);
    }
  }

  for (const d of doors.filter((d) => !plain(d))) {
    const from = sources[0];
    if (from && !reachableFrom(graph(d.gate), `in:${from.id}`).has(`out:${d.id}`)) problems.push(`the gated door ${d.id} can't be reached with ${d.gate.join("+")}`);
    for (const a of d.gate) {
      const others = ALL.filter((b) => b !== a);
      const bypass = crop && d.area ? cropReaches(grid, doors, d, p, others, ledge) : sources.some((s) => reachableFrom(graph(others), `in:${s.id}`).has(`out:${d.id}`));
      if (bypass) problems.push(`the gated door ${d.id} can be reached without ${a}`);
    }
    if (d.flow === "both" && targets.length) {
      const back = reachableFrom(graph(d.gate), `in:${d.id}`);
      for (const t of targets) if (!back.has(`out:${t.id}`)) problems.push(`no way back from the gated door ${d.id} to door ${t.id} with ${d.gate.join("+")}`);
    }
  }

  // With every ability (deep), no traps either: everywhere reachable can still leave the room.
  const exits = doors.filter((d) => d.flow !== "in").map((d) => `out:${d.id}`);
  if (options.deep && sources.length && exits.length) {
    const gAll = graph(ALL);
    const nodes = new Set<string>();
    for (const s of sources) for (const n of reachableFrom(gAll, `in:${s.id}`)) nodes.add(n);
    const seen = backReach(backEdges(gAll, nodes), exits);
    const stuck = [...nodes].filter((n) => n.startsWith("s") && !seen.has(n));
    if (stuck.length) problems.push(`stuck with every ability: from ${stuck.length} surface(s) (e.g. ${describe(gAll, stuck[0]!)}) there is no way out`);
  }

  for (const run of unstandableRuns(grid, p, ledge)) problems.push(`unstandable platform at row ${run.row}, columns ${run.c0}-${run.c1}`);
  for (const d of doors) if (opensOntoHazard(grid, d)) problems.push(`door ${d.id} opens onto a hazard`);

  const surfaces = new Set<string>();
  for (const r of reach.values()) for (const n of r) if (n.startsWith("s")) surfaces.add(n);
  return { ok: problems.length === 0, problems, surfaces: surfaces.size, ms: Math.round(performance.now() - t0) };
}

function backEdges(g: RoomGraph, nodes: Set<string>): Map<string, string[]> {
  const back = new Map<string, string[]>();
  for (const n of nodes) {
    for (const m of g.moves(n)) {
      let list = back.get(m.to);
      if (!list) back.set(m.to, (list = []));
      list.push(n);
    }
  }
  return back;
}

function backReach(back: Map<string, string[]>, from: string[]): Set<string> {
  const seen = new Set(from);
  const queue = [...from];
  for (let i = 0; i < queue.length; i++) for (const prev of back.get(queue[i]!) ?? []) if (!seen.has(prev)) (seen.add(prev), queue.push(prev));
  return seen;
}

/**
 * Can the door be reached with `abilities` from anywhere in a crop of the room
 * around it (as far as any move with every ability carries, past the door's
 * block)? The crop's cut edges are walls; doors on the room's edge stay.
 */
function cropReaches(grid: TileGrid, doors: readonly ProofDoor[], door: ProofDoor, p: MovementParams, abilities: MovementAbility[], ledge: number): boolean {
  const cols = gridCols(grid);
  const rows = gridRows(grid);
  const model = movementModel(p, abilities);
  const reach = Math.ceil((Math.max(model.maxGap(0), model.maxGap(model.maxHeight)) + model.maxHeight) / TILE) + 4;
  const a = door.area!;
  const c0 = Math.max(0, a.c0 - reach);
  const c1 = Math.min(cols - 1, a.c1 + reach);
  const r0 = Math.max(0, a.r0 - reach);
  const r1 = Math.min(rows - 1, a.r1 + reach);
  const sub: string[] = [];
  for (let r = r0; r <= r1; r++) {
    let line = "";
    for (let c = c0; c <= c1; c++) {
      const cutEdge = (c === c0 && c0 > 0) || (c === c1 && c1 < cols - 1) || (r === r0 && r0 > 0) || (r === r1 && r1 < rows - 1);
      line += cutEdge ? "#" : (grid.rows[r]![c] ?? "#");
    }
    sub.push(line);
  }
  const shifted = doors
    .map((d) => ({ ...d, offset: d.offset - (d.side === "left" || d.side === "right" ? r0 : c0) }))
    .filter((d) => {
      const along = d.side === "left" || d.side === "right";
      const onEdge = d.side === "left" ? c0 === 0 : d.side === "right" ? c1 === cols - 1 : d.side === "top" ? r0 === 0 : r1 === rows - 1;
      return onEdge && d.offset >= 0 && d.offset + d.size <= (along ? r1 - r0 + 1 : c1 - c0 + 1);
    });
  const g = roomGraph({ rows: sub }, shifted, p, abilities, { ledgeThickness: ledge });
  // Start anywhere outside the block (inside it, past the gate, the door is trivially near).
  const inside = (i: number) => {
    const s = g.surfaces[i]!;
    const col = Math.floor((s.x0 + s.x1) / 2 / TILE) + c0;
    const row = Math.round(s.y / TILE) + r0;
    return col >= a.c0 && col <= a.c1 && row >= a.r0 && row <= a.r1 + 1;
  };
  const seen = new Set<string>();
  for (let i = 0; i < g.surfaces.length; i++) {
    if (seen.has(`s${i}`) || inside(i)) continue;
    for (const n of reachableFrom(g, `s${i}`)) seen.add(n);
    if (seen.has(`out:${door.id}`)) return true;
  }
  return false;
}

function describe(g: RoomGraph, node: string): string {
  const s = g.surface(node);
  return s ? `feet y ${s.y}, x ${Math.round(s.x0)}-${Math.round(s.x1)}` : node;
}

/** A side door's first steps inward, or what is under a top door, is a hazard. */
function opensOntoHazard(grid: TileGrid, d: TraversalOpening): boolean {
  const cols = gridCols(grid);
  if (d.side === "left" || d.side === "right") {
    const row = d.offset + d.size;
    for (let i = 0; i < 4; i++) {
      const c = d.side === "left" ? i : cols - 1 - i;
      if (tileAt(grid, c, row) === "hazard" || tileAt(grid, c, row - 1) === "hazard") return true;
    }
    return false;
  }
  if (d.side === "top") {
    for (let c = d.offset; c < d.offset + d.size; c++) {
      let r = 1;
      while (r < grid.rows.length && tileAt(grid, c, r) === "empty") r++;
      if (tileAt(grid, c, r) === "hazard") return true;
    }
  }
  return false;
}
