import type { PlatformRect, WorldLayer, WorldPiece } from "./world.ts";

/**
 * Snapping: pieces rest on something. Used when the AI composes a room and
 * when the creator drops a dragged piece, so nothing floats.
 *
 * - play layer: a standing piece drops onto the first surface at or below
 *   it (or the nearest one, if it was sunk into a platform) and is nudged in
 *   so at most a quarter of it overhangs the edge; a hanging piece rises to
 *   the underside of the platform above it, or the room's top.
 * - mid and back layers scroll at other speeds, so ledges don't line up with
 *   them: standing pieces only stay at or below the floor line (they may rise
 *   from behind it); hanging ones start at the room's top or above.
 * - front: silhouettes hang from the top edge or rise from below the bottom.
 */

/** How far (px) a piece's anchor may be above a surface and still count as on it. */
const TOLERANCE = 24;
/** At most this share of a standing piece may overhang a ledge's edge. */
const OVERHANG = 0.25;

export interface SnapRoom {
  width: number;
  height: number;
  platforms: PlatformRect[];
}

interface Placeable {
  layer: WorldLayer;
  x: number;
  y: number;
  scale?: number;
}

type PieceShape = Pick<WorldPiece, "kind" | "size" | "width" | "height">;

export interface Snapped<P> {
  placement: P;
  moved: boolean;
  /** A standing play piece with no platform under it (over a pit or outside the room). */
  unsupported: boolean;
}

/** The floor line: the top of the widest platform inside the room (else the room's bottom). */
export function floorLine(room: SnapRoom): number {
  const inside = room.platforms.filter((p) => p.x < room.width && p.x + p.width > 0);
  const widest = inside.sort((a, b) => b.width - a.width)[0];
  return widest ? widest.y : room.height;
}

export function snapPlacement<P extends Placeable>(placement: P, piece: PieceShape | undefined, room: SnapRoom): Snapped<P> {
  if (!piece) return { placement, moved: false, unsupported: false };
  const hanging = piece.kind === "hanging";
  let { x, y } = placement;
  let unsupported = false;

  if (placement.layer === "front") {
    y = hanging ? Math.min(y, 0) : Math.max(y, room.height + 40);
  } else if (placement.layer === "mid" || placement.layer === "back" || placement.layer === "far") {
    y = hanging ? Math.min(y, 0) : Math.max(y, floorLine(room));
  } else {
    const under = room.platforms.filter((p) => p.x <= x && x <= p.x + p.width);
    if (hanging) {
      const above = under.filter((p) => p.y + p.height <= y + TOLERANCE);
      y = above.length ? Math.max(...above.map((p) => p.y + p.height)) : 0;
    } else if (under.length === 0) {
      unsupported = true;
    } else {
      const below = under.filter((p) => p.y >= y - TOLERANCE);
      const surface = below.length
        ? below.reduce((a, b) => (b.y < a.y ? b : a))
        : under.reduce((a, b) => (b.y > a.y ? b : a)); // sunk into platforms: the lowest top is nearest
      y = surface.y;
      const width = piece.size * (placement.scale ?? 1) * (piece.width / piece.height);
      const lo = surface.x + width * OVERHANG;
      const hi = surface.x + surface.width - width * OVERHANG;
      x = lo > hi ? surface.x + surface.width / 2 : Math.min(Math.max(x, lo), hi);
    }
  }
  x = Math.round(x);
  y = Math.round(y);
  const moved = x !== Math.round(placement.x) || y !== Math.round(placement.y);
  return { placement: moved ? { ...placement, x, y } : placement, moved, unsupported };
}

/** Snap a room's placements; reports how many moved and which stand on nothing. */
export function snapPlacements<P extends Placeable & { piece: string; id?: string }>(
  placements: P[],
  pieces: (PieceShape & { id: string })[],
  room: SnapRoom,
): { placements: P[]; moved: number; unsupported: string[] } {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  let moved = 0;
  const unsupported: string[] = [];
  const out = placements.map((p) => {
    const snapped = snapPlacement(p, byId.get(p.piece), room);
    if (snapped.moved) moved++;
    if (snapped.unsupported) unsupported.push(p.id ?? p.piece);
    return snapped.placement;
  });
  return { placements: out, moved, unsupported };
}
