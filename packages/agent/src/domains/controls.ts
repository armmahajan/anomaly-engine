import { CONTROL_ACTIONS, keysText, ResetControlsInput, SetControlKeysInput } from "@anomaly/core";
import type { DomainTools } from "./types.ts";

export const controlTools: DomainTools<"setControlKeys" | "resetControls"> = {
  descriptions: {
    setControlKeys: "Set the game's default keys for one action (replacing them; players can still change keys in their browser). Two actions used at the same time can't share a key.",
    resetControls: "Give one action (or, without action, every action) its default keys back.",
  },
  schemas: {
    setControlKeys: SetControlKeysInput,
    resetControls: ResetControlsInput,
  },
  summary: (project) => [`Controls: ${CONTROL_ACTIONS.map((a) => `${a.id} ${keysText(project.controls.bindings[a.id])}`).join(", ")}.`],
};
