import { MOVEMENT_ABILITIES, type MovementAbility, type MovementParams } from "../../movement/params.ts";
import { DEFAULT_LEDGE_THICKNESS, gridCols, tileAt, type TileGrid } from "../../world/tiles.ts";
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
 *   reach every door you can leave by, and with every ability some door;
 * - no unstandable platforms; doors don't open onto hazards.
 */

export interface ProofDoor extends TraversalOpening {
  gate: MovementAbility[];
  flow: "both" | "out" | "in";
}

export interface Proof {
  ok: boolean;
  problems: string[];
  /** Standing surfaces reachable with no abilities. */
  surfaces: number;
  ms: number;
}

const ALL = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];

export function proveRoom(grid: TileGrid, doors: readonly ProofDoor[], p: MovementParams, options: { ledgeThickness?: number } = {}): Proof {
  const t0 = performance.now();
  const ledge = options.ledgeThickness ?? DEFAULT_LEDGE_THICKNESS;
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
    const back = new Map<string, string[]>();
    for (const n of nodes) for (const m of g0.moves(n)) back.set(m.to, [...(back.get(m.to) ?? []), n]);
    for (const t of targets) {
      const seen = new Set([`out:${t.id}`]);
      const queue = [`out:${t.id}`];
      while (queue.length) for (const prev of back.get(queue.shift()!) ?? []) if (!seen.has(prev)) (seen.add(prev), queue.push(prev));
      const stuck = [...nodes].filter((n) => n.startsWith("s") && !seen.has(n));
      if (stuck.length) problems.push(`stuck: from ${stuck.length} reachable surface(s) (e.g. ${describe(g0, stuck[0]!)}) there is no way to door ${t.id}`);
    }
  }

  for (const d of doors.filter((d) => !plain(d))) {
    const from = sources[0];
    if (from) {
      const withIt = reachableFrom(graph(d.gate), `in:${from.id}`);
      if (!withIt.has(`out:${d.id}`)) problems.push(`the gated door ${d.id} can't be reached with ${d.gate.join("+")}`);
      for (const a of d.gate) {
        const g = graph(ALL.filter((b) => b !== a));
        if (sources.some((s) => reachableFrom(g, `in:${s.id}`).has(`out:${d.id}`))) problems.push(`the gated door ${d.id} can be reached without ${a}`);
      }
    }
    if (d.flow === "both" && targets.length) {
      const back = reachableFrom(graph(d.gate), `in:${d.id}`);
      for (const t of targets) if (!back.has(`out:${t.id}`)) problems.push(`no way back from the gated door ${d.id} to door ${t.id} with ${d.gate.join("+")}`);
    }
  }

  // With every ability, no traps either: everywhere reachable can still leave the room.
  const exits = doors.filter((d) => d.flow !== "in").map((d) => `out:${d.id}`);
  if (sources.length && exits.length) {
    const gAll = graph(ALL);
    const nodes = new Set<string>();
    for (const s of sources) for (const n of reachableFrom(gAll, `in:${s.id}`)) nodes.add(n);
    const back = new Map<string, string[]>();
    for (const n of nodes) for (const m of gAll.moves(n)) back.set(m.to, [...(back.get(m.to) ?? []), n]);
    const seen = new Set(exits);
    const queue = [...exits];
    while (queue.length) for (const prev of back.get(queue.shift()!) ?? []) if (!seen.has(prev)) (seen.add(prev), queue.push(prev));
    const stuck = [...nodes].filter((n) => n.startsWith("s") && !seen.has(n));
    if (stuck.length) problems.push(`stuck with every ability: from ${stuck.length} surface(s) (e.g. ${describe(gAll, stuck[0]!)}) there is no way out`);
  }

  for (const run of unstandableRuns(grid, p, ledge)) problems.push(`unstandable platform at row ${run.row}, columns ${run.c0}-${run.c1}`);
  for (const d of doors) if (opensOntoHazard(grid, d)) problems.push(`door ${d.id} opens onto a hazard`);

  const surfaces = new Set<string>();
  for (const r of reach.values()) for (const n of r) if (n.startsWith("s")) surfaces.add(n);
  return { ok: problems.length === 0, problems, surfaces: surfaces.size, ms: Math.round(performance.now() - t0) };
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
