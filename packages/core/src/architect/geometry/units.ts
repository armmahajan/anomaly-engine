import { movementModel } from "../../movement/model.ts";
import type { MovementParams } from "../../movement/params.ts";
import { TILE } from "../../world/tiles.ts";

/**
 * Sizes, in tiles, that room composition takes from the player's movement
 * (so rooms follow the creator's tuning, as the chunk library does).
 */
export interface Units {
  /** A comfortable plain-jump rise: floor steps and ladder rungs are at most this far apart. */
  rise: number;
  /** Rows the player's box takes. */
  body: number;
  /** Fewest rows of air above any floor. */
  air: number;
  /** Widest spike strip a plain jump clears with room to spare. */
  pit: number;
  /** Row of the rung under a top door (a plain jump from it leaves through the door). */
  topRung: number;
  /** Rows a drop-in chute's walls hang from the ceiling (no plain jump from below them reaches the top). */
  chute: number;
  /** Width of a ladder's rungs; a ladder is two columns of them, a tile apart, that zig-zag up. */
  half: number;
  /** Width of a ladder: two halves of rungs and the gap between them (so each rung has a clear edge to drop off). */
  ladder: number;
  /** Width of a top or bottom door. */
  hatch: number;
}

const memo = new Map<string, Units>();

export function unitsFor(p: MovementParams): Units {
  const key = JSON.stringify(p);
  let u = memo.get(key);
  if (u) return u;
  const model = movementModel(p, []);
  const rise = Math.max(2, Math.floor((model.maxHeight - 40) / TILE));
  const body = Math.ceil(p.height / TILE);
  const air = Math.max(rise + body + 1, body + 3);
  const pit = Math.max(1, Math.min(4, Math.floor((model.maxGap(0) - 96) / TILE)));
  const topRung = Math.max(body + 1, Math.floor((model.maxHeight - 40 + p.height / 2) / TILE));
  const chute = Math.ceil((model.maxHeight + p.height / 2 + 48) / TILE);
  const half = Math.max(3, Math.ceil((p.width * 2 + 8) / TILE));
  u = { rise, body, air, pit, topRung, chute, half, ladder: half * 2 + 1, hatch: Math.max(4, Math.ceil((p.width + 72) / TILE)) };
  memo.set(key, u);
  return u;
}
