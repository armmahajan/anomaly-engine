import { z } from "zod";
import { Id } from "../common.ts";
import { slugify, uniqueId } from "../ids.ts";
import type { OperationError, OperationResult } from "../operations.ts";
import { ProjectSpec } from "../schema.ts";
import { Dressing } from "../art/world.ts";
import { DoorSide, GameRules, OPPOSITE, World, type Door, type WorldRoom } from "./world.ts";
import { borderedGrid, gridCols, gridRows, TILE, TILE_CHAR, TILE_KINDS, TileGrid, type TileKind } from "./tiles.ts";

/**
 * Game-world operations: rooms, tiles, doors, room spawns, the start and the
 * rules. Same contract as ../operations.ts (pure, untrusted input, whole-
 * project check). Named apart from the art "rooms" of biomes (addRoom etc.).
 */

type Fail = { ok: false; error: OperationError };

const fail = (code: OperationError["code"], message: string, issues: OperationError["issues"] = []): Fail => ({
  ok: false,
  error: { code, message, issues },
});
const issuesOf = (error: z.ZodError, prefix = "") => error.issues.map((i) => ({ path: prefix + i.path.join("."), message: i.message }));
const known = (ids: string[]) => (ids.length > 0 ? ` (known: ${ids.join(", ")})` : " (none exist)");

function parse<T extends z.ZodType>(schema: T, input: unknown, op: string): { ok: true; data: z.infer<T> } | Fail {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, data: parsed.data } : fail("invalid_input", `${op} input is malformed`, issuesOf(parsed.error));
}

function commit(next: ProjectSpec): OperationResult {
  const parsed = ProjectSpec.safeParse({ ...next, revision: next.revision + 1 });
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    return fail("invalid_result", `operation would leave the project invalid: ${issues.map((i) => i.message).join("; ")}`, issues);
  }
  return { ok: true, project: parsed.data };
}

const withWorld = (project: ProjectSpec, world: Partial<World>): OperationResult => commit({ ...project, world: { ...project.world, ...world } });

function findRoom(project: ProjectSpec, roomId: string): { ok: true; index: number; room: WorldRoom } | Fail {
  const index = project.world.rooms.findIndex((r) => r.id === roomId);
  if (index < 0) return fail("not_found", `no room "${roomId}"${known(project.world.rooms.map((r) => r.id))}`);
  return { ok: true, index, room: project.world.rooms[index]! };
}

function withRoom(project: ProjectSpec, index: number, room: WorldRoom): OperationResult {
  const rooms = project.world.rooms.slice();
  rooms[index] = room;
  return withWorld(project, { rooms });
}

function findDoor(room: WorldRoom, doorId: string): { ok: true; index: number; door: Door } | Fail {
  const index = room.doors.findIndex((d) => d.id === doorId);
  if (index < 0) return fail("not_found", `room "${room.id}" has no door "${doorId}"${known(room.doors.map((d) => d.id))}`);
  return { ok: true, index, door: room.doors[index]! };
}

/** Rooms with every door that leads to one of `targets` (room/door) unlinked. */
function unlink(rooms: WorldRoom[], targets: { room: string; door?: string }[]): WorldRoom[] {
  const hit = (to: Door["to"]) => !!to && targets.some((t) => t.room === to.room && (t.door === undefined || t.door === to.door));
  return rooms.map((room) =>
    room.doors.some((d) => hit(d.to)) ? { ...room, doors: room.doors.map((d) => (hit(d.to) ? { ...d, to: null } : d)) } : room,
  );
}

const roomSize = (room: WorldRoom) => ({ width: gridCols(room.grid) * TILE, height: gridRows(room.grid) * TILE });

function checkInside(room: WorldRoom, x: number, y: number, what: string): Fail | null {
  const { width, height } = roomSize(room);
  return x < 0 || x > width || y < 0 || y > height ? fail("invalid_input", `${what} (${x}, ${y}) is outside room "${room.id}" (${width}x${height} px)`) : null;
}

// --- rooms -------------------------------------------------------------------

export const CreateWorldRoomInput = z.strictObject({
  name: z.string().min(1).max(80),
  id: Id.optional().describe("Defaults to the name in snake_case."),
  cols: z.number().int().min(4).max(600).default(40).describe("Width in 32 px tiles (ignored with `grid`)."),
  rows: z.number().int().min(4).max(300).default(23).describe("Height in tiles (ignored with `grid`)."),
  grid: TileGrid.optional().describe("The room's tiles; default: empty with a solid border (walls, floor, ceiling)."),
  at: z.strictObject({ x: z.number().int(), y: z.number().int() }).optional().describe("World map position in tiles; default: right of the other rooms."),
  regionId: Id.optional(),
});

