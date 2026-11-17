import { z } from "zod";
import { Color, Id } from "./common.ts";

/**
 * Behaviors are data: a state machine whose states each run one *action*
 * primitive and leave via *transitions* guarded by *condition* primitives.
 *
 * Primitives are implemented in the runtime (game/primitives/**); this file
 * is their contract. The runtime reports its primitive list on boot and the
 * studio flags any mismatch with ACTION_TYPES / CONDITION_TYPES.
 */

const Speed = z.number().min(0).max(2000).meta({ id: "Speed", description: "Speed in px/s (the player runs at ~320)." });
const Distance = z.number().min(0).max(4000).meta({ id: "Distance", description: "Distance in px (the player is ~44px tall)." });
const Seconds = z.number().min(0).max(30).describe("Duration in seconds.");
const Margin = z.number().min(0).max(4000).default(40).meta({ id: "Margin", description: "Vertical tolerance in px between the two centres." });

/** Shortest warning (s) before any attack can hurt: the schema can't express a faster one. */
export const MIN_WARNING = 0.25;
// Shared attack params: ids put them in $defs once per tool schema instead of repeating them.
const Windup = z
  .number()
  .min(MIN_WARNING)
  .max(5)
  .meta({ id: "Windup", description: `Warning (s, min ${MIN_WARNING}) before it can hurt; it flashes \`color\`.` });
const Time = z.number().min(0).max(10).meta({ id: "Time", description: "Seconds." });
const Px = z.number().min(0).max(4000).meta({ id: "Px", description: "px." });
const Offset = z.number().min(-400).max(400).meta({ id: "Offset", description: "px." });
const Damage = z.number().int().min(1).max(20).default(1).meta({ id: "Damage", description: "Damage to the player (knockback: its knockback stat)." });
const WarnColor = Color.default("#ffd27a").meta({ id: "WarnColor", description: "Warning flash color." });

