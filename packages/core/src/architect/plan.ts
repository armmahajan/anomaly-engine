import { z } from "zod";
import { Id } from "../common.ts";
import { DoorSide } from "../world/world.ts";

/**
 * The Architect's plan: an editable design document for building the game
 * world from the director's progression. The model (or the creator) decides
 * what each room is for; code builds geometry and contents from it, and the
 * checker proves the result. Everything here is generic: a "boss" is an enemy
 * entry that locks the room and grants something, nothing more.
 *
 * Plan room ids are the ids of the world rooms they build (one to one).
 * Pinned rooms are the creator's: no stage ever rewrites them.
 */

export const ARCHITECT_STAGES = ["plan", "layout", "geometry", "cast", "population", "screens", "verify", "pacing", "art"] as const;
export const ArchitectStage = z.enum(ARCHITECT_STAGES);
export type ArchitectStage = z.infer<typeof ArchitectStage>;

export const STAGE_DESCRIPTIONS: Record<ArchitectStage, string> = {
  plan: "Decide the rooms of each region, how they link, what gates each link and what each room holds (the model, with the creator's notes).",
  layout: "Place the rooms on the world map and choose which side of each room every link leaves from.",
  geometry: "Build each room's tiles and doors from proven chunks, to its size, links and the abilities it needs.",
  cast: "Create the enemy characters the plan uses, with behaviors from the wiki.",
  population: "Put enemies, pickups, save points, the start and the ending on reachable spots; lock rooms until their guardians fall; enemies get tougher region by region.",
  screens: "Title and ending screens, a message for every ability or item the player gets, and the map.",
  verify: "Lint, prove the game beatable with no dead states, check every gate and ability; send each failure back to its stage.",
  pacing: "Estimate the play time from the proven route and the fights, and adjust toward the target.",
  art: "Draw everything the game needs (the game-art job).",
};

/** What a room holds. Kinds are generic placement primitives, not room roles. */
export const RoomContent = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("enemy"),
    characterId: Id.describe("The enemy character (created in the cast stage if it doesn't exist yet)."),
    count: z.number().int().min(1).max(12).default(1),
    lockRoom: z.boolean().default(false).describe("The room's doors close while any of these are alive (an arena)."),
    grants: z.array(Id).max(4).default([]).describe("Progression abilities or keys, or weapons, given when the last of these falls."),
    healthBar: z.boolean().default(false).describe("Show a health bar for it on the HUD."),
  }),
  z.strictObject({
    kind: z.literal("pickup"),
    grants: Id.describe("A progression ability or key, or a weapon, picked up here."),
  }),
  z.strictObject({ kind: z.literal("save"), note: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal("start") }),
  z.strictObject({ kind: z.literal("ending") }),
]);
export type RoomContent = z.infer<typeof RoomContent>;

/** Knobs the geometry stage reads (0 = none, 1 = a lot); generic, not room types. */
export const RoomTerrain = z.strictObject({
  verticality: z.number().min(0).max(1).default(0.3).describe("How much of the room is climbing or dropping."),
  hazards: z.number().min(0).max(1).default(0.2).describe("Spikes and pits."),
  density: z.number().min(0).max(1).default(0.5).describe("How many platforms and obstacles."),
  open: z.number().min(0).max(1).default(0.3).describe("Wide open floor (room to fight)."),
});
export type RoomTerrain = z.infer<typeof RoomTerrain>;

export const RoomPlan = z.strictObject({
  id: Id.describe("Also the id of the world room it builds."),
  name: z.string().min(1).max(80),
  regionId: Id,
  cols: z.number().int().min(16).max(240).default(30).describe("Width in tiles (30 is about one screen)."),
  rows: z.number().int().min(10).max(135).default(14).describe("Height in tiles (14 is about one screen)."),
  at: z.strictObject({ x: z.number().int(), y: z.number().int() }).optional().describe("World map position in tiles (the layout stage fills it)."),
  terrain: RoomTerrain.prefault({}),
  contents: z.array(RoomContent).max(24).default([]),
  notes: z.string().max(2000).default("").describe("Guidance for this room, from the creator or the model."),
  seed: z.number().int().min(0).default(0).describe("Geometry seed: change it to get a different room from the same plan."),
  pinned: z.boolean().default(false).describe("The creator's room: no stage rewrites it."),
});
export type RoomPlan = z.infer<typeof RoomPlan>;

export const LinkEnd = z.strictObject({
  room: Id,
  side: DoorSide.optional().describe("Which side of the room the link leaves from (the layout stage fills it)."),
});

/** Two rooms joined by a pair of doors. `requires` gates it: the gate is built in the `a` end's room. */
export const RoomLink = z.strictObject({
  id: Id,
  a: LinkEnd,
  b: LinkEnd,
  requires: z.array(Id).max(8).default([]).describe("Progression abilities or keys, or weapons, needed to pass from a to b (all of them)."),
  oneWay: z.boolean().default(false).describe("Only a -> b (a drop)."),
});
export type RoomLink = z.infer<typeof RoomLink>;

