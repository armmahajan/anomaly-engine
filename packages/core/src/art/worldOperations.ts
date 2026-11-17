import { roomFingerprint } from "../world/world.ts";
import { z } from "zod";
import { Color, Id } from "../common.ts";
import { uniqueId } from "../ids.ts";
import type { OperationError, OperationResult } from "../operations.ts";
import { ProjectSpec } from "../schema.ts";
import type { BiomeAsset } from "./asset.ts";
import { BiomeKit, Room, WorldLayer, WorldScene, type Dressing, type PlatformRect } from "./world.ts";
import { borderedGrid, fillTiles, gridCols, gridPlatforms, gridRows, gridSize, rectsToGrid, type TileGrid } from "../world/tiles.ts";

/**
 * World art operations (biomes, their rooms, placements, dressing world rooms). Same
 * contract as ../operations.ts: pure, untrusted input, whole-project check.
 * Rooms only dress tiles; a world room's collision changes only when the
 * creator accepts a suggested layout (applyRoomLayout).
 */

type Fail = { ok: false; error: OperationError };

const fail = (code: OperationError["code"], message: string, issues: OperationError["issues"] = []): Fail => ({
  ok: false,
  error: { code, message, issues },
});
const issuesOf = (error: z.ZodError, prefix = "") => error.issues.map((i) => ({ path: prefix + i.path.join("."), message: i.message }));
const list = (ids: string[]) => (ids.length > 0 ? ` (known: ${ids.join(", ")})` : " (none exist)");

function parse<T extends z.ZodType>(schema: T, input: unknown, op: string): { ok: true; data: z.infer<T> } | Fail {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, data: parsed.data } : fail("invalid_input", `${op} input is malformed`, issuesOf(parsed.error));
}

function commit(next: ProjectSpec): OperationResult {
  const parsed = ProjectSpec.safeParse({ ...next, revision: next.revision + 1 });
  if (!parsed.success) return fail("invalid_result", "operation would leave the project invalid", issuesOf(parsed.error));
  return { ok: true, project: parsed.data };
}

function findBiome(project: ProjectSpec, assetId: string): { ok: true; index: number; biome: BiomeAsset } | Fail {
  const index = project.art.assets.findIndex((a) => a.id === assetId);
  const asset = project.art.assets[index];
  const biomes = project.art.assets.filter((a) => a.kind === "biome").map((a) => a.id);
  if (!asset) return fail("not_found", `no biome "${assetId}"${list(biomes)}`);
  if (asset.kind !== "biome") return fail("invalid_input", `asset "${assetId}" is a ${asset.kind}, not a biome`);
  return { ok: true, index, biome: asset };
}

function findRoom(project: ProjectSpec, assetId: string, roomId: string) {
  const found = findBiome(project, assetId);
  if (!found.ok) return found;
  const roomIndex = found.biome.rooms.findIndex((r) => r.id === roomId);
  if (roomIndex < 0) return fail("not_found", `biome "${assetId}" has no room "${roomId}"${list(found.biome.rooms.map((r) => r.id))}`);
  return { ...found, roomIndex, room: found.biome.rooms[roomIndex]! };
}

function withBiome(project: ProjectSpec, index: number, biome: BiomeAsset): OperationResult {
  const assets = project.art.assets.slice();
  assets[index] = biome;
  return commit({ ...project, art: { ...project.art, assets } });
}

function withRoom(project: ProjectSpec, found: { index: number; biome: BiomeAsset; roomIndex: number }, room: unknown, what: string): OperationResult {
  const parsed = Room.safeParse(room);
  if (!parsed.success) return fail("invalid_input", `${what} would be invalid`, issuesOf(parsed.error));
  const rooms = found.biome.rooms.slice();
  rooms[found.roomIndex] = parsed.data;
  return withBiome(project, found.index, { ...found.biome, rooms });
}

/** Give every placement a stable id (pl_1, pl_2, ...), keeping existing ones. */
export function withPlacementIds<T extends { id?: string }>(placements: T[]): (T & { id: string })[] {
  const taken = new Set(placements.flatMap((p) => (p.id ? [p.id] : [])));
  let n = 1;
  return placements.map((p) => {
    if (p.id) return p as T & { id: string };
    while (taken.has(`pl_${n}`)) n++;
    const id = `pl_${n}`;
    taken.add(id);
    return { ...p, id };
  });
}

// --- kit and rooms (written by the world jobs) -----------------------------------

export const SetBiomeKitInput = z.strictObject({ assetId: Id, kit: z.unknown() });

export function setBiomeKit(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetBiomeKitInput, input, "setBiomeKit");
  if (!p.ok) return p;
  const found = findBiome(project, p.data.assetId);
  if (!found.ok) return found;
  const kit = BiomeKit.safeParse(p.data.kit);
  if (!kit.success) return fail("invalid_input", "kit is invalid", issuesOf(kit.error, "kit."));
  return withBiome(project, found.index, { ...found.biome, kit: kit.data });
}

