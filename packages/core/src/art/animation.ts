import { z } from "zod";
import { Color, Id } from "../common.ts";

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
 * - Looks (Look) are visual states on a character, prop or the player: tint, brightness, opacity,
 *   scale, an aura, afterimages and an emitter. setLook / clearLook put them on and take them off,
 *   a behavior state can carry one (BehaviorState.look), emit shows an emitter at a place,
 *   dissolve fades a target out or in, cameraZoom punches the camera in.
 *
 * Nothing here knows any role; the runtime implements it in game/scripts/art/object_view.gd,
 * look_view.gd, props.gd, fx.gd, events.gd and the projectile code. All of it is visual: the logic
 * model (world/logic/interpret.ts) reads none of it.
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

/** Code-drawn particles (no art needed). */
export const Emitter = z
  .strictObject({
    shape: z.enum(["dot", "spark", "ring", "smoke", "star"]).default("dot"),
    color: Color.default("#ffffff"),
    colorEnd: Color.optional().describe("Fades to this."),
    rate: z.number().min(0).max(200).default(20).describe("Per s."),
    burst: z.number().int().min(0).max(200).default(0).describe("Count at the start."),
    lifetime: z.number().min(0.05).max(5).default(0.6),
    speed: z.number().min(0).max(2000).default(80),
    spread: z.number().min(0).max(360).default(360).describe("Cone (deg)."),
    direction: z.number().min(-360).max(360).default(-90).describe("Deg, -90 = up."),
    gravity: z.number().min(-2000).max(2000).default(0),
    size: z.number().min(0.5).max(64).default(4),
    sizeEnd: z.number().min(0).max(64).optional(),
    additive: z.boolean().default(true).describe("Glow (added) or paint."),
  })
  .describe("Particles.");
export type Emitter = z.infer<typeof Emitter>;

/** A visual state on a character, prop or the player. Every field is optional; none changes gameplay. */
export const Look = z
  .strictObject({
    tint: z.strictObject({ color: Color, amount: z.number().min(0).max(1).default(0.5) }).optional(),
    brightness: z.number().min(0).max(4).optional().describe("1 = normal."),
    opacity: z.number().min(0).max(1).optional(),
    scale: z.number().min(0.25).max(4).optional(),
    aura: z
      .strictObject({ color: Color, size: z.number().min(1).max(64).default(12), pulse: z.number().min(0).max(1).default(0.3) })
      .optional()
      .describe("Glow around the silhouette (px)."),
    afterimages: z
      .strictObject({
        count: z.number().int().min(1).max(8).default(4),
        interval: z.number().min(0.02).max(1).default(0.06),
        fade: z.number().min(0.05).max(2).default(0.3),
        color: Color.optional(),
      })
      .optional()
      .describe("Fading copies of the pose left behind (s)."),
    emitter: Emitter.optional(),
  })
  .describe("A visual state.");
export type Look = z.infer<typeof Look>;

/** The keys a look sets (runtime state entities[].look). */
export const lookKeys = (look: Look): string[] => Object.keys(look).filter((k) => look[k as keyof Look] !== undefined);
