import { z } from "zod";
import { Color, Id } from "../common.ts";
import { MovementAbility } from "../movement/params.ts";
import { Dressing } from "../art/world.ts";
import { FileRef } from "../art/fileRef.ts";
import { Effect, flattenConditions, GameCondition, Handlers, PROP_EVENTS, type Handler } from "../events/events.ts";
import { DEFAULT_LEDGE_THICKNESS, gridCols, gridRows, TileGrid } from "./tiles.ts";

/**
 * The game world: rooms of tiles joined by doors. Every room is just a room;
 * `playtest` names the room (and spot, and abilities) that ▶ Play tests in.
 *
 * A door is an opening on one side of a room, `size` tiles long, starting
 * `offset` tiles from the top (left/right sides) or the left (top/bottom).
 * It leads to a door on the opposite side of another room (left <-> right,
 * top <-> bottom); walking out through one enters through the other.
 *
 * Game logic is handlers (events/events.ts) on the world, rooms, props and
 * spawns, reading and writing the run's flags and items. Props are generic
 * rectangles: what they are (a pickup, a barrier, a switch, a save spot) is
 * only their look, conditions and handlers.
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
  /** Spawn only while this holds (e.g. until a flag says it was beaten); null = always. */
  when: GameCondition.nullable().default(null),
  /** Show a titled health bar while this enemy is alive in the current room (any enemy can). */
  healthBar: z.strictObject({ title: z.string().min(1).max(60) }).nullable().default(null),
  /** Handlers scoped to this spawn (its enemyKilled is its own death). */
  handlers: Handlers,
});
export type RoomSpawn = z.infer<typeof RoomSpawn>;

/** Solid / visible: always, never, or while a condition holds (so props follow the run's flags and items). */
export const PropSwitch = z.union([z.boolean(), GameCondition]);
export type PropSwitch = z.infer<typeof PropSwitch>;

/** A rectangle in a room that can be seen, stood on, touched, used and struck. */
export const Prop = z.strictObject({
  id: Id,
  name: z.string().max(80).optional(),
  x: z.number().describe("Left edge, px from the room's left."),
  y: z.number().describe("Top edge, px from the room's top."),
  width: z.number().min(4).max(4000),
  height: z.number().min(4).max(4000),
  color: Color.default("#c9a227").describe("Drawn as this color unless it has art."),
  art: z.strictObject({ biome: Id, piece: Id }).nullable().default(null).describe("A biome kit piece to draw it with, fitted to its rectangle."),
  solid: PropSwitch.default(false).describe("Blocks the player and enemies like a solid tile."),
  visible: PropSwitch.default(true).describe("Hidden props are gone: not drawn, not solid, no events."),
  health: z.number().int().min(1).max(99).nullable().default(null).describe("Sword hits until it fires destroyed and is gone for this visit; null = can't be destroyed."),
  bounce: z.boolean().default(false).describe("A downward strike on it bounces the player (like off an enemy)."),
  prompt: z.string().max(40).nullable().default(null).describe("Shown above it while the player can interact (props with an interact handler)."),
  handlers: Handlers,
});
export type Prop = z.infer<typeof Prop>;

/** Something the player can carry (counted). */
export const Item = z.strictObject({
  id: Id,
  name: z.string().min(1).max(80),
  description: z.string().max(400).default(""),
  color: Color.default("#e8c547"),
});
export type Item = z.infer<typeof Item>;

/** A screen over the game: text, an optional image and buttons that run effects. Gameplay pauses while one is open. */
export const Modal = z.strictObject({
  id: Id,
  title: z.string().max(120).default(""),
  body: z.string().max(4000).default(""),
  image: FileRef.nullable().default(null),
  /** Each runs its effects, then closes the modal. None = one "Continue" button. */
  buttons: z.array(z.strictObject({ label: z.string().min(1).max(40), do: z.array(Effect).max(20).default([]) })).max(4).default([]),
});
export type Modal = z.infer<typeof Modal>;

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
  props: z.array(Prop).max(100).default([]),
  /** Handlers scoped to this room (its roomEntered, roomCleared, ...). */
  handlers: Handlers,
});
export type WorldRoom = z.infer<typeof WorldRoom>;