export const AddRoomInput = z.strictObject({
  assetId: Id,
  room: z.unknown(),
  /** A world room to dress with it right away. */
  dressRoom: Id.nullable().default(null),
});

export function addRoom(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AddRoomInput, input, "addRoom");
  if (!p.ok) return p;
  const found = findBiome(project, p.data.assetId);
  if (!found.ok) return found;
  if (!found.biome.kit) return fail("invalid_input", `biome "${p.data.assetId}" has no kit yet`);
  const raw = p.data.room as { composition?: { placements?: { id?: string }[] } };
  const withIds = raw?.composition?.placements
    ? { ...raw, composition: { ...raw.composition, placements: withPlacementIds(raw.composition.placements) } }
    : raw;
  const room = Room.safeParse(withIds);
  if (!room.success) return fail("invalid_input", "room is invalid", issuesOf(room.error, "room."));
  if (found.biome.rooms.some((r) => r.id === room.data.id)) return fail("invalid_input", `a room "${room.data.id}" already exists`);
  const pieceIds = new Set(found.biome.kit.pieces.map((piece) => piece.id));
  const unknown = room.data.composition.placements.filter((pl) => !pieceIds.has(pl.piece)).map((pl) => pl.piece);
  if (unknown.length > 0) return fail("invalid_input", `room places unknown piece(s) ${[...new Set(unknown)].join(", ")}`);
  const next = withBiome(project, found.index, { ...found.biome, rooms: [...found.biome.rooms, room.data] });
  if (!next.ok || !p.data.dressRoom) return next;
  const target = worldRoomIndex(next.project, p.data.dressRoom);
  if (target < 0) return fail("not_found", `no world room "${p.data.dressRoom}" to dress`);
  return commit({ ...next.project, revision: project.revision, world: dressWorldRoom(next.project.world, target, { biome: found.biome.id, room: room.data.id }) });
}

export const SetRoomCompositionInput = z.strictObject({ assetId: Id, roomId: Id, composition: z.unknown() });

/** Replace a room's whole composition (the pipeline recomposes rooms after their kit's pieces are repainted). */
export function setRoomComposition(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetRoomCompositionInput, input, "setRoomComposition");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.assetId, p.data.roomId);
  if (!found.ok) return found;
  const raw = p.data.composition as { placements?: { id?: string }[] };
  const composition = raw?.placements ? { ...raw, placements: withPlacementIds(raw.placements) } : raw;
  return withRoom(project, found, { ...found.room, composition }, `room "${p.data.roomId}"`);
}

// --- editing ----------------------------------------------------------------------

export const UpdateRoomInput = z.strictObject({
  assetId: Id,
  roomId: Id,
  changes: z.strictObject({
    name: z.string().optional(),
    palette: z.strictObject({ ambient: Color.optional(), fog: Color.optional(), light: Color.optional(), shadow: Color.optional() }).optional(),
    fog: z.strictObject({ mid: z.number().optional(), back: z.number().optional(), play: z.number().optional() }).optional(),
    dust: z.strictObject({ color: Color.optional(), amount: z.number().optional() }).optional(),
    rays: z.array(z.unknown()).optional().describe("Replaces all light shafts."),
    lights: z.array(z.unknown()).optional().describe("Replaces all extra lights."),
  }),
});

/** Change a room's name or atmosphere (palette, fog, dust, shafts, lights). */
export function updateRoom(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdateRoomInput, input, "updateRoom");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.assetId, p.data.roomId);
  if (!found.ok) return found;
  const { changes } = p.data;
  const c = found.room.composition;
  const composition = {
    ...c,
    palette: { ...c.palette, ...changes.palette },
    fog: { ...c.fog, ...changes.fog },
    dust: { ...c.dust, ...changes.dust },
    ...(changes.rays ? { rays: changes.rays } : {}),
    ...(changes.lights ? { lights: changes.lights } : {}),
  };
  return withRoom(project, found, { ...found.room, ...(changes.name ? { name: changes.name } : {}), composition }, `room "${p.data.roomId}"`);
}

export const DeleteRoomInput = z.strictObject({ assetId: Id, roomId: Id });

export function deleteRoom(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(DeleteRoomInput, input, "deleteRoom");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.assetId, p.data.roomId);
  if (!found.ok) return found;
  const rooms = found.biome.rooms.filter((r) => r.id !== p.data.roomId);
  const assets = project.art.assets.slice();
  assets[found.index] = { ...found.biome, rooms };
  return commit({ ...project, art: { ...project.art, assets }, world: undress(project.world, (d) => d.biome === p.data.assetId && d.room === p.data.roomId) });
}

