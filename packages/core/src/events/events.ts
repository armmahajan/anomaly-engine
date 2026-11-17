import { z } from "zod";
import { Color, Id } from "../common.ts";
import { MovementAbility } from "../movement/params.ts";

/**
 * Game logic is data: *handlers* bind an event to conditions and effects.
 * `{ on, when, do }`: when the event happens and every condition holds, the
 * effects run in order. Conditions are checked when the event happens, before
 * any handler for it runs. Handlers live on the world, a room, a prop or an
 * enemy spawn; on a room, prop or spawn the event is scoped to it (a room's
 * roomEntered is that room's, a prop's touch is that prop's, a spawn's
 * enemyKilled is that spawn's).
 *
 * Nothing here knows about any role an object plays in a game: roles are
 * recipes (data) built from these primitives. The runtime implements them in
 * game/scripts/events.gd (engine and the shared effects) and in the files of
 * the systems that own the rest (props, modals, fx).
 */

const Seconds = z.number().min(0).max(600);

export const GameEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("gameStarted") }).describe("A run begins (from the start, a playtest or a saved run)."),
  z.strictObject({ type: z.literal("roomEntered"), room: Id.optional() }).describe("The player enters a room (any room, or `room`)."),
  z.strictObject({ type: z.literal("roomSettled"), room: Id.optional() }).describe("The player first stands on safe ground in a room they entered."),
  z.strictObject({ type: z.literal("roomCleared"), room: Id.optional() }).describe("The last enemy alive in a room dies."),
  z
    .strictObject({ type: z.literal("enemyKilled"), spawn: Id.optional(), character: Id.optional() })
    .describe("An enemy dies (any, one spawn in the current room, or any spawn of `character`)."),
  z.strictObject({ type: z.literal("playerDied") }).describe("The player's health reaches 0."),
  z.strictObject({ type: z.literal("hazardTouched") }).describe("The player touches a hazard tile."),
  z.strictObject({ type: z.literal("timer"), timer: Id }).describe("A timer started with startTimer runs out."),
  z.strictObject({ type: z.literal("touch") }).describe("Prop: the player starts overlapping it."),
  z.strictObject({ type: z.literal("interact") }).describe("Prop: the player presses interact (Up / W) while overlapping it."),
  z.strictObject({ type: z.literal("hit") }).describe("Prop: the player's sword strikes it."),
  z.strictObject({ type: z.literal("destroyed") }).describe("Prop: its health (hits) runs out."),
]);
export type GameEvent = z.infer<typeof GameEvent>;
export type GameEventType = GameEvent["type"];
export const GAME_EVENT_TYPES = GameEvent.options.map((o) => o.shape.type.value);
/** Events only a prop fires (about itself). */
export const PROP_EVENTS: readonly GameEventType[] = ["touch", "interact", "hit", "destroyed"];

export type GameCondition =
  | { type: "flag"; flag: string; is: boolean }
  | { type: "item"; item: string; atLeast: number }
  | { type: "ability"; ability: MovementAbility }
  | { type: "visited"; room: string }
  | { type: "all"; of: GameCondition[] }
  | { type: "any"; of: GameCondition[] }
  | { type: "not"; of: GameCondition };

export const GameCondition: z.ZodType<GameCondition, unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("flag"), flag: Id, is: z.boolean().default(true) }).describe("A flag is set (or, with is false, not set)."),
    z.strictObject({ type: z.literal("item"), item: Id, atLeast: z.number().int().min(0).max(999).default(1) }).describe("The player has at least `atLeast` of an item."),
    z.strictObject({ type: z.literal("ability"), ability: MovementAbility }).describe("The player has a movement ability."),
    z.strictObject({ type: z.literal("visited"), room: Id }).describe("The player has been in a room this run."),
    z.strictObject({ type: z.literal("all"), of: z.array(GameCondition).min(1).max(10) }).describe("Every one holds."),
    z.strictObject({ type: z.literal("any"), of: z.array(GameCondition).min(1).max(10) }).describe("At least one holds."),
    z.strictObject({ type: z.literal("not"), of: GameCondition }).describe("It does not hold."),
  ]),
);
export const GAME_CONDITION_TYPES = ["flag", "item", "ability", "visited", "all", "any", "not"] as const;

