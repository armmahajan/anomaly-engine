import { z } from "zod";

/**
 * Movement abilities and their tuning. The runtime (game/scripts/player.gd)
 * and the movement model (./simulate.ts, ./model.ts) implement the same
 * rules; game/test/movement.test.ts keeps them in lockstep.
 */

export const MOVEMENT_ABILITIES = {
  dash: "Dash key: a fast horizontal burst (one in the air until you land or touch a wall).",
  double_jump: "Jump again in mid-air.",
  wall_jump: "Slide down walls you press against, and jump off them. Climbs a single wall by jumping off and steering back.",
  glide: "Hold jump while falling to fall slowly.",
  ground_pound: "Down + jump in the air: slam straight down, smashing breakable floors.",
} as const;
export type MovementAbility = keyof typeof MOVEMENT_ABILITIES;
export const MovementAbility = z.enum(Object.keys(MOVEMENT_ABILITIES) as [MovementAbility, ...MovementAbility[]]);

export const AbilityTuning = z.strictObject({
  dash: z
    .strictObject({
      distance: z.number().min(40).max(800).default(220).describe("px covered by one dash."),
      duration: z.number().min(0.05).max(0.6).default(0.2).describe("Seconds a dash lasts (no gravity meanwhile)."),
      cooldown: z.number().min(0).max(3).default(0.45).describe("Seconds from the start of one dash to the next."),
    })
    .prefault({}),
  doubleJump: z
    .strictObject({
      jumps: z.number().int().min(1).max(3).default(1).describe("Mid-air jumps before landing (or touching a wall)."),
      velocity: z.number().min(0).max(2000).default(680).describe("Upward speed of a mid-air jump, px/s."),
    })
    .prefault({}),
  wallJump: z
    .strictObject({
      slideSpeed: z.number().min(0).max(1000).default(150).describe("Fastest fall while pressing against a wall, px/s."),
      velocity: z.number().min(0).max(2000).default(700).describe("Upward speed of a wall jump, px/s."),
      kickSpeed: z.number().min(0).max(1000).default(340).describe("Speed away from the wall right after a wall jump, px/s."),
      kickTime: z.number().min(0).max(0.6).default(0.16).describe("Seconds the kick overrides steering."),
    })
    .prefault({}),
  glide: z
    .strictObject({
      fallSpeed: z.number().min(20).max(600).default(110).describe("Fall speed while gliding, px/s."),
    })
    .prefault({}),
  groundPound: z
    .strictObject({
      speed: z.number().min(200).max(3000).default(1400).describe("Slam speed, px/s."),
    })
    .prefault({}),
});
export type AbilityTuning = z.infer<typeof AbilityTuning>;

export const defaultAbilityTuning = (): AbilityTuning => AbilityTuning.parse({});

/** Physics frames per second. Movement is simulated in whole frames, like the runtime. */
export const MOVEMENT_FPS = 60;

/** Frame counts the runtime and the model both use. */
export const toFrames = (seconds: number) => Math.max(0, Math.round(seconds * MOVEMENT_FPS));

/** Fixed feel constants (not tunable yet). */
export const JUMP_CUT = 0.5;
export const WALL_COYOTE_FRAMES = 6;
export const POUND_RECOVERY_FRAMES = 9;

/** Everything movement depends on. */
export interface MovementParams {
  width: number;
  height: number;
  gravity: number;
  runSpeed: number;
  jumpVelocity: number;
  maxFallSpeed: number;
  coyoteTime: number;
  jumpBuffer: number;
  tuning: AbilityTuning;
}

export function movementParams(
  player: { size: { width: number; height: number }; stats: { runSpeed: number; jumpVelocity: number; maxFallSpeed: number; coyoteTime: number; jumpBuffer: number }; abilities: AbilityTuning },
  gravity: number,
): MovementParams {
  const { runSpeed, jumpVelocity, maxFallSpeed, coyoteTime, jumpBuffer } = player.stats;
  return { width: player.size.width, height: player.size.height, gravity, runSpeed, jumpVelocity, maxFallSpeed, coyoteTime, jumpBuffer, tuning: player.abilities };
}