export const PlacementChanges = z.strictObject({
  x: z.number().optional(),
  y: z.number().optional(),
  layer: WorldLayer.optional(),
  scale: z.number().optional(),
  flip: z.boolean().optional(),
});

export const UpdatePlacementInput = z.strictObject({ assetId: Id, roomId: Id, placementId: Id, changes: PlacementChanges });

/** Move, re-layer, scale or flip one placed piece. */
export function updatePlacement(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdatePlacementInput, input, "updatePlacement");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.assetId, p.data.roomId);
  if (!found.ok) return found;
  const placements = found.room.composition.placements.slice();
  const i = placements.findIndex((pl) => pl.id === p.data.placementId);
  if (i < 0) return fail("not_found", `room "${p.data.roomId}" has no placement "${p.data.placementId}"`);
  placements[i] = { ...placements[i]!, ...p.data.changes };
  return withRoom(project, found, { ...found.room, composition: { ...found.room.composition, placements } }, `placement "${p.data.placementId}"`);
}

export const AddPlacementInput = z.strictObject({
  assetId: Id,
  roomId: Id,
  placement: z.strictObject({
    piece: Id,
    layer: WorldLayer,
    x: z.number(),
    y: z.number(),
    scale: z.number().default(1),
    flip: z.boolean().default(false),
  }),
});

/** Place a kit piece in a room. */
export function addPlacement(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AddPlacementInput, input, "addPlacement");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.assetId, p.data.roomId);
  if (!found.ok) return found;
  if (!found.biome.kit?.pieces.some((piece) => piece.id === p.data.placement.piece)) {
    return fail("not_found", `biome "${p.data.assetId}" has no piece "${p.data.placement.piece}"${list(found.biome.kit?.pieces.map((x) => x.id) ?? [])}`);
  }
  const placements = withPlacementIds([...found.room.composition.placements, { id: undefined as string | undefined, ...p.data.placement }]);
  return withRoom(project, found, { ...found.room, composition: { ...found.room.composition, placements } }, "placement");
}

export const RemovePlacementInput = z.strictObject({ assetId: Id, roomId: Id, placementId: Id });

export function removePlacement(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(RemovePlacementInput, input, "removePlacement");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.assetId, p.data.roomId);
  if (!found.ok) return found;
  const placements = found.room.composition.placements.filter((pl) => pl.id !== p.data.placementId);
  if (placements.length === found.room.composition.placements.length) {
    return fail("not_found", `room "${p.data.roomId}" has no placement "${p.data.placementId}"`);
  }
  return withRoom(project, found, { ...found.room, composition: { ...found.room.composition, placements } }, "room");
}

// --- dressing world rooms -------------------------------------------------------------

const worldRoomIndex = (project: ProjectSpec, id: string) => project.world.rooms.findIndex((r) => r.id === id);

function dressWorldRoom(world: ProjectSpec["world"], index: number, dressing: Dressing | null, grid?: TileGrid): ProjectSpec["world"] {
  const rooms = world.rooms.slice();
  const room = { ...rooms[index]!, ...(grid && { grid }) };
  rooms[index] = { ...room, dressing: dressing && { ...dressing, tiles: roomFingerprint(room) } };
  return { ...world, rooms };
}

/** Every world room whose dressing matches, undressed (a biome or its room was deleted). */
export function undress(world: ProjectSpec["world"], match: (d: Dressing) => boolean): ProjectSpec["world"] {
  return { ...world, rooms: world.rooms.map((r) => (r.dressing && match(r.dressing) ? { ...r, dressing: null } : r)) };
}

/** The world room art work applies to: the one named, else the playtest room, else the first. */
function targetRoom(project: ProjectSpec, worldRoomId?: string): { ok: true; index: number } | Fail {
  const id = worldRoomId ?? project.world.playtest?.room ?? project.world.rooms[0]?.id;
  const index = id === undefined ? -1 : worldRoomIndex(project, id);
  if (index >= 0) return { ok: true, index };
  const ids = project.world.rooms.map((r) => r.id);
  return fail("not_found", `no world room "${id ?? ""}"${ids.length ? ` (rooms: ${ids.join(", ")})` : " (the world has no rooms)"}`);
}

export const SetDressingInput = z.strictObject({
  worldRoomId: Id.optional().describe("The world room to dress; default the playtest room."),
  biomeId: Id.nullable().describe("Biome to dress it with; null = plain tiles."),
  roomId: Id.optional().describe("The biome's room (composition); default its newest."),
});