export const Action = z
  .discriminatedUnion("type", [
    z
      .strictObject({
        type: z.literal("patrol"),
        speed: Speed,
        distance: Distance.describe("Total width of the patrol route in px, centred on the spawn point."),
        turnAtLedge: z.boolean().default(false).describe("Turn around instead of walking off a ledge."),
        turnAtWall: z.boolean().default(true).describe("Turn around on hitting a wall (otherwise push against it)."),
      })
      .describe("Walk back and forth around the spawn point. Signals actionDone each time it turns around."),
    z.strictObject({ type: z.literal("wait") }).describe("Stand still (flyers hold their position)."),
    z
      .strictObject({
        type: z.literal("chase"),
        speed: Speed,
        stopDistance: Distance.default(0).describe("Stop when this close to the player."),
      })
      .describe("Move toward the player: horizontally for ground characters, in 2D for flyers."),
    z
      .strictObject({
        type: z.literal("charge"),
        speed: Speed,
        direction: z
          .enum(["horizontal", "towardPlayer"])
          .default("horizontal")
          .describe("horizontal: a ground rush. towardPlayer: aims straight at the player (a dive, for flyers)."),
      })
      .describe(
        "Rush toward where the player was when the state began; does not steer. Signals actionDone on hitting a wall (flyers: any surface).",
      ),
    z
      .strictObject({
        type: z.literal("telegraph"),
        color: Color.describe("Flash color, #rrggbb."),
        shake: z.boolean().default(false).describe("Also shake in place."),
      })
      .describe("Stand still facing the player and flash: a readable warning before an attack. Pair with after."),
    z
      .strictObject({ type: z.literal("retreat"), speed: Speed })
      .describe("Move directly away from the player (2D for flyers). Ground characters stop at ledges."),
    z
      .strictObject({ type: z.literal("returnHome"), speed: Speed })
      .describe("Go back to the spawn point (2D for flyers). Signals actionDone on arrival."),
    z
      .strictObject({
        type: z.literal("jump"),
        height: z.number().min(0).max(1000).describe("Peak height above the take-off point in px."),
        distance: Distance.max(1500).describe("Horizontal distance covered by the leap in px."),
        toward: z.enum(["player", "facing"]).default("player").describe("Leap toward the player or the way it faces."),
      })
      .describe("Ground characters: one leap. Signals actionDone on landing. Flyers can't jump."),
    z
      .strictObject({
        type: z.literal("hover"),
        amplitude: z.number().min(0).max(400).default(12).describe("Bob height in px."),
        period: z.number().min(0.2).max(30).default(2).describe("Seconds per bob."),
      })
      .describe("Flyers: float in place, bobbing up and down. Ground characters just stand still."),
    z
      .strictObject({
        type: z.literal("strike"),
        windup: Windup.default(0.4),
        active: Time.default(0.2),
        recovery: Time.default(0.5),
        damage: Damage,
        width: Px.default(64),
        height: Px.default(48),
        offsetX: Offset.default(40),
        lunge: Speed.default(0),
        color: WarnColor,
      })
      .describe(
        "Melee: a width x height box centred offsetX px ahead shows during the windup, hurts for `active` s (moving `lunge` px/s forward), then `recovery` s still. Done at the end.",
      ),
    z
      .strictObject({
        type: z.literal("shoot"),
        windup: Windup.default(0.5),
        count: z.number().int().min(1).max(12).default(1),
        spread: z.number().min(0).max(360).default(30).describe("Fan angle in degrees."),
        speed: Speed.default(400),
        gravity: Px.default(0).describe("Fall acceleration, px/s²."),
        aim: z.enum(["player", "angle"]).default("player"),
        angle: z.number().min(-180).max(180).default(0).describe("Degrees from facing; 90 = down."),
        lifetime: Time.default(3),
        damage: Damage,
        pogo: z.boolean().default(false).describe("A downward sword strike bounces off it."),
        color: WarnColor,
      })
      .describe("Fire `count` projectiles in a fan; they break on solids or the player. Done once fired."),
    z
      .strictObject({
        type: z.literal("leap"),
        windup: Windup.default(0.4),
        height: Px.default(160),
        maxDistance: Px.default(400),
        color: WarnColor,
      })
      .describe("Ground: crouch flashing, then leap to land where the player stood (at most maxDistance px away). Done on landing."),
    z
      .strictObject({
        type: z.literal("slam"),
        windup: Windup.default(0.5),
        height: Px.default(80).describe("Hop height before crashing down (in the air: drops from there)."),
        damage: Damage,
        waveSpeed: Speed.default(500),
        waveReach: Px.default(400),
        waveHeight: Px.default(28),
        color: WarnColor,
      })
      .describe("Ground: hop and crash down; on landing a shockwave runs along the ground both ways (jump over it). Done on landing."),
    z
      .strictObject({
        type: z.literal("summon"),
        character: Id.describe("Enemy character to summon."),
        count: z.number().int().min(1).max(5).default(1),
        max: z.number().int().min(1).max(10).describe("Cap on its summons alive at once."),
        windup: Windup.default(0.6),
        color: WarnColor,
      })
      .describe("Flash, then call `count` enemies beside itself (never more than `max` alive). Done after."),
    z
      .strictObject({
        type: z.literal("teleport"),
        to: z.enum(["home", "random", "behindPlayer"]).default("behindPlayer"),
        range: Px.default(300).describe("random: max px from home; behindPlayer: px behind the player."),
        windup: Windup.default(0.6).describe("Seconds gone (untouchable) while a marker shows where it will appear."),
        color: WarnColor,
      })
      .describe("Vanish, mark the spot, reappear there. Done on reappearing."),
  ])
  .describe("What the character does while in a state.");
export type Action = z.infer<typeof Action>;

export const Condition = z
  .discriminatedUnion("type", [
    z
      .strictObject({ type: z.literal("playerWithin"), distance: Distance })
      .describe("True when the player's centre is within `distance` px of this character's centre."),
    z
      .strictObject({ type: z.literal("playerBeyond"), distance: Distance })
      .describe("True when the player is farther than `distance` px away (or absent)."),
    z
      .strictObject({ type: z.literal("after"), seconds: Seconds })
      .describe("True once the character has spent `seconds` in the current state."),
    z.strictObject({ type: z.literal("hitWall") }).describe("True when the character is pressing against a wall."),
    z
      .strictObject({ type: z.literal("actionDone") })
      .describe("True once the state's action has finished: patrol turned around, jump landed, returnHome arrived, charge hit something."),
    z
      .strictObject({ type: z.literal("atLedge") })
      .describe("True when standing on the ground with no ground just ahead (about to walk off)."),
    z.strictObject({ type: z.literal("onGround") }).describe("True when standing on the ground."),
    z.strictObject({ type: z.literal("airborne") }).describe("True when not standing on the ground."),
    z
      .strictObject({ type: z.literal("playerAbove"), margin: Margin })
      .describe("True when the player's centre is more than `margin` px above this character's centre."),
    z
      .strictObject({ type: z.literal("playerBelow"), margin: Margin })
      .describe("True when the player's centre is more than `margin` px below this character's centre."),
    z
      .strictObject({ type: z.literal("playerLevel"), margin: Margin })
      .describe("True when the player's centre is within `margin` px vertically of this character's centre: roughly on the same level."),
    z.strictObject({ type: z.literal("playerInFront") }).describe("True when the player is on the side this character faces."),
    z.strictObject({ type: z.literal("playerBehind") }).describe("True when the player is behind this character."),
    z
      .strictObject({ type: z.literal("canSeePlayer") })
      .describe("True when no platform blocks the straight line to the player. Combine with playerWithin (via `and`) for range."),
    z.strictObject({ type: z.literal("wasHit") }).describe("True once the player's sword has hit this character in the current state."),
    z
      .strictObject({ type: z.literal("healthBelow"), fraction: z.number().min(0).max(1).describe("Fraction of max health, 0..1.") })
      .describe("True when health is below this fraction of its maximum, e.g. 0.5 for a second phase at half health."),
    z
      .strictObject({ type: z.literal("chance"), p: z.number().min(0).max(1).describe("Probability, 0..1.") })
      .describe(
        "Rolled once each time the state is entered (seeded per run). Put it before a fallback transition to branch randomly, e.g. [chance 0.5 -> charge, after 0 -> jump].",
      ),
  ])
  .describe("When a transition fires.")
  .meta({ id: "Condition" });
