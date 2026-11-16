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

const Speed = z.number().min(0).max(2000).describe("Horizontal speed in px/s (player runs at ~320).");
const Distance = z.number().min(0).max(4000).describe("Distance in px (the player is ~44px tall).");
const Seconds = z.number().min(0).max(30).describe("Duration in seconds.");

export const Action = z
  .discriminatedUnion("type", [
    z
      .strictObject({
        type: z.literal("patrol"),
        speed: Speed,
        distance: Distance.describe("Total width of the patrol route in px, centred on the spawn point."),
      })
      .describe("Walk back and forth around the spawn point, turning at walls and at the route's ends."),
    z.strictObject({ type: z.literal("wait") }).describe("Stand still."),
    z.strictObject({ type: z.literal("chase"), speed: Speed }).describe("Run toward the player."),
    z
      .strictObject({ type: z.literal("charge"), speed: Speed })
      .describe(
        "Rush horizontally toward where the player was when the state began; does not steer. Pair with hitWall/after to end it.",
      ),
    z
      .strictObject({ type: z.literal("telegraph"), color: Color.describe("Flash color, #rrggbb.") })
      .describe("Stand still facing the player and flash: a readable warning before an attack. Pair with after."),
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
  ])
  .describe("When a transition fires.");
export type Condition = z.infer<typeof Condition>;

export const ACTION_TYPES = Action.options.map((o) => o.shape.type.value);
export const CONDITION_TYPES = Condition.options.map((o) => o.shape.type.value);

export const Transition = z
  .strictObject({ when: Condition, to: Id.describe("Id of the state to switch to.") })
  .describe("Leave the current state when `when` holds.");
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
  })
  .superRefine((behavior, ctx) => {
    const ids = Object.keys(behavior.states);
    if (ids.length === 0) ctx.addIssue({ code: "custom", path: ["states"], message: "a behavior needs at least one state" });
    if (ids.length > 20) ctx.addIssue({ code: "custom", path: ["states"], message: "a behavior can have at most 20 states" });
    if (!(behavior.initial in behavior.states)) {
      ctx.addIssue({ code: "custom", path: ["initial"], message: `initial state "${behavior.initial}" does not exist` });
    }
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