export function createWorldRoom(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(CreateWorldRoomInput, input, "createWorldRoom");
  if (!p.ok) return p;
  const { name, cols, rows, grid, at, regionId } = p.data;
  const rooms = project.world.rooms;
  const taken = rooms.map((r) => r.id);
  if (p.data.id && taken.includes(p.data.id)) return fail("invalid_input", `a room "${p.data.id}" already exists`);
  const id = p.data.id ?? uniqueId(slugify(name, "room"), taken);
  const right = Math.max(0, ...rooms.map((r) => r.at.x + gridCols(r.grid) + 2));
  const room: WorldRoom = {
    id,
    name,
    grid: grid ?? borderedGrid(cols, rows),
    at: at ?? { x: rooms.length ? right : 0, y: 0 },
    doors: [],
    spawns: [],
    dressing: null,
    ...(regionId !== undefined && { regionId }),
  };
  return withWorld(project, { rooms: [...rooms, room] });
}

export const UpdateWorldRoomInput = z.strictObject({
  roomId: Id,
  changes: z.strictObject({
    name: z.string().min(1).max(80).optional(),
    at: z.strictObject({ x: z.number().int(), y: z.number().int() }).optional().describe("World map position in tiles."),
    dressing: Dressing.nullable().optional().describe("Biome room drawn over it (art only), or null for plain tiles."),
    regionId: Id.nullable().optional().describe("Progression region, or null for none."),
  }),
});

export function updateWorldRoom(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdateWorldRoomInput, input, "updateWorldRoom");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const { regionId, ...changes } = p.data.changes;
  const { regionId: current, ...rest } = found.room;
  const region = regionId === undefined ? current : (regionId ?? undefined);
  const room: WorldRoom = {
    ...rest,
    ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
    ...(region !== undefined && { regionId: region }),
  };
  return withRoom(project, found.index, room);
}

export const RoomRef = z.strictObject({ roomId: Id });

/** Delete a room; doors that led to it become unconnected, and the start is cleared if it was there. */
export function deleteWorldRoom(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(RoomRef, input, "deleteWorldRoom");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const rooms = unlink(
    project.world.rooms.filter((r) => r.id !== found.room.id),
    [{ room: found.room.id }],
  );
  return withWorld(project, { rooms, start: project.world.start?.room === found.room.id ? null : project.world.start });
}

export const ResizeWorldRoomInput = z.strictObject({
  roomId: Id,
  cols: z.number().int().min(4).max(600),
  rows: z.number().int().min(4).max(300),
  shiftX: z.number().int().min(-600).max(600).default(0).describe("Tiles to move the existing content right (to grow or crop on the left)."),
  shiftY: z.number().int().min(-300).max(300).default(0).describe("Tiles to move the existing content down (to grow or crop at the top)."),
});

/**
 * Resize a room's grid. Existing tiles, doors, spawns and the start move by
 * the shift; new cells are empty, with solid tiles along the new outer edge.
 */
export function resizeWorldRoom(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ResizeWorldRoomInput, input, "resizeWorldRoom");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const { cols, rows, shiftX, shiftY } = p.data;
  const old = found.room;
  const oldCols = gridCols(old.grid);
  const oldRows = gridRows(old.grid);
  const frame = borderedGrid(cols, rows).rows;
  const grid = {
    rows: frame.map((line, r) =>
      Array.from(line, (ch, c) => {
        const [oc, or] = [c - shiftX, r - shiftY];
        return oc >= 0 && oc < oldCols && or >= 0 && or < oldRows ? old.grid.rows[or]![oc]! : ch;
      }).join(""),
    ),
  };
  const dx = shiftX * TILE;
  const dy = shiftY * TILE;
  const room: WorldRoom = {
    ...old,
    grid,
    doors: old.doors.map((d) => ({ ...d, offset: d.offset + (d.side === "left" || d.side === "right" ? shiftY : shiftX) })),
    spawns: old.spawns.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy })),
  };
  for (const door of room.doors) {
    if (door.offset < 0) return fail("invalid_input", `door "${door.id}" would be cropped off the room; move or remove it first`);
  }
  const start = project.world.start;
  const rooms = project.world.rooms.slice();
  rooms[found.index] = room;
  return withWorld(project, { rooms, start: start?.room === old.id ? { ...start, x: start.x + dx, y: start.y + dy } : start });
}

