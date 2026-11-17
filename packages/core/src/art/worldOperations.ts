import { z } from "zod";
import { Color, Id } from "../common.ts";
import { uniqueId } from "../ids.ts";
import type { OperationError, OperationResult } from "../operations.ts";
import { ProjectSpec } from "../schema.ts";
import type { BiomeAsset } from "./asset.ts";
import { BiomeKit, Room, WorldLayer, WorldScene, type PlatformRect } from "./world.ts";

/**
 * World operations (biomes, rooms, placements, the arena's dressing). Same
 * contract as ../operations.ts: pure, untrusted input, whole-project check.
 * Rooms only dress a layout; collision stays the arena's platforms until the
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
  /** Dress the arena with it right away. */
  dressArena: z.boolean().default(false),
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
  if (!next.ok || !p.data.dressArena) return next;
  return commit({ ...next.project, revision: project.revision, sandbox: { ...next.project.sandbox, dressing: { biome: found.biome.id, room: room.data.id } } });
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
  const d = project.sandbox.dressing;
  const dressing = d && d.biome === p.data.assetId && d.room === p.data.roomId ? null : d;
  return commit({ ...project, art: { ...project.art, assets }, sandbox: { ...project.sandbox, dressing } });
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

// --- the arena --------------------------------------------------------------------

export const SetDressingInput = z.strictObject({
  biomeId: Id.nullable().describe("Biome to dress the arena with; null = plain arena."),
  roomId: Id.optional(),
});

/** Dress the arena with a biome room (art only), or go back to the plain arena. */
export function setDressing(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetDressingInput, input, "setDressing");
  if (!p.ok) return p;
  if (p.data.biomeId === null) return commit({ ...project, sandbox: { ...project.sandbox, dressing: null } });
  const found = findBiome(project, p.data.biomeId);
  if (!found.ok) return found;
  const roomId = p.data.roomId ?? found.biome.rooms.at(-1)?.id;
  if (!roomId) return fail("invalid_input", `biome "${p.data.biomeId}" has no rooms yet; compose one first`);
  return commit({ ...project, sandbox: { ...project.sandbox, dressing: { biome: p.data.biomeId, room: roomId } } });
}

export const ApplyRoomLayoutInput = z.strictObject({ assetId: Id, roomId: Id });

/** Accept a room's suggested layout: the arena's platforms become it, and the arena is dressed with the room. */
export function applyRoomLayout(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ApplyRoomLayoutInput, input, "applyRoomLayout");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.assetId, p.data.roomId);
  if (!found.ok) return found;
  if (!found.room.layout) return fail("invalid_input", `room "${p.data.roomId}" has no suggested layout`);
  const rooms = found.biome.rooms.slice();
  rooms[found.roomIndex] = { ...found.room, layout: null };
  const assets = project.art.assets.slice();
  assets[found.index] = { ...found.biome, rooms };
  return commit({
    ...project,
    art: { ...project.art, assets },
    sandbox: { ...project.sandbox, platforms: found.room.layout, dressing: { biome: found.biome.id, room: found.room.id } },
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

/**
 * What the runtime draws for a room: the kit + the composition over a layout
 * (the room's suggested one if asked and present, else the arena's platforms).
 */
export function worldSceneFor(project: ProjectSpec, biomeId: string, roomId: string, useRoomLayout = false): WorldScene | null {
  const biome = project.art.assets.find((a) => a.id === biomeId);
  if (!biome || biome.kind !== "biome" || !biome.kit) return null;
  const room = biome.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const platforms: PlatformRect[] = useRoomLayout && room.layout ? room.layout : project.sandbox.platforms;
  const scene = WorldScene.safeParse({
    name: room.name,
    width: Math.max(960, project.sandbox.width),
    height: Math.max(360, project.sandbox.height),
    backdrop: biome.kit.backdrop,
    ground: biome.kit.ground,
    pieces: biome.kit.pieces,
    // Breakable platforms keep their own look in play (they can disappear), so the room leaves them out.
    platforms: platforms
      .filter((r) => r.width >= 8 && r.height >= 8 && !("breakable" in r && r.breakable))
      .map(({ x, y, width, height }) => ({ x, y, width, height })),
    ...room.composition,
  });
  return scene.success ? scene.data : null;
}
