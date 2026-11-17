import { z } from "zod";
import { ProjectSpec } from "./schema.ts";
import type { ArtDirection } from "./art/asset.ts";
import type { Clip } from "./art/clip.ts";
import type { Rig } from "./art/rig.ts";
import type { WorldLayer, WorldScene } from "./art/world.ts";
import type { RuntimeProject } from "./world/runtime.ts";

/**
 * Studio <-> runtime messages, sent with window.postMessage as JSON strings.
 * The protocol speaks in project terms (characters, spawns), never in
 * Godot terms, so the runtime can be replaced without touching the studio.
 *
 * Lifecycle: runtime boots -> `ready`. Studio sends `load` (edit mode:
 * the scene is built from the spec but frozen). `play` starts simulation;
 * `stop` rebuilds from the loaded spec (= reset) and freezes again.
 * `load` is rejected while playing: the game is never edited while running.
 */

export const PROTOCOL_VERSION = 11;
export const MAX_SEED = 2 ** 31 - 1;
export const STUDIO_SOURCE = "anomaly-studio";
export const RUNTIME_SOURCE = "anomaly-runtime";

export const RuntimeMode = z.enum(["edit", "play"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

export type StudioToRuntime =
  | { type: "load"; project: RuntimeProject }
  /**
   * `seed` drives every random choice in the run (e.g. `chance`), so a run can be replayed.
   * With `world`, play from there; without it, the world's playtest (room, spot and abilities).
   */
  | { type: "play"; seed: number; world?: WorldStart }
  | { type: "stop" }
  | { type: "getState"; requestId: string }
  /** Render frames of a rig into one PNG contact sheet (left to right, then down). Works without a loaded project. */
  | ({ type: "renderRig" } & RenderRigRequest)
  /** Edit mode only: make every spawn of a character play `clip` (null = back to normal). */
  | { type: "previewClip"; characterId: string; clip: string | null }
  /** What the runtime shows (studio modes). Ignored while playing; `game` is the playtest room. */
  | { type: "stage"; stage: Stage }
  /** Images (base64 by file ref) for worlds; the runtime keeps them, so each is sent once. */
  | { type: "images"; images: Record<string, string> };

/** Where a world run begins. */
export interface WorldStart {
  room: string;
  /** The player's feet, px from the room's top-left. */
  x: number;
  y: number;
  /** Movement abilities the player has (pickups arrive later). */
  abilities: string[];
  /** Resume the run saved in this browser (rules.save "room"), if there is one; else start here. */
  continue?: boolean;
}

/**
 * The runtime's stage: the playtest room (`game`), one character large on a neutral
 * stage (Characters mode), or a world room (Worlds mode).
 */
export type Stage =
  | { mode: "game" }
  | {
      mode: "character";
      characterId: string;
      /** Clip to show (null = rest pose). */
      clip: string | null;
      /** Seconds into the clip to hold, or null to play continuously. */
      time: number | null;
      speed: number;
      /** Face left instead of right. */
      flip: boolean;
      /** Draw bones and pivots over the rig. */
      bones: boolean;
      /**
       * The design image drawn behind the rig, aligned to it, at `alpha` (0 = hidden).
       * image: base64 PNG to load, "" to clear, null to keep the current one (send it once, not with every frame).
       */
      onion: { image: string | null; alpha: number };
    }
  | StageWorld
  /** One game-world room, frozen, for editing (Rooms mode). */
  | { mode: "room"; roomId: string };

export interface StageWorld {
  mode: "world";
  /** The room as the runtime draws it (core worldSceneFor). Its images must have been sent with `images`. */
  scene: WorldScene;
  /** Layers to hide. */
  hidden: WorldLayer[];
  fog: boolean;
  lights: boolean;
  /** Tilt the layers apart to show how the depth is built. */
  exploded: boolean;
  /** Placement to highlight. */
  selected: string | null;
  /** Let the creator drag pieces (else drag only pans). */
  editable: boolean;
}

export interface RenderRigRequest {
  requestId: string;
  rig: Rig;
  direction: ArtDirection;
  clips: Record<string, Clip>;
  /** One cell per frame: a clip (null = rest pose) at a time in seconds. */
  frames: { clip: string | null; time: number }[];
  cellWidth: number;
  cellHeight: number;
  columns: number;
  /** #rrggbb, or null for a transparent background. */
  background: string | null;
  /** Scale and centre the rig in each cell (default). false = rig coordinates are cell pixels. */
  fit?: boolean;
}

const EntityState = z.object({
  /** Which spawn this entity came from (several can share a character). */
  spawnId: z.string(),
  characterId: z.string(),
  x: z.number(),
  y: z.number(),
  velocityX: z.number(),
  velocityY: z.number(),
  /**
   * Enemies: current behavior state ("windup"). Player: "slash_forward" | "slash_up" | "slash_down"
   * while swinging, else "dash" | "ground_pound" | "wall_slide" | "glide", else "hurt" while
   * invulnerable after a hit, else null.
   */
  behaviorState: z.string().nullable(),
  /** Remaining hit points; 0 = dead (a dead enemy stays listed but is gone from play). */
  health: z.number(),
});
export type EntityState = z.infer<typeof EntityState>;

export const RuntimeToStudio = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    protocolVersion: z.number(),
    /** Primitive types the runtime implements; must match core ACTION_TYPES / CONDITION_TYPES. */
    primitives: z.object({ actions: z.array(z.string()), conditions: z.array(z.string()) }),
  }),
  z.object({ type: z.literal("loaded"), revision: z.number() }),
  z.object({ type: z.literal("modeChanged"), mode: RuntimeMode }),
  z.object({
    type: z.literal("state"),
    requestId: z.string(),
    mode: RuntimeMode,
    revision: z.number(),
    /** Seed of the current run; null in edit mode. */
    seed: z.number().nullable(),
    /** Times the player has died (and the run restarted) since play began. */
    deaths: z.number(),
    /** What the runtime is showing (see Stage). */
    stage: z.enum(["game", "character", "world", "room"]).default("game"),
    /** The room shown is drawn with its biome dressing. */
    dressed: z.boolean().default(false),
    entities: z.array(EntityState),
    /** The room the player is in (or shown, in edit mode), rooms visited this run, and where the player comes back on death. */
    room: z.string().nullable().default(null),
    visited: z.array(z.string()).default([]),
    entry: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  /** Play: the player entered a room (at the start of the run, through a door, or on respawn). */
  z.object({ type: z.literal("roomEntered"), room: z.string() }),
  /** World stage: the creator clicked a piece (null = empty space). */
  z.object({ type: z.literal("worldPick"), placementId: z.string().nullable() }),
  /** World stage: the creator dragged a piece to a new room position. */
  // `free`: Alt was held, so the studio keeps the drop point instead of snapping it onto a surface.
  z.object({ type: z.literal("worldMove"), placementId: z.string(), x: z.number(), y: z.number(), free: z.boolean().optional() }),
  /** World stage: where the camera is looking (room x), after the creator pans. */
  z.object({ type: z.literal("worldCamera"), x: z.number() }),
  z.object({
    type: z.literal("rendered"),
    requestId: z.string(),
    /** Base64 PNG; absent when `error` is set. */
    png: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    /** Rig px -> image px. */
    scale: z.number().optional(),
    /** Parts the renderer had to skip, etc. */
    warnings: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
]);
export type RuntimeToStudio = z.infer<typeof RuntimeToStudio>;

const Envelope = z.object({ source: z.literal(RUNTIME_SOURCE), message: z.unknown() });

export function encodeStudioMessage(message: StudioToRuntime): string {
  return JSON.stringify({ source: STUDIO_SOURCE, protocolVersion: PROTOCOL_VERSION, message });
}

export type DecodeResult =
  | { kind: "message"; message: RuntimeToStudio }
  /** Not ours (e.g. a browser extension); ignore silently. */
  | { kind: "foreign" }
  | { kind: "invalid"; reason: string };

export function decodeRuntimeMessage(data: unknown): DecodeResult {
  if (typeof data !== "string") return { kind: "foreign" };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { kind: "foreign" };
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) return { kind: "foreign" };
  const parsed = RuntimeToStudio.safeParse(envelope.data.message);
  if (!parsed.success) {
    return { kind: "invalid", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { kind: "message", message: parsed.data };
}