// --- tiles -------------------------------------------------------------------

const KIND_NAMES = Object.values(TILE_KINDS) as [TileKind, ...TileKind[]];

export const PaintTilesInput = z
  .strictObject({
    roomId: Id.optional().describe("The room to paint; omit to paint the arena."),
    kind: z.enum(KIND_NAMES).describe("empty, solid, ledge (thin solid), oneway (jump up through it), hazard (hurts), breakable (ground pound smashes it)."),
    area: z
      .strictObject({ col: z.number().int().min(0), row: z.number().int().min(0), cols: z.number().int().min(1), rows: z.number().int().min(1) })
      .optional()
      .describe("A rectangle of cells (col/row of its top-left, size in tiles)."),
    cells: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).min(1).max(5000).optional().describe("Or a list of [col, row] cells."),
  })
  .refine((v) => (v.area === undefined) !== (v.cells === undefined), { message: "give either area or cells" });

/** Set a rectangle or a list of cells of a room's (or the arena's) grid to one tile kind. */
export function paintTiles(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(PaintTilesInput, input, "paintTiles");
  if (!p.ok) return p;
  const { roomId, kind, area, cells } = p.data;
  let found: { index: number; room: WorldRoom } | null = null;
  if (roomId !== undefined) {
    const r = findRoom(project, roomId);
    if (!r.ok) return r;
    found = r;
  }
  const grid = found ? found.room.grid : project.sandbox.grid;
  const cols = gridCols(grid);
  const rows = gridRows(grid);
  const where = found ? `room "${found.room.id}"` : "the arena";
  const list = cells ?? [];
  if (area) {
    if (area.col + area.cols > cols || area.row + area.rows > rows) {
      return fail("invalid_input", `area runs past ${where} (${cols}x${rows} tiles; cols 0-${cols - 1}, rows 0-${rows - 1})`);
    }
    for (let r = area.row; r < area.row + area.rows; r++) for (let c = area.col; c < area.col + area.cols; c++) list.push([c, r]);
  }
  const outside = list.find(([c, r]) => c >= cols || r >= rows);
  if (outside) return fail("invalid_input", `cell [${outside.join(", ")}] is outside ${where} (${cols}x${rows} tiles)`);
  const chars = grid.rows.map((row) => row.split(""));
  for (const [c, r] of list) chars[r]![c] = TILE_CHAR[kind];
  const painted = { rows: chars.map((row) => row.join("")) };
  if (!found) return commit({ ...project, sandbox: { ...project.sandbox, grid: painted } });
  return withRoom(project, found.index, { ...found.room, grid: painted });
}

// --- doors -------------------------------------------------------------------

export const SetDoorInput = z.strictObject({
  roomId: Id,
  door: z.strictObject({
    id: Id.optional().describe("An existing door to change, or the new door's id (default door_<n>)."),
    side: DoorSide,
    offset: z.number().int().min(0).describe("Tiles from the top (left/right doors) or the left (top/bottom doors)."),
    size: z.number().int().min(1).max(40).describe("Length of the opening in tiles; at least 2 for left/right doors (the player is 44 px tall)."),
  }),
  carve: z.boolean().default(true).describe("Clear the tiles of the opening on the room's edge (thicker walls: clear the rest with paintTiles)."),
});

/** Add a door, or change an existing one. Moving it to another side disconnects it. */
export function setDoor(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetDoorInput, input, "setDoor");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const { side, offset, size } = p.data.door;
  const room = found.room;
  const existing = room.doors.find((d) => d.id === p.data.door.id);
  const cols = gridCols(room.grid);
  const rows = gridRows(room.grid);
  const length = side === "left" || side === "right" ? rows : cols;
  if (offset + size > length) return fail("invalid_input", `a ${side} door at offset ${offset} with size ${size} runs past the room's ${side} side (${length} tiles)`);
  let n = 1;
  while (room.doors.some((d) => d.id === `door_${n}`)) n++;
  const id = p.data.door.id ?? `door_${n}`;
  const keep = existing && existing.side === side ? existing.to : null;
  const door: Door = { id, side, offset, size, to: keep };
  const doors = existing ? room.doors.map((d) => (d.id === id ? door : d)) : [...room.doors, door];
  let grid = room.grid;
  if (p.data.carve) {
    const chars = grid.rows.map((row) => row.split(""));
    for (let i = offset; i < offset + size; i++) {
      const [c, r] = side === "left" ? [0, i] : side === "right" ? [cols - 1, i] : side === "top" ? [i, 0] : [i, rows - 1];
      chars[r]![c] = ".";
    }
    grid = { rows: chars.map((row) => row.join("")) };
  }
  let rooms = project.world.rooms.slice();
  rooms[found.index] = { ...room, grid, doors };
  if (existing?.to && !keep) rooms = unlink(rooms, [{ room: room.id, door: id }]);
  return withWorld(project, { rooms });
}