export const Effect = z.discriminatedUnion("type", [
  // The run's state.
  z.strictObject({ type: z.literal("setFlag"), flag: Id, value: z.boolean().default(true) }).describe("Set (or clear) a flag. Flags are saved with the run."),
  z.strictObject({ type: z.literal("giveItem"), item: Id, count: z.number().int().min(1).max(999).default(1) }).describe("Give the player items."),
  z.strictObject({ type: z.literal("takeItem"), item: Id, count: z.number().int().min(1).max(999).default(1) }).describe("Take items from the player (down to 0)."),
  z.strictObject({ type: z.literal("grantAbility"), ability: MovementAbility }).describe("Give the player a movement ability for the rest of the run."),
  // The player.
  z.strictObject({ type: z.literal("heal"), amount: z.number().int().min(1).max(99).nullable().default(null) }).describe("Restore health (null = all of it)."),
  z.strictObject({ type: z.literal("damage"), amount: z.number().int().min(1).max(99) }).describe("Hurt the player (no knockback; ignored while invulnerable)."),
  z
    .strictObject({ type: z.literal("respawn"), at: z.enum(["entry", "start", "checkpoint"]).default("entry") })
    .describe("Rebuild a room (its enemies come back) with the player at: where they entered the current room, the game's start, or the last checkpoint (else the start)."),
  z.strictObject({ type: z.literal("returnToSafeGround") }).describe("Put the player back on the last ground they stood safely on (if alive)."),
  z
    .strictObject({ type: z.literal("setCheckpoint"), room: Id.optional(), x: z.number().optional(), y: z.number().optional() })
    .describe("Where respawn at checkpoint goes: room/x/y, or by default where the player stands now."),
  z.strictObject({ type: z.literal("saveRun") }).describe("Save the run (room, respawn point, checkpoint, abilities, flags, items, visited) in this browser."),
  z.strictObject({ type: z.literal("startTimer"), timer: Id, seconds: Seconds }).describe("Fire a timer event after `seconds` (restarts it if running)."),
  // Screens.
  z.strictObject({ type: z.literal("showModal"), modal: Id }).describe("Open a modal (queued behind any open one). Gameplay pauses while it is open."),
  z.strictObject({ type: z.literal("endGame"), modal: Id.optional() }).describe("End the run, after showing `modal` if given."),
  z.strictObject({ type: z.literal("revealMap"), rooms: z.array(Id).max(200).optional() }).describe("Mark rooms (default: every room) as known on the map."),
  // Feedback.
  z.strictObject({ type: z.literal("shake"), strength: z.number().min(0).max(64).default(8), seconds: z.number().min(0).max(5).default(0.3) }).describe("Shake the camera (strength in px)."),
  z.strictObject({ type: z.literal("flash"), color: Color.default("#ffffff"), seconds: z.number().min(0).max(5).default(0.2) }).describe("Flash the screen a color and fade out."),
  z.strictObject({ type: z.literal("hitStop"), frames: z.number().int().min(1).max(60).default(6) }).describe("Freeze the action for a few frames."),
  z
    .strictObject({ type: z.literal("slowMotion"), scale: z.number().min(0.05).max(1).default(0.3), seconds: z.number().min(0).max(5).default(0.8) })
    .describe("Slow time to `scale` for `seconds` (real time)."),
]);
export type Effect = z.infer<typeof Effect>;
export type EffectType = Effect["type"];
export const EFFECT_TYPES = Effect.options.map((o) => o.shape.type.value);

export const Handler = z.strictObject({
  on: GameEvent,
  when: z.array(GameCondition).max(10).default([]).describe("Every one must hold."),
  do: z.array(Effect).min(1).max(20).describe("Run in order."),
});
export type Handler = z.infer<typeof Handler>;
export const Handlers = z.array(Handler).max(50).default([]);

/** Every condition in a list, nested ones included. */
export function flattenConditions(conditions: GameCondition[]): GameCondition[] {
  return conditions.flatMap((c) => [c, ...(c.type === "all" || c.type === "any" ? flattenConditions(c.of) : c.type === "not" ? flattenConditions([c.of]) : [])]);
}
