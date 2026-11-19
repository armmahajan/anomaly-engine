import { z } from "zod";
import { Id } from "../common.ts";

/**
 * Animation clips: keyframed bone tracks plus *motions*, small parameterized
 * animation primitives (sway, bob, pulse...) that the runtime evaluates.
 * Motions are cheap for the AI to write and hard to get wrong; keyframes
 * cover anything specific (a leg cycle, a strike).
 *
 * Time inside a clip is normalized: 0 = start, 1 = end (`duration` seconds).
 * All values are offsets from the rest pose: rotate in degrees (clockwise,
 * the character faces right), x/y in px, scale as a multiplier (1 = rest).
 */

const T = z.number().min(0).max(1).describe("Normalized time, 0..1.");

export const TrackProperty = z.enum(["rotate", "x", "y", "scaleX", "scaleY"]);
export type TrackProperty = z.infer<typeof TrackProperty>;

export const Track = z.strictObject({
  bone: Id,
  property: TrackProperty,
  keys: z
    .array(z.tuple([T, z.number().min(-2000).max(2000)]))
    .min(1)
    .max(32)
    .describe("[t, value] pairs in time order. For a looping clip, make the last value equal the first."),
  ease: z.enum(["smooth", "linear", "step"]).default("smooth"),
});
export type Track = z.infer<typeof Track>;

const Cycles = z.number().int().min(1).max(16).default(1).describe("Whole cycles per clip (whole numbers loop seamlessly).");
const Phase = z.number().min(0).max(1).default(0).describe("Offset within a cycle, 0..1 (e.g. 0.5 for the opposite leg).");

export const Motion = z
  .discriminatedUnion("type", [
    z
      .strictObject({ type: z.literal("sway"), bone: Id, degrees: z.number().min(-180).max(180), cycles: Cycles, phase: Phase })
      .describe("Rotate back and forth by ±degrees (sine): legs, tails, antennae, wings, breathing heads."),
    z
      .strictObject({ type: z.literal("bob"), bone: Id, amount: z.number().min(-200).max(200), cycles: Cycles, phase: Phase })
      .describe("Move up and down by ±amount px (sine): body bounce in walk/idle, hovering."),
    z
      .strictObject({ type: z.literal("shift"), bone: Id, amount: z.number().min(-200).max(200), cycles: Cycles, phase: Phase })
      .describe("Move forward and back by ±amount px (sine): leg steps, head thrusts."),
    z
      .strictObject({ type: z.literal("pulse"), bone: Id, amount: z.number().min(-1).max(1), cycles: Cycles, phase: Phase })
      .describe("Scale up and down by ±amount (0.05 = 5%): breathing, throbbing."),
    z
      .strictObject({
        type: z.literal("squash"),
        bone: Id,
        amount: z.number().min(-0.8).max(0.8).describe("+ squashes (shorter and wider), - stretches."),
        at: T.describe("When the squash peaks."),
        width: z.number().min(0.02).max(1).default(0.25).describe("How long it lasts, as a fraction of the clip."),
      })
      .describe("One squash-and-stretch pulse that keeps volume: landings, impacts, wind-ups."),
    z
      .strictObject({ type: z.literal("shake"), bone: Id, amount: z.number().min(0).max(50).describe("px") })
      .describe("Fast jitter: rage, wind-up tension, being hurt."),
  ])
  .describe("An animation primitive, added on top of keyframed tracks.");
export type Motion = z.infer<typeof Motion>;

export const PartVisibility = z.strictObject({
  part: Id,
  keys: z.array(z.tuple([T, z.boolean()])).min(1).max(32).describe("[t, visible] pairs: the part shows/hides at each t."),
});

export const Clip = z.strictObject({
  duration: z.number().min(0.05).max(10).describe("Seconds."),
  loop: z.boolean().describe("Loop (idle, walk, run, fly) or play once and hold the last frame (attack, hurt)."),
  tracks: z.array(Track).max(64).default([]),
  motions: z.array(Motion).max(64).default([]),
  visibility: z.array(PartVisibility).max(32).default([]).describe("Show/hide parts over time: blinks, smears, effects."),
  direction: z.string().max(600).optional().describe("What the creator asked this animation to be (kept to redo it: the animation list)."),
});
export type Clip = z.infer<typeof Clip>;

