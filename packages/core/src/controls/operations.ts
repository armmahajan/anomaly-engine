import { z } from "zod";
import type { OperationResult } from "../operations.ts";
import type { ProjectSpec } from "../schema.ts";
import { commit, fail, parse } from "../world/opHelpers.ts";
import { actionLabel, AimMode, ControlAction, controlConflicts, DEFAULT_BINDINGS, KeyName, keyLabel, MAX_KEYS_PER_ACTION, type ControlActionId, type ControlBindings } from "./controls.ts";

/** Controls operations: the game's own keys per action (players can still override them in their browser). */

export const SetControlKeysInput = z.strictObject({
  action: ControlAction,
  keys: z
    .array(KeyName)
    .min(1)
    .max(MAX_KEYS_PER_ACTION)
    .describe("The action's keys, replacing its current ones: letters A-Z, digits 0-9, Space, Enter, Shift, Ctrl, Alt, Tab, Up, Down, Left, Right, Comma, Period, Slash, ...; mouse buttons MouseLeft, MouseRight, MouseMiddle"),
});

export const SetAimModeInput = z.strictObject({
  aim: AimMode.describe("mouse: attacks go toward the cursor, any direction (the aim keys still aim when the mouse isn't used); keys: only the aim keys aim (up, forward, down)."),
});

export const ResetControlsInput = z.strictObject({
  action: ControlAction.optional().describe("The action to give its default keys back; omit to reset every action."),
});

function withBindings(project: ProjectSpec, bindings: ControlBindings, changed: ControlActionId[]): OperationResult {
  // Say which action already has the key, rather than the whole-project validation message.
  const clash = controlConflicts(bindings).find((c) => c.actions.some((a) => changed.includes(a)));
  if (clash) {
    const mine = clash.actions.find((a) => changed.includes(a))!;
    const other = clash.actions[0] === mine ? clash.actions[1] : clash.actions[0];
    return fail("invalid_input", `${keyLabel(clash.key)} is already ${actionLabel(other)}'s key (${other}); two actions used at the same time can't share a key. Change ${other} first or pick another key for ${mine}.`);
  }
  return commit({ ...project, controls: { ...project.controls, bindings } });
}

/** Set one action's keys (replacing them). Refused if another action used at the same time has one of them. */
export function setControlKeys(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetControlKeysInput, input, "setControlKeys");
  if (!p.ok) return p;
  const { action, keys } = p.data;
  if (new Set(keys).size !== keys.length) return fail("invalid_input", "a key is listed twice");
  return withBindings(project, { ...project.controls.bindings, [action]: keys }, [action]);
}

/** Give one action (or every action) its default keys back. */
export function resetControls(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ResetControlsInput, input ?? {}, "resetControls");
  if (!p.ok) return p;
  const { action } = p.data;
  if (!action) return withBindings(project, { ...DEFAULT_BINDINGS }, []);
  return withBindings(project, { ...project.controls.bindings, [action]: [...DEFAULT_BINDINGS[action]] }, [action]);
}

/** How the player aims attacks: toward the mouse cursor (the aim keys still work), or with the aim keys only. */
export function setAimMode(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetAimModeInput, input, "setAimMode");
  if (!p.ok) return p;
  return commit({ ...project, controls: { ...project.controls, aim: p.data.aim } });
}

export const controlOperations = { setControlKeys, resetControls, setAimMode };
export const CONTROL_OPERATION_NAMES = Object.keys(controlOperations) as (keyof typeof controlOperations)[];