export const StageStatus = z.strictObject({
  status: z.enum(["pending", "running", "done", "stale", "failed", "paused"]).default("pending"),
  summary: z.string().max(2000).default(""),
  at: z.string().optional().describe("ISO time of the last change."),
});
export type StageStatus = z.infer<typeof StageStatus>;

export const ArchitectPlan = z.strictObject({
  guidance: z.string().max(4000).default("").describe("The creator's notes for the whole game."),
  regionNotes: z.array(z.strictObject({ regionId: Id, notes: z.string().max(2000) })).max(64).default([]),
  target: z
    .strictObject({
      minutes: z.tuple([z.number().min(1), z.number().min(1)]).default([15, 25]),
      rooms: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([20, 30]).describe("How many rooms the game should have, [min, max]."),
    })
    .prefault({})
    .describe("Play time the pacing stage aims for."),
  rooms: z.array(RoomPlan).max(200).default([]),
  links: z.array(RoomLink).max(600).default([]),
  /** Stages that stop for the creator's review when they finish (the run resumes on request). */
  pauseAfter: z.array(ArchitectStage).max(ARCHITECT_STAGES.length).default([]),
  stages: z.partialRecord(ArchitectStage, StageStatus).default({}),
  /** Set when the studio built the plan and its rooms as a live preview of the progression (see preview.ts). */
  preview: z
    .strictObject({
      progression: z.string().max(64).describe("Fingerprint of the progression the preview followed."),
      plan: z.string().max(64).describe("Fingerprint of the plan (rooms, links, stage statuses) as the preview left it."),
      rooms: z.string().max(64).describe("Fingerprint of the plan's world rooms as the preview left them."),
    })
    .optional(),
});
export type ArchitectPlan = z.infer<typeof ArchitectPlan>;

export const defaultArchitectPlan = (): ArchitectPlan => ArchitectPlan.parse({});

/**
 * Reference checks, run as part of ProjectSpec validation (characters are checked by lint: the cast stage makes them).
 * What the plan grants or requires is a progression ability or key, or one of the game's `weapons`.
 */
export function architectIssues(
  plan: ArchitectPlan,
  progression: { regions: { id: string }[]; abilities: { id: string }[] },
  weapons: readonly { id: string }[] = [],
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const regions = new Set(progression.regions.map((r) => r.id));
  const grantable = new Set([...progression.abilities.map((a) => a.id), ...weapons.map((w) => w.id)]);
  const rooms = new Set<string>();
  plan.rooms.forEach((room, i) => {
    if (rooms.has(room.id)) issues.push({ path: ["architect", "rooms", i, "id"], message: `duplicate plan room "${room.id}"` });
    rooms.add(room.id);
    if (!regions.has(room.regionId)) issues.push({ path: ["architect", "rooms", i, "regionId"], message: `unknown progression region "${room.regionId}"` });
    room.contents.forEach((c, j) => {
      const ids = c.kind === "enemy" ? c.grants : c.kind === "pickup" ? [c.grants] : [];
      for (const id of ids) {
        if (!grantable.has(id)) issues.push({ path: ["architect", "rooms", i, "contents", j, "grants"], message: `unknown progression ability, key or weapon "${id}"` });
      }
    });
  });
  const links = new Set<string>();
  plan.links.forEach((link, i) => {
    if (links.has(link.id)) issues.push({ path: ["architect", "links", i, "id"], message: `duplicate plan link "${link.id}"` });
    links.add(link.id);
    for (const end of ["a", "b"] as const) {
      if (!rooms.has(link[end].room)) issues.push({ path: ["architect", "links", i, end, "room"], message: `unknown plan room "${link[end].room}"` });
    }
    if (link.a.room === link.b.room) issues.push({ path: ["architect", "links", i], message: "a link joins two different rooms" });
    link.requires.forEach((id, j) => {
      if (!grantable.has(id)) issues.push({ path: ["architect", "links", i, "requires", j], message: `unknown progression ability, key or weapon "${id}"` });
    });
  });
  plan.regionNotes.forEach((n, i) => {
    if (!regions.has(n.regionId)) issues.push({ path: ["architect", "regionNotes", i, "regionId"], message: `unknown progression region "${n.regionId}"` });
  });
  return issues;
}

/** Links touching a room, with the end that is in it first. */
export function roomLinks(plan: ArchitectPlan, roomId: string): { link: RoomLink; here: "a" | "b"; other: string }[] {
  return plan.links.flatMap((link): { link: RoomLink; here: "a" | "b"; other: string }[] =>
    link.a.room === roomId ? [{ link, here: "a" as const, other: link.b.room }] : link.b.room === roomId ? [{ link, here: "b" as const, other: link.a.room }] : [],
  );
}

/** Door id of a link's end in its room (the geometry stage names doors this way). */
export const linkDoorId = (linkId: string, end: "a" | "b") => `${linkId}_${end}`;
