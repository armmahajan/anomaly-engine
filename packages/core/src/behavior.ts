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

const Speed = z.number().min(0).max(2000);
const Distance = z.number().min(0).max(4000);
const Seconds = z.number().min(0).max(30);

export const Action = z.discriminatedUnion("type", [
  /** Walk back and forth around the character's spawn point. */
  z.strictObject({ type: z.literal("patrol"), speed: Speed, distance: Distance }),
  /** Stand still. */
  z.strictObject({ type: z.literal("wait") }),
  /** Run toward the player. */
  z.strictObject({ type: z.literal("chase"), speed: Speed }),
  /** Rush in the direction of the player at the moment the state starts. */
  z.strictObject({ type: z.literal("charge"), speed: Speed }),
  /** Stand still, face the player and flash: a readable warning before an attack. */
  z.strictObject({ type: z.literal("telegraph"), color: Color }),
]);
export type Action = z.infer<typeof Action>;

export const Condition = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("playerWithin"), distance: Distance }),
  z.strictObject({ type: z.literal("playerBeyond"), distance: Distance }),
  /** Time spent in the current state. */
  z.strictObject({ type: z.literal("after"), seconds: Seconds }),
  z.strictObject({ type: z.literal("hitWall") }),
]);
export type Condition = z.infer<typeof Condition>;

export const ACTION_TYPES = Action.options.map((o) => o.shape.type.value);
export const CONDITION_TYPES = Condition.options.map((o) => o.shape.type.value);

export const Transition = z.strictObject({ when: Condition, to: Id });
export type Transition = z.infer<typeof Transition>;

export const BehaviorState = z.strictObject({
  action: Action,
  /** Checked in order every tick; the first that holds wins. */
  transitions: z.array(Transition).max(10),
});
export type BehaviorState = z.infer<typeof BehaviorState>;

export const Behavior = z
  .strictObject({
    initial: Id,
    states: z.record(Id, BehaviorState),
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
