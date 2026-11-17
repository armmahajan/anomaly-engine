import type { MovementAbility, MovementParams } from "../../movement/params.ts";
import { isOpen, TILE, type TileGrid } from "../../world/tiles.ts";
import { reachableFrom, roomGraph, type StandingSurface } from "../../world/traversal.ts";
import type { Door } from "../../world/world.ts";

/**
 * Where things can go in a built room: spots on standing surfaces the player
 * reaches, found from the room's traversal graph (the runtime's physics).
 *
 * A surface counts by how many of the room's door entries reach it (best:
 * all of them), then by how many of its doors can be left through from it
 * (so nothing sits where standing traps you). Only the best tier is used;
 * a room without doors (a start room on its own) uses all its surfaces.
 * Spots are sampled along each surface every half tile; picking one takes the
 * free spot (its box clear of tiles and hazards) farthest from the door
 * entries and from what is already placed, so things spread out and enemies
 * keep away from the doors, and off the ends of surfaces. Deterministic: ties
 * go to the first sample (surfaces in the graph's order, left to right).
 */

export interface Spot {
  /** Feet: bottom-centre, px from the room's top-left. */
  x: number;
  y: number;
}

export interface PickOptions {
  /** The box that stands there (feet at the spot). */
  width: number;
  height: number;
  /** Distance (px) from door entries that counts as far enough; nearer spots are used only if nothing is. */
  awayFromDoors?: number;
}

export interface RoomSpots {
  /** The surfaces used (best reachable tier). */
  surfaces: StandingSurface[];
  /** Where entering through each door puts the player. */
  doors: Spot[];
  /** The best free spot, or null; marks it taken. */
  pick(options: PickOptions): Spot | null;
}

export function roomSpots(
  room: { grid: TileGrid; doors: readonly Door[] },
  params: MovementParams,
  abilities: readonly MovementAbility[],
  ledgeThickness: number,
): RoomSpots {
  const graph = roomGraph(room.grid, room.doors, params, abilities, { ledgeThickness });
  const keys = graph.surfaces.map((_, i) => `s${i}`);
  const entries = room.doors.map((d) => `in:${d.id}`);
  const reached = entries.map((e) => reachableFrom(graph, e));
  const inScore = keys.map((k) => reached.filter((r) => r.has(k)).length);
  const bestIn = Math.max(0, ...inScore);
  let tier = keys.map((_, i) => i).filter((i) => inScore[i] === bestIn);
  if (room.doors.length) {
    const outScore = new Map(tier.map((i) => [i, room.doors.filter((d) => reachableFrom(graph, keys[i]!).has(`out:${d.id}`)).length]));
    const bestOut = Math.max(0, ...outScore.values());
    tier = tier.filter((i) => outScore.get(i) === bestOut);
  }
  const surfaces = tier.map((i) => graph.surfaces[i]!);
  const doors = entries.map((e) => graph.entry(e)).flatMap((s) => (s ? [{ x: s.x, y: s.y }] : []));

  const samples: (Spot & { edge: number })[] = [];
  for (const s of surfaces) {
    const xs = new Set<number>([s.x0, s.x1, (s.x0 + s.x1) / 2]);
    for (let x = Math.ceil(s.x0 / (TILE / 2)) * (TILE / 2); x <= s.x1; x += TILE / 2) xs.add(x);
    for (const x of [...xs].sort((a, b) => a - b)) samples.push({ x: Math.round(x), y: s.y, edge: Math.min(x - s.x0, s.x1 - x) });
  }
  const taken: Spot[] = [];
  const dist = (a: Spot, b: Spot) => Math.hypot(a.x - b.x, a.y - b.y);
  const nearest = (p: Spot, list: Spot[]) => list.reduce((m, q) => Math.min(m, dist(p, q)), Infinity);

  return {
    surfaces,
    doors,
    pick({ width, height, awayFromDoors = 0 }) {
      let best: { spot: Spot; key: number[] } | null = null;
      for (const { edge, ...spot } of samples) {
        if (!isOpen(room.grid, spot.x, spot.y, width, height, ledgeThickness)) continue;
        const fromDoors = nearest(spot, doors);
        const fromTaken = nearest(spot, taken);
        // Far enough from the doors first; then spread out from what is placed (capped, so a huge room
        // doesn't push everything into its corners); then farther from the doors; then off the surface's ends.
        const key = [fromDoors >= awayFromDoors ? 1 : 0, Math.min(fromTaken, 8 * TILE), Math.min(fromDoors, 12 * TILE), Math.min(edge, 2 * TILE)];
        if (!best || better(key, best.key)) best = { spot, key };
      }
      if (best) taken.push(best.spot);
      return best?.spot ?? null;
    },
  };
}

function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! > b[i]! + 1e-6) return true;
    if (a[i]! < b[i]! - 1e-6) return false;
  }
  return false;
}