/**
 * Clip slots the runtime looks for, by situation. Enemies map their current
 * behavior action to a slot (falling back along the list); a character's
 * `stateClips` can point a specific behavior state at any clip instead.
 */
export const CLIP_SLOTS = {
  idle: "Standing still (also the fallback for everything).",
  walk: "Patrolling or moving slowly.",
  run: "Chasing or moving fast.",
  windup: "Telegraphing an attack: a readable anticipation pose.",
  attack: "Charging or striking (also the player's built-in attack, unless slash_forward/slash_up/slash_down exist; weapon attacks have their own clips).",
  hurt: "Just took a hit (plays once).",
  jump: "Rising in the air.",
  fall: "Falling.",
  fly: "Airborne movement for flying characters.",
  strike: "A melee hit landing (the strike action's active part).",
  shoot: "Firing projectiles.",
  leap: "Airborne in an attack leap.",
  slam: "Crashing down onto the ground.",
  cast: "Calling up something (summon) or vanishing and reappearing (teleport).",
  recover: "Recovering after an attack: the opening to hit back.",
  death: "Defeated (plays once, loop false, about 0.5-1 s): collapses, falls or breaks apart and holds its last, still pose; never returns to rest.",
} as const;
export type ClipSlot = keyof typeof CLIP_SLOTS;

/**
 * Which slot each behavior action uses, with fallbacks (first existing clip
 * wins, then idle). Flying characters use "fly" instead of walk/run.
 */
export const ACTION_CLIP_SLOTS: Record<string, readonly ClipSlot[]> = {
  strike: ["attack"],
  shoot: ["attack"],
  leap: ["jump"],
  slam: ["attack"],
  summon: ["windup"],
  teleport: ["idle"],
  patrol: ["walk", "run"],
  wait: ["idle"],
  chase: ["run", "walk"],
  charge: ["attack", "run"],
  telegraph: ["windup"],
  retreat: ["walk", "run"],
  returnHome: ["walk"],
  jump: ["jump"],
  hover: ["fly"],
};

/** The phases of an attack action (reported by the runtime, which picks clips by phase). */
export const ATTACK_PHASES = ["windup", "active", "recovery"] as const;
export type AttackPhase = (typeof ATTACK_PHASES)[number];

/** Attack actions: slots by phase, with fallbacks (then the action's ACTION_CLIP_SLOTS, then idle). */
export const ACTION_PHASE_SLOTS: Record<string, Record<AttackPhase, readonly ClipSlot[]>> = {
  strike: { windup: ["windup"], active: ["strike", "attack"], recovery: ["recover", "idle"] },
  shoot: { windup: ["windup"], active: ["shoot", "attack"], recovery: ["recover", "idle"] },
  leap: { windup: ["windup"], active: ["leap", "jump"], recovery: ["recover", "idle"] },
  slam: { windup: ["windup"], active: ["slam", "attack"], recovery: ["recover", "idle"] },
  summon: { windup: ["cast", "windup"], active: ["cast"], recovery: ["recover", "idle"] },
  teleport: { windup: ["cast", "windup"], active: ["cast"], recovery: ["recover", "idle"] },
};

/** The slots to try for an action in a phase (first existing clip wins, then idle). Flyers fly instead of walk/run. */
export function clipSlotsFor(actionType: string, phase: string | null = null, flying = false): ClipSlot[] {
  const phased = phase ? ACTION_PHASE_SLOTS[actionType]?.[phase as AttackPhase] : undefined;
  let slots = [...new Set([...(phased ?? []), ...(ACTION_CLIP_SLOTS[actionType] ?? [])])];
  if (flying && (slots.includes("walk") || slots.includes("run"))) slots = ["fly", ...slots];
  return slots;
}

/** Clip slots every enemy uses, whatever its behavior: struck by the player, and killed. */
export const ENEMY_CLIP_SLOTS: readonly ClipSlot[] = ["hurt", "death"];

/** Clips that play once and hold their last frame whatever the behavior does (the runtime stops acting on death). */
export const ONE_SHOT_CLIP_SLOTS: readonly ClipSlot[] = ["hurt", "death"];

/** Clip slots the player uses. */
export const PLAYER_CLIP_SLOTS: readonly ClipSlot[] = ["idle", "run", "jump", "fall", "attack", "hurt"];