export const GameRules = z.strictObject({
  onDeath: z
    .enum(["room", "start", "checkpoint"])
    .default("room")
    .describe("room: back to where you entered the room you died in; start: back to the start of the game; checkpoint: the last setCheckpoint (else the start)."),
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
  /** Handlers for the whole game (events anywhere). `rules` are presets that add more. */
  handlers: Handlers,
  items: z.array(Item).max(100).default([]),
  modals: z.array(Modal).max(100).default([]),
  /** An optional map screen (M) of the rooms the player has visited or had revealed. */
  map: z.strictObject({ enabled: z.boolean().default(false) }).prefault({}),
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
  const refs = handlerRefs(world, rooms, enemyIds, issues);
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
      refs.handlers(spawn.handlers, at("spawns", j, "handlers"), room, false);
      if (spawn.when) refs.conditions([spawn.when], at("spawns", j, "when"));
    });
    const propIds = new Set<string>();
    room.props.forEach((prop, j) => {
      if (propIds.has(prop.id)) issues.push({ path: at("props", j, "id"), message: `duplicate prop id "${prop.id}"` });
      propIds.add(prop.id);
      for (const key of ["solid", "visible"] as const) {
        const value = prop[key];
        if (typeof value !== "boolean") refs.conditions([value], at("props", j, key));
      }
      refs.handlers(prop.handlers, at("props", j, "handlers"), room, true);
    });
    refs.handlers(room.handlers, at("handlers"), room, false);
  });
  refs.handlers(world.handlers, ["world", "handlers"], null, false);
  const itemIds = new Set<string>();
  world.items.forEach((item, i) => {
    if (itemIds.has(item.id)) issues.push({ path: ["world", "items", i, "id"], message: `duplicate item id "${item.id}"` });
    itemIds.add(item.id);
  });
  const modalIds = new Set<string>();
  world.modals.forEach((modal, i) => {
    if (modalIds.has(modal.id)) issues.push({ path: ["world", "modals", i, "id"], message: `duplicate modal id "${modal.id}"` });
    modalIds.add(modal.id);
    modal.buttons.forEach((b, j) => refs.effects(b.do, ["world", "modals", i, "buttons", j, "do"]));
  });
  if (world.start && !rooms.has(world.start.room)) issues.push({ path: ["world", "start", "room"], message: `unknown room "${world.start.room}"` });
  if (world.playtest && !rooms.has(world.playtest.room)) issues.push({ path: ["world", "playtest", "room"], message: `unknown room "${world.playtest.room}"` });
  return issues;
}

type Issue = { path: (string | number)[]; message: string };

/** Checks that handlers name things that exist (items, modals, rooms, spawns) and use prop events only on props. */
function handlerRefs(world: World, rooms: Map<string, WorldRoom>, enemyIds: Set<string>, issues: Issue[]) {
  const items = new Set(world.items.map((i) => i.id));
  const modals = new Set(world.modals.map((m) => m.id));
  const known = (kind: string, id: string, set: { has(id: string): boolean }, path: Issue["path"]) => {
    if (!set.has(id)) issues.push({ path, message: `unknown ${kind} "${id}"` });
  };
  const conditions = (list: GameCondition[], path: Issue["path"]) => {
    for (const c of flattenConditions(list)) {
      if (c.type === "item") known("item", c.item, items, path);
      if (c.type === "visited") known("room", c.room, rooms, path);
    }
  };
  const effects = (list: Effect[], path: Issue["path"]) =>
    list.forEach((e, i) => {
      const at = [...path, i];
      if (e.type === "giveItem" || e.type === "takeItem") known("item", e.item, items, at);
      if (e.type === "showModal") known("modal", e.modal, modals, at);
      if (e.type === "endGame" && e.modal) known("modal", e.modal, modals, at);
      if (e.type === "setCheckpoint" && e.room) known("room", e.room, rooms, at);
      if (e.type === "setCheckpoint" && e.room && (e.x === undefined || e.y === undefined)) issues.push({ path: at, message: "setCheckpoint with a room needs x and y" });
      if (e.type === "revealMap") e.rooms?.forEach((r) => known("room", r, rooms, at));
    });
  const handlers = (list: Handler[], path: Issue["path"], room: WorldRoom | null, onProp: boolean) =>
    list.forEach((h, i) => {
      const at = [...path, i];
      if (!onProp && PROP_EVENTS.includes(h.on.type)) issues.push({ path: [...at, "on"], message: `"${h.on.type}" is a prop event; put the handler on a prop` });
      if ("room" in h.on && h.on.room) known("room", h.on.room, rooms, [...at, "on", "room"]);
      if (h.on.type === "enemyKilled") {
        if (h.on.character) known("enemy", h.on.character, enemyIds, [...at, "on", "character"]);
        if (h.on.spawn && !room) issues.push({ path: [...at, "on", "spawn"], message: "enemyKilled with a spawn belongs on a room (or on the spawn itself)" });
        if (h.on.spawn && room) known("spawn", h.on.spawn, new Set(room.spawns.map((s) => s.id)), [...at, "on", "spawn"]);
      }
      conditions(h.when, [...at, "when"]);
      effects(h.do, [...at, "do"]);
    });
  return { conditions, effects, handlers };
}