export const DoorRef = z.strictObject({ roomId: Id, doorId: Id });

/** Remove a door (the door it led to becomes unconnected). The opening's tiles are left as they are. */
export function removeDoor(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(DoorRef, input, "removeDoor");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const door = findDoor(found.room, p.data.doorId);
  if (!door.ok) return door;
  const rooms = project.world.rooms.slice();
  rooms[found.index] = { ...found.room, doors: found.room.doors.filter((d) => d.id !== p.data.doorId) };
  return withWorld(project, { rooms: unlink(rooms, [{ room: found.room.id, door: p.data.doorId }]) });
}

const DoorEnd = z.strictObject({ roomId: Id, doorId: Id });

export const ConnectDoorsInput = z.strictObject({
  from: DoorEnd,
  to: DoorEnd.nullable().describe("The door to lead to (on the opposite side: left <-> right, top <-> bottom), or null to disconnect `from`."),
});

/** Make two doors lead to each other (their old links are cut), or disconnect one. */
export function connectDoors(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ConnectDoorsInput, input, "connectDoors");
  if (!p.ok) return p;
  const { from, to } = p.data;
  const a = findRoom(project, from.roomId);
  if (!a.ok) return a;
  const da = findDoor(a.room, from.doorId);
  if (!da.ok) return da;
  if (!to) {
    let rooms = unlink(project.world.rooms, [{ room: from.roomId, door: from.doorId }]);
    rooms = rooms.map((r) => (r.id === from.roomId ? { ...r, doors: r.doors.map((d) => (d.id === from.doorId ? { ...d, to: null } : d)) } : r));
    return withWorld(project, { rooms });
  }
  const b = findRoom(project, to.roomId);
  if (!b.ok) return b;
  const db = findDoor(b.room, to.doorId);
  if (!db.ok) return db;
  if (from.roomId === to.roomId && from.doorId === to.doorId) return fail("invalid_input", "a door cannot lead to itself");
  if (db.door.side !== OPPOSITE[da.door.side]) {
    const fits = b.room.doors.filter((d) => d.side === OPPOSITE[da.door.side]).map((d) => d.id);
    return fail(
      "invalid_input",
      `door "${from.doorId}" is on the ${da.door.side} side, so it must lead to a ${OPPOSITE[da.door.side]} door; "${to.doorId}" is ${db.door.side}` +
        ` (${OPPOSITE[da.door.side]} doors in "${to.roomId}": ${fits.join(", ") || "none"})`,
    );
  }
  const ends = [
    { room: from.roomId, door: from.doorId },
    { room: to.roomId, door: to.doorId },
  ];
  let rooms = unlink(project.world.rooms, ends);
  const link = (roomId: string, doorId: string, target: { room: string; door: string }) => {
    rooms = rooms.map((r) => (r.id === roomId ? { ...r, doors: r.doors.map((d) => (d.id === doorId ? { ...d, to: target } : d)) } : r));
  };
  link(from.roomId, from.doorId, ends[1]!);
  link(to.roomId, to.doorId, ends[0]!);
  return withWorld(project, { rooms });
}

// --- room spawns -------------------------------------------------------------

export const AddRoomSpawnInput = z.strictObject({
  roomId: Id,
  characterId: Id.describe("An enemy (the player enters through doors and the world's start)."),
  x: z.number().describe("Feet x, px from the room's left."),
  y: z.number().describe("Feet y, px from the room's top (a floor's top to stand on it)."),
  spawnId: Id.optional().describe("Default <characterId>_<n>."),
});

export function addRoomSpawn(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AddRoomSpawnInput, input, "addRoomSpawn");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const { characterId, x, y } = p.data;
  const character = project.characters.find((c) => c.id === characterId);
  const enemies = project.characters.filter((c) => c.kind === "enemy").map((c) => c.id);
  if (!character) return fail("not_found", `no enemy "${characterId}"${known(enemies)}`);
  if (character.kind !== "enemy") return fail("invalid_input", `"${characterId}" is the player; rooms only spawn enemies (the player starts at the world's start)`);
  const outside = checkInside(found.room, x, y, "spawn");
  if (outside) return outside;
  const taken = found.room.spawns.map((s) => s.id);
  if (p.data.spawnId && taken.includes(p.data.spawnId)) return fail("invalid_input", `room "${found.room.id}" already has a spawn "${p.data.spawnId}"`);
  let n = 1;
  while (taken.includes(`${characterId}_${n}`)) n++;
  const id = p.data.spawnId ?? `${characterId}_${n}`;
  return withRoom(project, found.index, { ...found.room, spawns: [...found.room.spawns, { id, characterId, x, y }] });
}

