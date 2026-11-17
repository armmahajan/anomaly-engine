import type { DoorSide } from "../../world/world.ts";
import type { Units } from "./units.ts";

/**
 * How many doors fit on a side of a room of this size. Side doors each sit on
 * their own band (a storey of the room); top and bottom doors each need a
 * ladder's width of ceiling or floor. Layout keeps links within these, and the
 * geometry stage reports a side that has more.
 */
export function bandsFit(rows: number, u: Units): number {
  return Math.max(1, Math.floor((rows - 2) / (u.air + 1)));
}

export function doorCapacity(cols: number, rows: number, side: DoorSide, u: Units): number {
  if (side === "left" || side === "right") return bandsFit(rows, u);
  return Math.max(1, Math.floor((cols - 2) / (u.ladder + 4)));
}
