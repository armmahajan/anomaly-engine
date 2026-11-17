import type { MovementAbility, MovementParams } from "../../movement/params.ts";
import { gridCols, gridRows } from "../../world/tiles.ts";
import type { DoorSide } from "../../world/world.ts";
import { gateBlock } from "./blocks.ts";
import type { Units } from "./units.ts";

/**
 * The smallest room (tiles) that holds its doors: each gated door's block
 * with floor around it, a band per side door, a drop-in chute's depth.
 */
export function minimumSize(
  p: MovementParams,
  u: Units,
  doors: readonly { side: DoorSide; gate: readonly MovementAbility[]; flow: "both" | "out" | "in" }[],
): { cols: number; rows: number } {
  let cols = 16;
  let rows = 10;
  const band = u.air + 1;
  const perSide = new Map<DoorSide, number>();
  for (const d of doors) {
    perSide.set(d.side, (perSide.get(d.side) ?? 0) + 1);
    if (d.gate.length) {
      const block = gateBlock(p, u, d.gate, d.side, { twoWay: d.flow === "both" });
      const bw = gridCols(block.grid);
      const bh = gridRows(block.grid);
      cols = Math.max(cols, bw + u.ladder + 8);
      rows = Math.max(rows, d.side === "left" || d.side === "right" ? bh + 4 : bh + band + 4);
    }
    if (d.side === "top" && d.flow === "in" && !d.gate.length) rows = Math.max(rows, u.chute + 6);
    if (d.side === "top" && !d.gate.length) rows = Math.max(rows, u.topRung + band + 4);
  }
  for (const s of ["left", "right"] as const) rows = Math.max(rows, (perSide.get(s) ?? 0) * (band + 1) + 2);
  for (const s of ["top", "bottom"] as const) cols = Math.max(cols, (perSide.get(s) ?? 0) * (u.ladder + 5) + 4);
  // Gated doors on both left and right share the width.
  const sideBlocks = doors.filter((d) => d.gate.length && (d.side === "left" || d.side === "right"));
  if (sideBlocks.some((d) => d.side === "left") && sideBlocks.some((d) => d.side === "right")) {
    const w = (s: DoorSide) => Math.max(0, ...sideBlocks.filter((d) => d.side === s).map((d) => gridCols(gateBlock(p, u, d.gate, d.side, { twoWay: d.flow === "both" }).grid)));
    cols = Math.max(cols, w("left") + w("right") + u.ladder + 8);
  }
  return { cols: Math.min(240, cols), rows: Math.min(135, rows) };
}
