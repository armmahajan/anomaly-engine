import { z } from "zod";
import { ProjectSpec } from "./schema.ts";

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

export const PROTOCOL_VERSION = 5;
export const MAX_SEED = 2 ** 31 - 1;
export const STUDIO_SOURCE = "anomaly-studio";
export const RUNTIME_SOURCE = "anomaly-runtime";

export const RuntimeMode = z.enum(["edit", "play"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

export type StudioToRuntime =
  | { type: "load"; project: ProjectSpec }
  /** `seed` drives every random choice in the run (e.g. `chance`), so a run can be replayed. */
  | { type: "play"; seed: number }
  | { type: "stop" }
  | { type: "getState"; requestId: string };

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
   * while swinging, "hurt" while invulnerable after a hit, else null.
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
    entities: z.array(EntityState),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
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
