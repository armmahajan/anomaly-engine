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
 * - front: silhouettes hang from the top edge or rise from below the bottom;
 *   a span crosses the top edge like a beam overhead.
 * - spans (beams, lintels, logs, bridges) rest across two supports: the tops
 *   of standing structures in their layer, or (in the play layer) platform
 *   tops and walls an end is set into. Without two supports at one height
 *   they lie on the surface below like any standing piece.
 */

/** How far (px) a piece's anchor may be above a surface and still count as on it. */
const TOLERANCE = 24;
/** At most this share of a standing piece may overhang a ledge's edge. */
const OVERHANG = 0.25;
/** The outer share of a span, at each end, that must rest on a support. */
const SPAN_END = 0.25;
/** Two supports this close in height (px) carry a span between them. */
const SPAN_LEVEL = 16;

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

/** The other pieces in the room, for spans to rest on. */
export interface SnapNeighbours {
  placements: (Placeable & { piece: string; id?: string })[];
  pieces: (PieceShape & { id: string })[];
}

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

/** On-screen width and height of a placed piece. */
function extent(piece: PieceShape, scale = 1): { width: number; height: number } {
  const height = piece.size * scale;
  return { width: height * (piece.width / piece.height), height };
}

export function snapPlacement<P extends Placeable & { id?: string }>(
  placement: P,
  piece: PieceShape | undefined,
  room: SnapRoom,
  neighbours?: SnapNeighbours,
): Snapped<P> {
  if (!piece) return { placement, moved: false, unsupported: false };
  const hanging = piece.kind === "hanging";
  let { x, y } = placement;
  let unsupported = false;

  const span = piece.kind === "span" && placement.layer !== "front" ? spanLevel(placement, piece, room, neighbours) : null;
  if (span !== null) {
    y = span;
  } else if (placement.layer === "front") {
    if (hanging) y = Math.min(y, 0);
    else if (piece.kind === "span") y = Math.min(y, extent(piece, placement.scale).height);
    else y = Math.max(y, room.height + 40);
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
      const width = extent(piece, placement.scale).width;
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

/** What can hold up one end of a span: a top at one height, or a solid block it is set into (any height inside it). */
type Support = { top: number } | { from: number; to: number };

/**
 * The height (bottom y) at which a span rests on supports under both ends, nearest
 * to where it was put (preferring the first level at or below it), or null if none.
 */
function spanLevel(
  placement: Placeable & { id?: string },
  piece: PieceShape,
  room: SnapRoom,
  neighbours: SnapNeighbours | undefined,
): number | null {
  const { width } = extent(piece, placement.scale);
  const ends = [
    [placement.x - width / 2, placement.x - width / 2 + width * SPAN_END],
    [placement.x + width / 2 - width * SPAN_END, placement.x + width / 2],
  ] as const;
  const overlaps = (a: number, b: number, [lo, hi]: readonly [number, number]) => a <= hi && b >= lo;

  // Standing structures in the same layer (pillars, walls), by their tops.
  const shapes = new Map(neighbours?.pieces.map((p) => [p.id, p]));
  const pillars = (neighbours?.placements ?? []).flatMap((other) => {
    const shape = shapes.get(other.piece);
    if (other === placement || (placement.id && other.id === placement.id) || other.layer !== placement.layer) return [];
    if (!shape || shape.kind !== "structure") return [];
    const size = extent(shape, other.scale);
    return [{ x0: other.x - size.width / 2, x1: other.x + size.width / 2, top: other.y - size.height }];
  });
  const supports = ends.map((end) => {
    const found: Support[] = pillars.filter((p) => overlaps(p.x0, p.x1, end)).map((p) => ({ top: p.top }));
    if (placement.layer === "play") {
      for (const p of room.platforms) {
        if (!overlaps(p.x, p.x + p.width, end)) continue;
        found.push({ top: p.y });
        // An end over a wall (taller than wide) can be set into it at any height.
        if (p.height > p.width) found.push({ from: p.y + SPAN_LEVEL, to: p.y + p.height });
      }
    }
    return found;
  });

  const holds = (s: Support, level: number) => ("top" in s ? Math.abs(s.top - level) <= SPAN_LEVEL : s.from <= level && level <= s.to);
  const candidates = [placement.y, ...supports.flat().map((s) => ("top" in s ? s.top : s.from))];
  const levels = candidates.filter((level) => supports.every((side) => side.some((s) => holds(s, level))));
  // Rest on the higher of two nearly level tops (a beam sits on the taller support).
  const rested = levels.map((level) => {
    const tops = supports.flatMap((side) => side.filter((s): s is { top: number } => "top" in s && holds(s, level)).map((s) => s.top));
    return tops.length ? Math.min(...tops) : level;
  });
  if (rested.length === 0) return null;
  const below = rested.filter((level) => level >= placement.y - TOLERANCE);
  return below.length ? Math.min(...below) : Math.max(...rested);
}

/**
 * Snap a room's placements; reports how many moved and which stand on nothing.
 * Spans go last, so they rest on where the structures ended up.
 */
export function snapPlacements<P extends Placeable & { piece: string; id?: string }>(
  placements: P[],
  pieces: (PieceShape & { id: string })[],
  room: SnapRoom,
): { placements: P[]; moved: number; unsupported: string[] } {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  let moved = 0;
  const unsupported: string[] = [];
  const out = placements.slice();
  const snapAt = (i: number) => {
    const p = out[i]!;
    const snapped = snapPlacement(p, byId.get(p.piece), room, { placements: out, pieces });
    if (snapped.moved) moved++;
    if (snapped.unsupported) unsupported.push(p.id ?? p.piece);
    out[i] = snapped.placement;
  };
  const isSpan = (p: P) => byId.get(p.piece)?.kind === "span";
  out.forEach((p, i) => !isSpan(p) && snapAt(i));
  out.forEach((p, i) => isSpan(p) && snapAt(i));
  return { placements: out, moved, unsupported };
}