export const MoveRoomSpawnInput = z.strictObject({ roomId: Id, spawnId: Id, x: z.number().optional(), y: z.number().optional() });

function findSpawn(room: WorldRoom, spawnId: string) {
  const index = room.spawns.findIndex((s) => s.id === spawnId);
  if (index < 0) return fail("not_found", `room "${room.id}" has no spawn "${spawnId}"${known(room.spawns.map((s) => s.id))}`);
  return { ok: true as const, index, spawn: room.spawns[index]! };
}

export function moveRoomSpawn(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(MoveRoomSpawnInput, input, "moveRoomSpawn");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const s = findSpawn(found.room, p.data.spawnId);
  if (!s.ok) return s;
  const moved = { ...s.spawn, x: p.data.x ?? s.spawn.x, y: p.data.y ?? s.spawn.y };
  const outside = checkInside(found.room, moved.x, moved.y, "spawn");
  if (outside) return outside;
  const spawns = found.room.spawns.slice();
  spawns[s.index] = moved;
  return withRoom(project, found.index, { ...found.room, spawns });
}

export const RoomSpawnRef = z.strictObject({ roomId: Id, spawnId: Id });

export function removeRoomSpawn(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(RoomSpawnRef, input, "removeRoomSpawn");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const s = findSpawn(found.room, p.data.spawnId);
  if (!s.ok) return s;
  return withRoom(project, found.index, { ...found.room, spawns: found.room.spawns.filter((x) => x.id !== p.data.spawnId) });
}

// --- start and rules ---------------------------------------------------------

export const SetWorldStartInput = z.strictObject({
  roomId: Id.nullable().describe("The room the game begins in, or null to clear the start."),
  x: z.number().optional().describe("Feet x, px from the room's left."),
  y: z.number().optional().describe("Feet y, px from the room's top."),
});

export function setWorldStart(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetWorldStartInput, input, "setWorldStart");
  if (!p.ok) return p;
  const { roomId, x, y } = p.data;
  if (roomId === null) return withWorld(project, { start: null });
  const found = findRoom(project, roomId);
  if (!found.ok) return found;
  if (x === undefined || y === undefined) return fail("invalid_input", "give the start's x and y (the player's feet, px from the room's top-left)");
  const outside = checkInside(found.room, x, y, "start");
  if (outside) return outside;
  return withWorld(project, { start: { room: roomId, x, y } });
}

export const SetGameRulesInput = GameRules.partial();

export function setGameRules(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetGameRulesInput, input, "setGameRules");
  if (!p.ok) return p;
  const named = Object.fromEntries(Object.entries(p.data).filter(([k]) => Object.hasOwn(input as object, k)));
  if (Object.keys(named).length === 0) return fail("invalid_input", "nothing to change: give onDeath, save or hazardDamage");
  return withWorld(project, { rules: { ...project.world.rules, ...named } });
}

export const SetLedgeThicknessInput = z.strictObject({ thickness: z.number().int().min(4).max(32).describe("px, for ledges and one-way platforms everywhere.") });

export function setLedgeThickness(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetLedgeThicknessInput, input, "setLedgeThickness");
  if (!p.ok) return p;
  return withWorld(project, { ledgeThickness: p.data.thickness });
}

/** A room's spawns of one character removed (deleteCharacter). */
export const withoutRoomSpawns = (world: World, characterId: string): World => ({
  ...world,
  rooms: world.rooms.map((r) => (r.spawns.some((s) => s.characterId === characterId) ? { ...r, spawns: r.spawns.filter((s) => s.characterId !== characterId) } : r)),
});

export const worldRoomOperations = {
  createWorldRoom,
  updateWorldRoom,
  deleteWorldRoom,
  resizeWorldRoom,
  paintTiles,
  setDoor,
  removeDoor,
  connectDoors,
  addRoomSpawn,
  moveRoomSpawn,
  removeRoomSpawn,
  setWorldStart,
  setGameRules,
  setLedgeThickness,
} satisfies Record<string, (project: ProjectSpec, input: unknown) => OperationResult>;
