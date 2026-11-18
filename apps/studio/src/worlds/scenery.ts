import { dressingOutOfDate, type BiomeAsset, type ProjectSpec, type WorldRoom } from "@anomaly/core";

/**
 * The words the studio uses for world art, and how it relates to the game's rooms:
 *
 * - a **look** (a biome asset) is a region's art kit: background planes, a ground
 *   texture and pieces (structures, props, lights);
 * - a **dressing** (one of a biome's rooms) arranges a look's pieces, fog and light
 *   over one game room's tiles;
 * - a **game room** (Rooms tab) is the layout: tiles, doors, enemies, props. Its
 *   `dressing` names the look and the dressing drawn over it, or null for plain tiles.
 */

export type Look = BiomeAsset;
export type Dressing = BiomeAsset["rooms"][number];

export function looksOf(project: ProjectSpec): Look[] {
  return project.art.assets.filter((a): a is Look => a.kind === "biome");
}

/** The game rooms a dressing is drawn over. */
export function roomsDressedBy(project: ProjectSpec, lookId: string, dressingId: string): WorldRoom[] {
  return project.world.rooms.filter((r) => r.dressing?.biome === lookId && r.dressing.room === dressingId);
}

export type ArtState = "plain" | "dressed" | "stale";

export interface RoomArt {
  state: ArtState;
  look: Look | null;
  dressing: Dressing | null;
}

/** A game room's art: plain tiles, dressed, or dressed but its tiles or doors changed since. */
export function roomArt(project: ProjectSpec, room: WorldRoom): RoomArt {
  const d = room.dressing;
  if (!d) return { state: "plain", look: null, dressing: null };
  const look = looksOf(project).find((l) => l.id === d.biome) ?? null;
  const dressing = look?.rooms.find((r) => r.id === d.room) ?? null;
  return { state: dressingOutOfDate(room) ? "stale" : "dressed", look, dressing };
}

export const ART_STATE_TEXT: Record<ArtState, string> = {
  plain: "Plain tiles: no scenery yet",
  dressed: "Dressed with scenery",
  stale: "Dressed, but its tiles or doors changed since: the scenery needs recomposing",
};

export interface RegionGroup {
  /** Region id, or "" for rooms in no region. */
  id: string;
  name: string;
  color: string | undefined;
  /** Rooms the region plans for (progression), if it is a region. */
  planned: number | null;
  rooms: WorldRoom[];
}

/** A stable, distinct color per progression region (by its place in the list). */
export function regionColor(project: ProjectSpec, regionId: string | null | undefined): string | undefined {
  const i = project.progression.regions.findIndex((r) => r.id === regionId);
  return i < 0 ? undefined : `hsl(${(i * 137.5 + 200) % 360} 45% 32%)`;
}

/** The game rooms by progression region (in the progression's order), then the rooms in none. */
export function regionGroups(project: ProjectSpec): RegionGroup[] {
  const { regions } = project.progression;
  const known = new Set(regions.map((r) => r.id));
  const groups: RegionGroup[] = regions.map((r) => ({
    id: r.id,
    name: r.name,
    color: regionColor(project, r.id),
    planned: r.rooms,
    rooms: project.world.rooms.filter((w) => w.regionId === r.id),
  }));
  const loose = project.world.rooms.filter((w) => !w.regionId || !known.has(w.regionId));
  if (loose.length > 0) groups.push({ id: "", name: regions.length > 0 ? "No region" : "All rooms", color: undefined, planned: null, rooms: loose });
  return groups;
}

export interface LookUsage {
  /** Game rooms dressed with any of the look's dressings. */
  rooms: WorldRoom[];
  /** Their progression regions, by name (rooms in no region add none). */
  regions: string[];
}

export function lookUsage(project: ProjectSpec, look: Look): LookUsage {
  const rooms = project.world.rooms.filter((r) => r.dressing?.biome === look.id);
  const names = new Map(project.progression.regions.map((r) => [r.id, r.name]));
  const regions = [...new Set(rooms.flatMap((r) => (r.regionId && names.get(r.regionId) ? [names.get(r.regionId)!] : [])))];
  return { rooms, regions };
}

/** The look a plain game room would most likely use: the one its region's other rooms use, else the first. */
export function lookForRoom(project: ProjectSpec, room: WorldRoom): Look | null {
  const looks = looksOf(project);
  const neighbour = project.world.rooms.find((r) => r.id !== room.id && r.regionId && r.regionId === room.regionId && r.dressing);
  return looks.find((l) => l.id === neighbour?.dressing?.biome) ?? looks[0] ?? null;
}

/** "Arena", "Arena and Hall", "Arena, Hall and 3 more". */
export function nameList(names: string[], max = 2): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** An estimate in dollars, short: "$0.005", "$0.07". */
export const approx = (usd: number): string => `$${Number(usd.toFixed(3))}`;