/** Dress a world room with a biome room (art only), or go back to plain tiles. */
export function setDressing(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetDressingInput, input, "setDressing");
  if (!p.ok) return p;
  const target = targetRoom(project, p.data.worldRoomId);
  if (!target.ok) return target;
  if (p.data.biomeId === null) return commit({ ...project, world: dressWorldRoom(project.world, target.index, null) });
  const found = findBiome(project, p.data.biomeId);
  if (!found.ok) return found;
  const roomId = p.data.roomId ?? found.biome.rooms.at(-1)?.id;
  if (!roomId) return fail("invalid_input", `biome "${p.data.biomeId}" has no rooms yet; compose one first`);
  return commit({ ...project, world: dressWorldRoom(project.world, target.index, { biome: p.data.biomeId, room: roomId }) });
}

export const ApplyRoomLayoutInput = z.strictObject({
  assetId: Id,
  roomId: Id,
  worldRoomId: Id.optional().describe("The world room whose tiles become the layout; default the playtest room."),
});

/** A suggested layout on a room's grid (same size), keeping its walls and ceiling. */
function layoutGrid(base: TileGrid, layout: PlatformRect[]): TileGrid {
  const cols = gridCols(base);
  const rows = gridRows(base);
  let grid = rectsToGrid(layout, cols, rows);
  grid = fillTiles(grid, { col: 0, row: 0, cols: 1, rows }, "solid");
  grid = fillTiles(grid, { col: cols - 1, row: 0, cols: 1, rows }, "solid");
  return fillTiles(grid, { col: 0, row: 0, cols, rows: 1 }, "solid");
}

/** Accept a biome room's suggested layout: a world room's tiles become it, and it is dressed with that room. */
export function applyRoomLayout(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ApplyRoomLayoutInput, input, "applyRoomLayout");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.assetId, p.data.roomId);
  if (!found.ok) return found;
  if (!found.room.layout) return fail("invalid_input", `room "${p.data.roomId}" has no suggested layout`);
  const target = targetRoom(project, p.data.worldRoomId);
  if (!target.ok) return target;
  const rooms = found.biome.rooms.slice();
  rooms[found.roomIndex] = { ...found.room, layout: null };
  const assets = project.art.assets.slice();
  assets[found.index] = { ...found.biome, rooms };
  const grid = layoutGrid(project.world.rooms[target.index]!.grid, found.room.layout);
  return commit({
    ...project,
    art: { ...project.art, assets },
    world: dressWorldRoom(project.world, target.index, { biome: found.biome.id, room: found.room.id }, grid),
  });
}

export const worldOperations = {
  setBiomeKit,
  addRoom,
  setRoomComposition,
  updateRoom,
  deleteRoom,
  updatePlacement,
  addPlacement,
  removePlacement,
  setDressing,
  applyRoomLayout,
} satisfies Record<string, (project: ProjectSpec, input: unknown) => OperationResult>;

/** Unique id for a new room in a biome. */
export function newRoomId(biome: BiomeAsset, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 40) || "room";
  return uniqueId(base, biome.rooms.map((r) => r.id));
}

/** The world room a biome room is shown over: one it dresses, else the playtest room, else the first. */
export function worldRoomFor(project: ProjectSpec, biomeId: string, roomId: string): ProjectSpec["world"]["rooms"][number] | undefined {
  const { rooms, playtest } = project.world;
  return rooms.find((r) => r.dressing?.biome === biomeId && r.dressing.room === roomId) ?? rooms.find((r) => r.id === playtest?.room) ?? rooms[0];
}

/**
 * What the runtime draws for a biome room: the kit + the composition over a
 * world room's tiles (see worldRoomFor), or the biome room's suggested layout
 * on them if asked and present.
 */
export function worldSceneFor(project: ProjectSpec, biomeId: string, roomId: string, useRoomLayout = false): WorldScene | null {
  const biome = project.art.assets.find((a) => a.id === biomeId);
  if (!biome || biome.kind !== "biome" || !biome.kit) return null;
  const room = biome.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const base = worldRoomFor(project, biomeId, roomId)?.grid ?? borderedGrid(50, 23);
  const grid = useRoomLayout && room.layout ? layoutGrid(base, room.layout) : base;
  const ledgeThickness = project.world.ledgeThickness;
  const size = gridSize(grid);
  const scene = WorldScene.safeParse({
    name: room.name,
    width: Math.max(960, size.width),
    height: Math.max(360, size.height),
    terrain: { grid, ledgeThickness },
    backdrop: biome.kit.backdrop,
    ...(biome.kit.backgrounds ? { backgrounds: biome.kit.backgrounds } : {}),
    ...(biome.kit.atmosphere ? { atmosphere: biome.kit.atmosphere } : {}),
    ground: biome.kit.ground,
    pieces: biome.kit.pieces,
    // Breakable tiles keep their own look in play (they can disappear), so the room's shapes leave them out.
    platforms: gridPlatforms(grid, ledgeThickness),
    ...room.composition,
  });
  return scene.success ? scene.data : null;
}
