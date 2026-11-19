import { z } from "zod";
import { Id } from "../common.ts";

/**
 * Animation in play (the animation target): anything with a rig can play its clips on cue.
 *
 * - An *object* is an animated asset that isn't a game character (CharacterAsset with
 *   subject "object": a lever, a trap, a shockwave, a bolt). Props draw with one, effects
 *   spawn one, projectiles fly as one. No role field: its brief says what it is.
 * - Handlers play clips (playAnimation) and spawn one-shot effects (spawnEffect).
 * - Clips carry markers (Clip.markers): reaching one fires a `marker` event, so a slam can
 *   shake the screen on the frame it lands.
 * - Projectiles (weapon attacks and the enemy shoot action) say where they appear on the shooter,
 *   whether they appear at fire or during the windup (charging), and what they look like.
 *
 * Nothing here knows any role; the runtime implements it in game/scripts/art/object_view.gd,
 * props.gd, fx.gd, events.gd and the projectile code.
 */

/** What a clip plays on. */
export const AnimTarget = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("self") }),
    z.strictObject({ kind: z.literal("player") }),
    z.strictObject({ kind: z.literal("prop"), prop: Id }),
    z.strictObject({ kind: z.literal("spawn"), spawn: Id }),
  ])
  .describe("self = the prop/spawn whose handler this is; prop/spawn = one in the current room.");
export type AnimTarget = z.infer<typeof AnimTarget>;

/** Where an effect appears: on a target (its centre) or at a point of the room. */
export const EffectPlace = z
  .discriminatedUnion("kind", [
    ...AnimTarget.options,
    z.strictObject({ kind: z.literal("point"), x: z.number(), y: z.number() }),
  ])
  .describe("A target's centre, or a room point (px).");
export type EffectPlace = z.infer<typeof EffectPlace>;

const OffsetPx = z.number().min(-1000).max(1000);

/** How a projectile looks and where it appears (weapon projectiles and the enemy shoot action). */
export const ProjectileArt = z.strictObject({
  object: Id.describe("Object asset, pointing right."),
  charge: Id.nullable().default(null).describe("Clip while charging (null = idle)."),
  fly: Id.nullable().default(null).describe("Clip in flight (null = idle)."),
  burst: Id.nullable().default(null).describe("Clip shown where it breaks (null = none)."),
});
export type ProjectileArt = z.infer<typeof ProjectileArt>;

export const ProjectileLook = z
  .strictObject({
    origin: z
      .tuple([OffsetPx, OffsetPx])
      .default([0, 0])
      .describe("px from the shooter's centre, facing right, y down ([0,-60] = above)."),
    appear: z
      .enum(["fire", "windup"])
      .default("fire")
      .describe("windup: sits at its origin charging through the windup, then fires."),
    art: ProjectileArt.nullable().default(null).describe("null = coloured shape."),
  })
  .describe("Where projectiles appear and how they look.");
export type ProjectileLook = z.infer<typeof ProjectileLook>;
