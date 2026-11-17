import type { MovementAbility, MovementParams } from "../../movement/params.ts";
import { gridCols, gridRows } from "../../world/tiles.ts";
import type { DoorSide } from "../../world/world.ts";
import { gateBlock } from "./blocks.ts";
import type { Units } from "./units.ts";

/**
 * The smallest room (tiles) that holds its doors: a band (storey) for each
 * side door and each gated door's block on a side, with room between; across
 * the width, the side gates' blocks plus whatever the top and bottom doors
 * need (ladders, chutes, holes, blocks) plus ladders between bands.
 */
export function minimumSize(
  p: MovementParams,
  u: Units,
  doors: readonly { side: DoorSide; gate: readonly MovementAbility[]; flow: "both" | "out" | "in" }[],
): { cols: number; rows: number } {
  const band = u.air + 2;
  const block = (d: (typeof doors)[number]) => gateBlock(p, u, d.gate, d.side, { twoWay: d.flow === "both" });
  const on = (s: DoorSide) => doors.filter((d) => d.side === s);
  let rows = 10;
  for (const s of ["left", "right"] as const) {
    const h = on(s).reduce((sum, d) => sum + (d.gate.length ? gridRows(block(d).grid) + u.air + 2 : band), 0);
    rows = Math.max(rows, h + 3);
  }
  const sideWidth = (s: DoorSide) => Math.max(0, ...on(s).filter((d) => d.gate.length).map((d) => gridCols(block(d).grid)));
  const edgeWidth = (s: "top" | "bottom") =>
    on(s).reduce((w, d) => {
      if (!d.gate.length) return w + (s === "top" ? u.hatch + u.half + 6 : u.hatch + 6);
      const b = block(d);
      rows = Math.max(rows, gridRows(b.grid) + 2 * band + 3);
      return w + gridCols(b.grid) + 4;
    }, 0);
  const cols = sideWidth("left") + sideWidth("right") + Math.max(edgeWidth("top"), edgeWidth("bottom")) + 2 * (u.ladder + 2) + 10;
  // Each gate along the top or bottom beyond the first cuts more bands: a band more for each.
  const edgeGates = [...on("top"), ...on("bottom")].filter((d) => d.gate.length).length;
  if (edgeGates > 1) rows += (edgeGates - 1) * band;
  // The top band is taller under a chute or a top door's ladder; side doors need a band each below it.
  const first = Math.max(band, on("top").some((d) => d.flow === "in" && !d.gate.length) ? u.chute + 5 : 0, on("top").length ? u.topRung + band + 2 : 0);
  const most = Math.max(on("left").length, on("right").length, 1);
  rows = Math.max(rows, first + (most - 1) * (band + u.rise) + 3);
  return { cols: Math.min(240, Math.max(16, cols)), rows: Math.min(135, rows) };
}