export type Condition = z.infer<typeof Condition>;

export const ACTION_TYPES = Action.options.map((o) => o.shape.type.value);
export const CONDITION_TYPES = Condition.options.map((o) => o.shape.type.value);

export const Transition = z
  .strictObject({
    when: Condition,
    and: z
      .array(Condition)
      .max(4)
      .optional()
      .describe("Extra conditions that must all hold too, e.g. when playerWithin 260 and playerLevel 60."),
    to: Id.describe("Id of the state to switch to."),
  })
  .describe("Leave the current state when `when` and every `and` condition hold.")
  .meta({ id: "Transition" });
export type Transition = z.infer<typeof Transition>;

export const BehaviorState = z.strictObject({
  action: Action,
  transitions: z
    .array(Transition)
    .max(10)
    .describe("Checked in order every physics tick; the first that holds wins. Empty = stay in this state."),
});
export type BehaviorState = z.infer<typeof BehaviorState>;

export const Behavior = z
  .strictObject({
    initial: Id.describe("State the character starts in."),
    states: z.record(Id, BehaviorState).describe("States by id (lowercase snake_case), at most 20."),
    interrupts: z
      .array(Transition)
      .max(10)
      .default([])
      .describe(
        "Transitions checked from every state, before the state's own (one leading to the current state is skipped). E.g. go to returnHome whenever the player is beyond 600px.",
      ),
  })
  .superRefine((behavior, ctx) => {
    const ids = Object.keys(behavior.states);
    if (ids.length === 0) ctx.addIssue({ code: "custom", path: ["states"], message: "a behavior needs at least one state" });
    if (ids.length > 20) ctx.addIssue({ code: "custom", path: ["states"], message: "a behavior can have at most 20 states" });
    if (!(behavior.initial in behavior.states)) {
      ctx.addIssue({ code: "custom", path: ["initial"], message: `initial state "${behavior.initial}" does not exist` });
    }
    behavior.interrupts.forEach((t, i) => {
      if (!(t.to in behavior.states)) {
        ctx.addIssue({ code: "custom", path: ["interrupts", i, "to"], message: `interrupt to unknown state "${t.to}"` });
      }
    });
    for (const [id, state] of Object.entries(behavior.states)) {
      state.transitions.forEach((t, i) => {
        if (!(t.to in behavior.states)) {
          ctx.addIssue({
            code: "custom",
            path: ["states", id, "transitions", i, "to"],
            message: `transition to unknown state "${t.to}"`,
          });
        }
      });
    }
  });
export type Behavior = z.infer<typeof Behavior>;

export type ParamKind = "number" | "boolean" | "color" | "enum" | "text";
export interface ParamInfo {
  name: string;
  kind: ParamKind;
  options?: readonly string[];
}

/** The parameters of an action or condition primitive, for editors. */
export function primitiveParams(group: "action" | "condition", type: string): ParamInfo[] {
  const union = group === "action" ? Action : Condition;
  const option = union.options.find((o) => o.shape.type.value === type);
  if (!option) return [];
  return Object.entries(option.shape as Record<string, z.ZodType>)
    .filter(([name]) => name !== "type")
    .map(([name, schema]) => {
      const inner = schema instanceof z.ZodDefault ? (schema.unwrap() as z.ZodType) : schema;
      if (inner instanceof z.ZodEnum) return { name, kind: "enum" as const, options: inner.options as string[] };
      if (inner instanceof z.ZodBoolean) return { name, kind: "boolean" as const };
      if (inner instanceof z.ZodNumber) return { name, kind: "number" as const };
      return { name, kind: inner.safeParse("#000000").success ? ("color" as const) : ("text" as const) };
    });
}
