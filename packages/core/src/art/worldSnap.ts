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
/** A structure holds things up along this middle share of its width (images are often wider at the base). */
const SUPPORT_TOP = 0.6;

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

/** The floor line: the top of the widest platform in the room's lower half (else the room's bottom); a ceiling can be wider. */
export function floorLine(room: SnapRoom): number {
  const inside = room.platforms.filter((p) => p.x < room.width && p.x + p.width > 0 && p.y >= room.height / 2);
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
  const { width, height } = extent(piece, placement.scale);
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
    const half = (size.width * SUPPORT_TOP) / 2;
    return [{ x0: other.x - half, x1: other.x + half, top: other.y - size.height }];
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
  // Never above the room's top edge (it would be out of view).
  const levels = candidates.filter((level) => level >= height && supports.every((side) => side.some((s) => holds(s, level))));
  // Rest on the higher of two nearly level tops (a beam sits on the taller support).
  const rested = levels.map((level) => {
    const tops = supports.flatMap((side) => side.filter((s): s is { top: number } => "top" in s && holds(s, level)).map((s) => s.top));
    return tops.length ? Math.min(...tops) : level;
  });
  const visible = rested.filter((level) => level >= height);
  if (visible.length === 0) return null;
  const below = visible.filter((level) => level >= placement.y - TOLERANCE);
  return below.length ? Math.min(...below) : Math.max(...visible);
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

// --- doors and passages ----------------------------------------------------------------

/**
 * Readable paths: after snapping, nothing near the play plane may cover a door
 * opening or its approach, and no hanging piece may reach down into the space
 * the player moves through. "Near the play plane" is the play and front layers
 * and big pieces (structures, spans) in the back layer; mid pieces are distant
 * and fogged. Parallax layers are checked where they are seen while the camera
 * is at the door (mirrors game/scripts/art/world_view.gd).
 */

/** How fast each layer scrolls with the camera (world_view.gd SCROLL). */
export const LAYER_SCROLL: Record<WorldLayer, number> = { far: 0.12, mid: 0.38, back: 0.72, play: 1, front: 1.35 };
/** Half the play view's width (px): the camera stops this far inside a room's sides. */
export const VIEW_HALF_WIDTH = 480;
/** Front silhouettes are never taller than this share of the room (world_view.gd). */
const FRONT_MAX = 0.42;
const TILE_PX = 32;
/** How far (px) past the wall a door's approach reaches into the room. */
export const DOOR_APPROACH = 4 * TILE_PX;
/** Room (px) a hanging play piece must leave above the surface under it. */
export const PASSAGE_CLEARANCE = 3 * TILE_PX;
/** A piece that would have to move further than this to clear a door is dropped instead. */
const MAX_PUSH = 640;
const GAP = 8;

export interface DoorOpening {
  side: "left" | "right" | "top" | "bottom";
  /** Tiles from the top (left/right) or the left (top/bottom). */
  offset: number;
  size: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A door's opening plus its approach, and where the camera is while the player is there. */
export function doorZone(door: DoorOpening, room: Pick<SnapRoom, "width" | "height">): { rect: Rect; camera: number } {
  const from = door.offset * TILE_PX;
  const length = door.size * TILE_PX;
  const depth = TILE_PX + DOOR_APPROACH;
  const rect: Rect =
    door.side === "left"
      ? { x: 0, y: from, width: depth, height: length }
      : door.side === "right"
        ? { x: room.width - depth, y: from, width: depth, height: length }
        : door.side === "top"
          ? { x: from, y: 0, width: length, height: depth }
          : { x: from, y: room.height - depth, width: length, height: depth };
  const camera = Math.min(Math.max(rect.x + rect.width / 2, VIEW_HALF_WIDTH), Math.max(VIEW_HALF_WIDTH, room.width - VIEW_HALF_WIDTH));
  return { rect, camera };
}

type Checked = Placeable & { piece: string; id?: string };

/** Pieces that can hide a path: play and front, and big back-layer pieces. */
function blocks(p: Checked, piece: PieceShape): boolean {
  return p.layer === "play" || p.layer === "front" || (p.layer === "back" && (piece.kind === "structure" || piece.kind === "span"));
}

/** Where a placed piece is drawn (room px) while the camera is centred at room x `camera`. */
export function seenRect(p: Checked, piece: PieceShape, room: Pick<SnapRoom, "height">, camera: number): Rect {
  let { width, height } = extent(piece, p.scale);
  let y = p.y;
  if (p.layer === "front") {
    const capped = Math.min(height, room.height * FRONT_MAX);
    width *= capped / height;
    height = capped;
    if (piece.kind === "hanging") y = Math.min(y, 0);
    else if (piece.kind === "span") y = Math.min(y, height);
    else y = Math.max(y, room.height + 40);
  }
  const f = LAYER_SCROLL[p.layer];
  const x = p.x * f + camera * (1 - f);
  return { x: x - width / 2, y: piece.kind === "hanging" ? y : y - height, width, height };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Placements covering a door's opening or approach, as [placement id (else piece id), door index]. */
export function doorBlockers(placements: Checked[], pieces: (PieceShape & { id: string })[], room: SnapRoom, doors: DoorOpening[]): [string, number][] {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const zones = doors.map((d) => doorZone(d, room));
  return placements.flatMap((p) => {
    const piece = byId.get(p.piece);
    if (!piece || !blocks(p, piece)) return [];
    return zones.flatMap((z, i) => (overlaps(seenRect(p, piece, room, z.camera), z.rect) ? [[p.id ?? p.piece, i] as [string, number]] : []));
  });
}

/** How far (px) a hanging play piece reaches into the clearance above the surface under it (<= 0: clear). */
export function passageIntrusion(p: Checked, piece: PieceShape, room: SnapRoom): number {
  if (p.layer !== "play" || piece.kind !== "hanging") return 0;
  const { width, height } = extent(piece, p.scale);
  const below = room.platforms.filter((r) => r.x < p.x + width / 2 && p.x - width / 2 < r.x + r.width && r.y > p.y);
  const surface = below.length ? Math.min(...below.map((r) => r.y)) : room.height;
  return p.y + height - (surface - PASSAGE_CLEARANCE);
}

/**
 * Keep doors and passages clear: a piece covering a door is pushed away from it
 * along x and snapped again, or dropped if that doesn't clear it (or would move it
 * far); a hanging play piece reaching into the space above a surface is shortened,
 * or dropped if it would get too small. Reports what changed, by placement id.
 */
export function clearPassages<P extends Checked>(
  placements: P[],
  pieces: (PieceShape & { id: string })[],
  room: SnapRoom,
  doors: DoorOpening[],
): { placements: P[]; moved: string[]; scaled: string[]; dropped: string[] } {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const zones = doors.map((d) => doorZone(d, room));
  const inDoor = (p: P, piece: PieceShape) => blocks(p, piece) && zones.some((z) => overlaps(seenRect(p, piece, room, z.camera), z.rect));
  const name = (p: P) => p.id ?? p.piece;
  const pushed = placements.map((p) => {
    const piece = byId.get(p.piece);
    if (!piece || !inDoor(p, piece)) return p;
    let next = p;
    // Two passes: a push away from one door can land in another.
    for (let pass = 0; pass < 2; pass++) {
      for (const z of zones) {
        const seen = seenRect(next, piece, room, z.camera);
        if (!blocks(next, piece) || !overlaps(seen, z.rect)) continue;
        const right = z.rect.x + z.rect.width + GAP - seen.x;
        const left = z.rect.x - GAP - (seen.x + seen.width);
        // Side doors push inward; top and bottom ones to the nearer side.
        const toRight = z.rect.x <= 0 || (z.rect.x + z.rect.width < room.width && right <= -left);
        next = { ...next, x: Math.round(next.x + (toRight ? right : left) / LAYER_SCROLL[next.layer]) };
      }
    }
    return next;
  });
  const snapped = snapPlacements(pushed, pieces, room).placements;
  const moved: string[] = [];
  const scaled: string[] = [];
  const dropped: string[] = [];
  const out = snapped.flatMap((p, i) => {
    const piece = byId.get(p.piece);
    if (!piece) return [p];
    const before = placements[i]!;
    if (pushed[i] !== before) {
      if (inDoor(p, piece) || Math.abs(p.x - before.x) > MAX_PUSH || (p.layer === "play" && (p.x < 0 || p.x > room.width))) {
        dropped.push(name(p));
        return [];
      }
      moved.push(name(p));
    }
    const over = passageIntrusion(p, piece, room);
    if (over <= 0) return [p];
    const scale = p.scale ?? 1;
    const height = extent(piece, scale).height;
    const shorter = Math.floor((scale * (height - over)) / height * 100) / 100;
    if (shorter < Math.max(0.1, scale * 0.35)) {
      dropped.push(name(p));
      return [];
    }
    scaled.push(name(p));
    return [{ ...p, scale: shorter }];
  });
  return { placements: out, moved, scaled, dropped };
}
