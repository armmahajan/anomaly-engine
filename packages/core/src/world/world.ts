import { z } from "zod";
import { Color, Id } from "../common.ts";
import { MovementAbility } from "../movement/params.ts";
import { Dressing } from "../art/world.ts";
import { DEFAULT_LEDGE_THICKNESS, gridCols, gridRows, TileGrid } from "./tiles.ts";

/**
 * The game world: rooms of tiles joined by doors. Every room is just a room;
 * `playtest` names the room (and spot, and abilities) that ▶ Play tests in.
 *
 * A door is an opening on one side of a room, `size` tiles long, starting
 * `offset` tiles from the top (left/right sides) or the left (top/bottom).
 * It leads to a door on the opposite side of another room (left <-> right,
 * top <-> bottom); walking out through one enters through the other.
 */

export const DoorSide = z.enum(["left", "right", "top", "bottom"]);
export type DoorSide = z.infer<typeof DoorSide>;
export const OPPOSITE: Record<DoorSide, DoorSide> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/** Going up through a top door carries you at least this high (px) into the room above (world_runtime.gd UP_CARRY). */
export const DOOR_UP_CARRY = 3 * 32;

export const Door = z.strictObject({
  id: Id,
  side: DoorSide,
  offset: z.number().int().min(0).describe("Tiles from the top (left/right doors) or the left (top/bottom doors)."),
  size: z.number().int().min(1).max(40).describe("Length of the opening in tiles."),
  to: z.strictObject({ room: Id, door: Id }).nullable().default(null).describe("The door it leads to; null while unconnected."),
});
export type Door = z.infer<typeof Door>;

export const RoomSpawn = z.strictObject({
  id: Id,
  characterId: Id,
  x: z.number().describe("Feet x, px from the room's left."),
  y: z.number().describe("Feet y, px from the room's top."),
});
export type RoomSpawn = z.infer<typeof RoomSpawn>;

export const WorldRoom = z.strictObject({
  id: Id,
  name: z.string().min(1).max(80),
  grid: TileGrid,
  /** Where the room sits on the world map, in tiles (for overviews; doors decide connections). */
  at: z.strictObject({ x: z.number().int(), y: z.number().int() }).prefault({ x: 0, y: 0 }),
  doors: z.array(Door).max(16).default([]),
  spawns: z.array(RoomSpawn).max(100).default([]),
  /** The biome room that dresses it, or null for plain tiles. */
  dressing: Dressing.nullable().default(null),
  /** The progression region it belongs to. */
  regionId: Id.optional(),
});
export type WorldRoom = z.infer<typeof WorldRoom>;

export const GameRules = z.strictObject({
  onDeath: z
    .enum(["room", "start"])
    .default("room")
    .describe("room: back to where you entered the room you died in; start: back to the start of the game. (Checkpoints arrive with props.)"),
  save: z.enum(["room", "never"]).default("room").describe("room: progress is saved each time you enter a room; never: no saving."),
  hazardDamage: z.number().int().min(0).max(20).default(1).describe("Damage from touching a hazard tile (you are put back on safe ground)."),
});
export type GameRules = z.infer<typeof GameRules>;

/** What ▶ Play tests: a room, where the player starts in it, and the abilities they have. */
export const Playtest = z.strictObject({
  room: Id,
  x: z.number().describe("Feet x, px from the room's left."),
  y: z.number().describe("Feet y, px from the room's top."),
  abilities: z.array(MovementAbility).max(5).default([]).describe("Movement abilities the player has when playtesting."),
});
export type Playtest = z.infer<typeof Playtest>;

export const World = z.strictObject({
  gravity: z.number().min(0).max(10_000).default(1800).describe("px/s^2, for every room."),
  backgroundColor: Color.default("#1b2030").describe("Behind rooms without a dressing."),
  platformColor: Color.default("#4a5470").describe("Tiles in rooms without a dressing."),
  /** Thickness of ledges and one-way platforms, px. */
  ledgeThickness: z.number().int().min(4).max(32).default(DEFAULT_LEDGE_THICKNESS),
  rules: GameRules.prefault({}),
  /** Where the game begins. */
  start: z.strictObject({ room: Id, x: z.number(), y: z.number() }).nullable().default(null),
  rooms: z.array(WorldRoom).max(200).default([]),
  playtest: Playtest.nullable().default(null),
});
export type World = z.infer<typeof World>;

export const defaultWorld = (): World => World.parse({});

/** Reference checks, run as part of ProjectSpec validation. */
export function worldIssues(world: World, enemyIds: Set<string>): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const rooms = new Map<string, WorldRoom>();
  world.rooms.forEach((room, i) => {
    if (rooms.has(room.id)) issues.push({ path: ["world", "rooms", i, "id"], message: `duplicate room id "${room.id}"` });
    rooms.set(room.id, room);
  });
  world.rooms.forEach((room, i) => {
    const at = (...rest: (string | number)[]) => ["world", "rooms", i, ...rest];
    const cols = gridCols(room.grid);
    const rows = gridRows(room.grid);
    const doorIds = new Set<string>();
    room.doors.forEach((door, j) => {
      if (doorIds.has(door.id)) issues.push({ path: at("doors", j, "id"), message: `duplicate door id "${door.id}"` });
      doorIds.add(door.id);
      const length = door.side === "left" || door.side === "right" ? rows : cols;
      if (door.offset + door.size > length) issues.push({ path: at("doors", j), message: `door "${door.id}" runs past the room's ${door.side} side (${length} tiles)` });
      if (!door.to) return;
      const other = rooms.get(door.to.room);
      const target = other?.doors.find((d) => d.id === door.to!.door);
      if (!other) issues.push({ path: at("doors", j, "to", "room"), message: `door "${door.id}" leads to unknown room "${door.to.room}"` });
      else if (!target) issues.push({ path: at("doors", j, "to", "door"), message: `room "${other.id}" has no door "${door.to.door}"` });
      else if (target.side !== OPPOSITE[door.side]) issues.push({ path: at("doors", j, "to"), message: `door "${door.id}" (${door.side}) must lead to a ${OPPOSITE[door.side]} door; "${target.id}" is ${target.side}` });
      else if (target.to?.room !== room.id || target.to.door !== door.id) issues.push({ path: at("doors", j, "to"), message: `door "${door.id}" and "${other.id}/${target.id}" must lead to each other` });
    });
    const spawnIds = new Set<string>();
    room.spawns.forEach((spawn, j) => {
      if (spawnIds.has(spawn.id)) issues.push({ path: at("spawns", j, "id"), message: `duplicate spawn id "${spawn.id}"` });
      spawnIds.add(spawn.id);
      if (!enemyIds.has(spawn.characterId)) issues.push({ path: at("spawns", j, "characterId"), message: `unknown enemy "${spawn.characterId}" (the player enters through doors and the world's start)` });
    });
  });
  if (world.start && !rooms.has(world.start.room)) issues.push({ path: ["world", "start", "room"], message: `unknown room "${world.start.room}"` });
  if (world.playtest && !rooms.has(world.playtest.room)) issues.push({ path: ["world", "playtest", "room"], message: `unknown room "${world.playtest.room}"` });
  return issues;
}
