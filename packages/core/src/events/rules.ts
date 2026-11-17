import type { GameRules } from "../world/world.ts";
import type { Handler } from "./events.ts";

/**
 * The game rules are presets: each option is a few world handlers. The
 * runtime only knows handlers (toRuntimeProject adds these before the
 * world's own).
 */
export function ruleHandlers(rules: GameRules): Handler[] {
  const handlers: Handler[] = [
    { on: { type: "playerDied" }, when: [], do: [{ type: "respawn", at: rules.onDeath === "room" ? "entry" : rules.onDeath }, { type: "heal", amount: null }] },
  ];
  if (rules.hazardDamage > 0) {
    handlers.push({ on: { type: "hazardTouched" }, when: [], do: [{ type: "damage", amount: rules.hazardDamage }, { type: "returnToSafeGround" }] });
  } else {
    handlers.push({ on: { type: "hazardTouched" }, when: [], do: [{ type: "returnToSafeGround" }] });
  }
  if (rules.save === "room") {
    handlers.push({ on: { type: "roomEntered" }, when: [], do: [{ type: "saveRun" }] }, { on: { type: "roomSettled" }, when: [], do: [{ type: "saveRun" }] });
  }
  return handlers;
}
