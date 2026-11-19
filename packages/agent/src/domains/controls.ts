import { CONTROL_ACTIONS, keysText, ResetControlsInput, SetAimModeInput, SetControlKeysInput } from "@anomaly/core";
import type { DomainTools } from "./types.ts";

export const controlTools: DomainTools<"setControlKeys" | "resetControls" | "setAimMode"> = {
  descriptions: {
    setControlKeys:
      "Set the game's default keys for one action (replacing them; players can still change keys in their browser). Mouse buttons bind like keys (MouseLeft, MouseRight, MouseMiddle). Two actions used at the same time can't share a key.",
    resetControls: "Give one action (or, without action, every action) its default keys back.",
    setAimMode: "How the player aims attacks: mouse (toward the cursor, any direction; the aim keys still work) or keys (the aim keys only: up, forward, down).",
  },
  schemas: {
    setControlKeys: SetControlKeysInput,
    resetControls: ResetControlsInput,
    setAimMode: SetAimModeInput,
  },
  summary: (project) => [`Controls (aim: ${project.controls.aim}): ${CONTROL_ACTIONS.map((a) => `${a.id} ${keysText(project.controls.bindings[a.id])}`).join(", ")}.`],
};
