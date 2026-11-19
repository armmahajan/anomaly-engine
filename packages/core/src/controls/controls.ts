import { z } from "zod";

/**
 * Game controls: which keys play the game. The project holds the game's own (default) keys per
 * action (`project.controls.bindings`); a player can override any action's keys in their browser
 * (stored by the host page, sent to the runtime with the `controls` message). The runtime builds
 * its input map from both: an overridden action uses the player's keys, every other one the game's.
 *
 * Generic on purpose: an action is a name the runtime reads plus its default keys. A new action
 * (e.g. an alternate attack) is one more entry in CONTROL_ACTIONS (and the runtime code that reads it);
 * older projects get its default keys from the schema.
 */

// --- keys ----------------------------------------------------------------------------------

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");

/** Keys that are not letters or digits: name -> label shown to people. */
const NAMED_KEYS = {
  Space: "Space",
  Enter: "Enter",
  Shift: "Shift",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Tab: "Tab",
  Backspace: "Backspace",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
  Backquote: "`",
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  // Mouse buttons bind like keys (the runtime maps them to mouse button events).
  MouseLeft: "Left click",
  MouseRight: "Right click",
  MouseMiddle: "Middle click",
} as const;

/** Key names that are mouse buttons (the runtime binds them as mouse button events, the studio captures clicks for them). */
export const MOUSE_BUTTONS = ["MouseLeft", "MouseRight", "MouseMiddle"] as const;

/**
 * Every key a game action can be bound to, by layout-independent position (a QWERTY "W" is the key
 * left of "E" on any layout). Escape is not here: it always closes panels and leaves full screen.
 */
export const KEY_NAMES = [...LETTERS, ...DIGITS, ...Object.keys(NAMED_KEYS)] as [string, ...string[]];
export const KeyName = z.enum(KEY_NAMES);
export type KeyName = z.infer<typeof KeyName>;

/** How a key is shown to people ("Space", "←", ","). */
export const KEY_LABELS: Record<string, string> = Object.fromEntries([...LETTERS, ...DIGITS].map((k) => [k, k]).concat(Object.entries(NAMED_KEYS)));

export const keyLabel = (key: string): string => KEY_LABELS[key] ?? key;

/** Browser KeyboardEvent.code -> key name (both Shift keys are "Shift", and so on). */
export const BROWSER_KEY_CODES: Record<string, KeyName> = Object.fromEntries([
  ...LETTERS.map((k) => [`Key${k}`, k]),
  ...DIGITS.map((k) => [`Digit${k}`, k]),
  ...["Space", "Enter", "Tab", "Backspace", "Comma", "Period", "Slash", "Semicolon", "Quote", "BracketLeft", "BracketRight", "Minus", "Equal", "Backslash", "Backquote", "Insert", "Delete", "Home", "End", "PageUp", "PageDown"].map((k) => [k, k]),
  ["ShiftLeft", "Shift"],
  ["ShiftRight", "Shift"],
  ["ControlLeft", "Ctrl"],
  ["ControlRight", "Ctrl"],
  ["AltLeft", "Alt"],
  ["AltRight", "Alt"],
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
]);

/** The key a browser key press is (by KeyboardEvent.code), or null if it can't be bound. */
export const keyFromBrowserCode = (code: string): KeyName | null => BROWSER_KEY_CODES[code] ?? null;

// --- actions -------------------------------------------------------------------------------

export interface ControlActionInfo {
  /** The runtime's input action. */
  id: string;
  label: string;
  /** What it does, for the Controls page and the AI. */
  description: string;
  /** Today's keys: what a game gets unless it says otherwise. */
  defaults: readonly KeyName[];
  /** Actions read at the same time (in play) can't share a key, unless they list each other in `shares`. */
  context: "play";
  /** Actions this one may share keys with on purpose. */
  shares?: readonly string[];
}

/**
 * Every action the runtime reads (game/scripts: player.gd, props.gd, modal.gd). Menus (modals) also
 * follow move left / right and aim up / down to choose and jump to press, plus Enter and the arrow
 * keys, which always work there. To add an action: one entry here, and the runtime code that reads it.
 */
export const CONTROL_ACTIONS = [
  { id: "move_left", label: "Move left", description: "Run left; chooses in menus.", defaults: ["A", "Left"], context: "play" },
  { id: "move_right", label: "Move right", description: "Run right; chooses in menus.", defaults: ["D", "Right"], context: "play" },
  { id: "jump", label: "Jump", description: "Jump (hold for higher, again in the air with double jump, hold while falling to glide); presses menu buttons.", defaults: ["Space", "Z"], context: "play" },
  { id: "attack", label: "Attack", description: "Use the main weapon (or the built-in attack), toward the aim.", defaults: ["X", "J", "MouseLeft"], context: "play" },
  { id: "aim_up", label: "Aim up", description: "Hold while attacking to swing upward; chooses in menus.", defaults: ["W", "Up"], context: "play", shares: ["interact"] },
  { id: "aim_down", label: "Aim down", description: "Hold in the air while attacking to strike down (pogo); with jump in the air, ground pound; chooses in menus.", defaults: ["S", "Down"], context: "play" },
  { id: "dash", label: "Dash", description: "Dash (with the dash ability).", defaults: ["C", "Shift", "K"], context: "play" },
  { id: "interact", label: "Interact", description: "Use what the player overlaps (a prop's interact event).", defaults: ["W", "Up"], context: "play", shares: ["aim_up"] },
  { id: "map", label: "Map", description: "Open and close the map screen (when the game has one).", defaults: ["M", "Tab"], context: "play" },
  { id: "alt_attack", label: "Alt attack", description: "Use the weapon in the loadout slot bound to it (when the game has one), toward the aim.", defaults: ["V", "N", "MouseRight"], context: "play" },
  { id: "special_attack", label: "Special attack", description: "Use the weapon in the loadout slot bound to it (when the game has one).", defaults: ["F", "U"], context: "play" },
  { id: "weapon_cycle", label: "Switch weapon", description: "Swap the main slot to the next weapon the player has (when the game allows it).", defaults: ["Q", "I"], context: "play" },
] as const satisfies readonly ControlActionInfo[];

export type ControlActionId = (typeof CONTROL_ACTIONS)[number]["id"];
export const CONTROL_ACTION_IDS = CONTROL_ACTIONS.map((a) => a.id) as [ControlActionId, ...ControlActionId[]];
export const ControlAction = z.enum(CONTROL_ACTION_IDS);

export const controlAction = (id: string): ControlActionInfo | undefined => (CONTROL_ACTIONS as readonly ControlActionInfo[]).find((a) => a.id === id);
export const actionLabel = (id: string): string => controlAction(id)?.label ?? id;

export const MAX_KEYS_PER_ACTION = 4;

const KeyList = z
  .array(KeyName)
  .min(1, "an action needs at least one key")
  .max(MAX_KEYS_PER_ACTION)
  .refine((keys) => new Set(keys).size === keys.length, "a key is listed twice");

/** Keys per action; every action is present (missing ones get their defaults). */
export const ControlBindings = z.strictObject(
  Object.fromEntries(CONTROL_ACTIONS.map((a) => [a.id, KeyList.default([...a.defaults])])) as { [K in ControlActionId]: z.ZodDefault<typeof KeyList> },
);
export type ControlBindings = z.infer<typeof ControlBindings>;

/** A player's own keys: some actions, each replacing the game's keys for it. */
export type ControlOverrides = Partial<Record<ControlActionId, KeyName[]>>;

export const DEFAULT_BINDINGS: ControlBindings = ControlBindings.parse({});

export interface KeyConflict {
  key: KeyName;
  actions: [ControlActionId, ControlActionId];
}

const mayShare = (a: string, b: string) => {
  const x = controlAction(a);
  const y = controlAction(b);
  return !x || !y || x.context !== y.context || (x.shares ?? []).includes(b) || (y.shares ?? []).includes(a);
};

/** Keys bound to two actions that are live at the same time (and don't share on purpose). `among`: only these actions count. */
export function controlConflicts(bindings: Partial<Record<string, readonly string[]>>, among?: Iterable<string>): KeyConflict[] {
  const only = among ? new Set(among) : null;
  const ids = CONTROL_ACTION_IDS.filter((id) => !only || only.has(id));
  const out: KeyConflict[] = [];
  ids.forEach((a, i) => {
    for (const b of ids.slice(i + 1)) {
      if (mayShare(a, b)) continue;
      for (const key of bindings[a] ?? []) if ((bindings[b] ?? []).includes(key)) out.push({ key: key as KeyName, actions: [a, b] });
    }
  });
  return out;
}

export const conflictMessage = (c: KeyConflict) => `${keyLabel(c.key)} is bound to both ${actionLabel(c.actions[0])} and ${actionLabel(c.actions[1])}`;

/**
 * Bind `key` to `action` (`replace`: as its only key; `add`: beside its keys), or say why not:
 * another live action already uses it. `among`: only these actions count for conflicts.
 */
export function bindKey(
  bindings: Partial<Record<string, readonly string[]>>,
  action: ControlActionId,
  key: KeyName,
  mode: "replace" | "add",
  among?: Iterable<string>,
): { ok: true; keys: KeyName[] } | { ok: false; message: string } {
  const current = (bindings[action] ?? []) as KeyName[];
  if (mode === "add" && current.includes(key)) return { ok: true, keys: current };
  if (mode === "add" && current.length >= MAX_KEYS_PER_ACTION) return { ok: false, message: `${actionLabel(action)} already has ${MAX_KEYS_PER_ACTION} keys; remove one first` };
  const keys = mode === "add" ? [...current, key] : [key];
  const clash = controlConflicts({ ...bindings, [action]: keys }, among).find((c) => c.actions.includes(action) && c.key === key);
  if (clash) {
    const other = clash.actions[0] === action ? clash.actions[1] : clash.actions[0];
    return { ok: false, message: `${keyLabel(key)} is already ${actionLabel(other)}'s key. Give ${actionLabel(other)} another key first.` };
  }
  return { ok: true, keys };
}

/** Keep only well-formed overrides (known actions, known keys, 1 to 4 distinct keys): what a browser stored may be anything. */
export function cleanOverrides(value: unknown): ControlOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ControlOverrides = {};
  for (const id of CONTROL_ACTION_IDS) {
    const keys = KeyList.safeParse((value as Record<string, unknown>)[id]);
    if (keys.success) out[id] = keys.data;
  }
  return out;
}

/** The keys in effect: the player's override per action, else the game's. */
export function effectiveBindings(game: ControlBindings, overrides: ControlOverrides = {}): ControlBindings {
  return Object.fromEntries(CONTROL_ACTION_IDS.map((id) => [id, overrides[id] ?? game[id]])) as ControlBindings;
}

/** "X/J": an action's keys as people read them. */
export const keysText = (keys: readonly string[]): string => keys.map(keyLabel).join("/");

// --- the project section ---------------------------------------------------------------------

export const Controls = z
  .strictObject({
    bindings: ControlBindings.prefault({}).describe("Keys per action (the game's defaults; players may override them in their browser)."),
    aim: z
      .enum(["mouse", "keys"])
      .default("mouse")
      .describe(
        "How the player aims attacks. mouse: toward the cursor, any direction (the aim keys still aim up/forward/down when the mouse isn't used); keys: only the aim keys (up, forward, down).",
      ),
  })
  .superRefine((controls, ctx) => {
    for (const c of controlConflicts(controls.bindings)) {
      ctx.addIssue({ code: "custom", path: ["bindings", c.actions[1]], message: `${conflictMessage(c)}, which are used at the same time` });
    }
  });
export type Controls = z.infer<typeof Controls>;

// --- what a game shows players ---------------------------------------------------------------

export interface ControlHelp {
  /** What it does ("jump", "dash"). */
  action: string;
  /** How, with {action_id} where that action's keys go ("{aim_down} + {jump} in the air"). */
  template: string;
}

const BASIC_HELP: ControlHelp[] = [
  { action: "move", template: "{move_left} and {move_right}" },
  { action: "jump", template: "{jump}" },
  { action: "attack", template: "{attack} (hold {aim_up} or {aim_down} to aim)" },
];

const ABILITY_HELP: Record<string, ControlHelp> = {
  dash: { action: "dash", template: "{dash}" },
  double_jump: { action: "jump again", template: "{jump} in the air" },
  wall_jump: { action: "wall jump", template: "Toward a wall, then {jump}" },
  glide: { action: "glide", template: "Hold {jump} while falling" },
  ground_pound: { action: "ground pound", template: "{aim_down} + {jump} in the air" },
};

/** The attack line when the game aims with the mouse. */
const MOUSE_ATTACK_TEMPLATE = "{attack}, toward the mouse (or hold {aim_up} or {aim_down} to aim)";

const MENU_HELP: ControlHelp = { action: "choose in menus", template: "{move_left} / {move_right} and {jump} or Enter" };

/** A help line with the keys filled in. */
export const renderHelp = (template: string, bindings: Partial<Record<string, readonly string[]>>): string =>
  template.replace(/\{([a-z_]+)\}/g, (all, id: string) => (bindings[id] ? keysText(bindings[id]!) : all));

/** The actions a help template mentions. */
export const helpActions = (template: string): ControlActionId[] =>
  [...template.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!).filter((id): id is ControlActionId => (CONTROL_ACTION_IDS as string[]).includes(id));

interface HelpWeapons {
  list?: { id: string; name: string }[];
  loadout?: { slots?: { id: string; label: string; action: string; start: string | null }[]; cycle?: boolean };
}

/**
 * Help for the loadout's weapon actions, said the way this game uses them: a slot on alt_attack or
 * special_attack shows when it starts with a weapon or the game gives one into it (giveWeapon to that
 * slot, or to the first free one); weapon_cycle when cycling is on and the player can hold two weapons.
 * The attack line names the weapon the main slot starts with.
 */
function weaponHelp(weapons: HelpWeapons | undefined, given: { weapon: string; slot: string | null }[]): { attack: ControlHelp | null; extra: ControlHelp[] } {
  const slots = weapons?.loadout?.slots ?? [];
  const name = (id: string | null) => (id ? (weapons?.list?.find((w) => w.id === id)?.name ?? null) : null);
  const named = (slot: { label: string; start: string | null }) => {
    const weapon = name(slot.start);
    return weapon ? `${slot.label.toLowerCase()}: ${weapon}` : slot.label.toLowerCase();
  };
  const main = slots.find((s) => s.action === "attack");
  const attack = main && name(main.start) ? { ...BASIC_HELP[2]!, action: `attack (${name(main.start)})` } : null;
  const extra: ControlHelp[] = [];
  for (const slot of slots) {
    if (slot.action !== "alt_attack" && slot.action !== "special_attack") continue;
    if (slot.start === null && !given.some((g) => g.slot === slot.id || g.slot === null)) continue;
    extra.push({ action: named(slot), template: `{${slot.action}}` });
  }
  const held = new Set([...slots.flatMap((s) => (s.start ? [s.start] : [])), ...given.map((g) => g.weapon)]);
  if (weapons?.loadout?.cycle && held.size > 1) extra.push({ action: "switch weapon", template: "{weapon_cycle}" });
  return { attack, extra };
}

/**
 * What a game shows its players about keys: the basics, plus the abilities it can grant (or `abilities`,
 * e.g. a playtest's), the weapon actions its loadout uses, interacting and the map when it has them, and
 * menus. Also which actions that uses.
 */
export function gameControlHelp(project: { world: unknown; controls?: unknown; weapons?: unknown }, abilities: readonly string[] = []): { help: ControlHelp[]; actions: ControlActionId[] } {
  const world = project.world as { map?: { enabled?: boolean } };
  const granted = new Set<string>(abilities);
  const events = new Set<string>();
  const given: { weapon: string; slot: string | null }[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "grantAbility" && typeof record.ability === "string") granted.add(record.ability);
    if (record.type === "giveWeapon" && typeof record.weapon === "string") given.push({ weapon: record.weapon, slot: typeof record.slot === "string" ? record.slot : null });
    if (typeof record.type === "string") events.add(record.type);
    Object.values(record).forEach(walk);
  };
  walk(project.world);
  const weapons = weaponHelp(project.weapons as HelpWeapons | undefined, given);
  const mouse = ((project.controls as { aim?: string } | undefined)?.aim ?? "mouse") === "mouse";
  // Mouse aiming: attacks go toward the cursor; the aim keys still aim up and down.
  const aimed = (h: ControlHelp): ControlHelp => (h.action.startsWith("attack") && mouse ? { ...h, template: MOUSE_ATTACK_TEMPLATE } : h);
  const help = (weapons.attack ? BASIC_HELP.map((h) => (h.action === "attack" ? weapons.attack! : h)) : [...BASIC_HELP]).map(aimed);
  help.push(...weapons.extra);
  for (const [ability, entry] of Object.entries(ABILITY_HELP)) if (granted.has(ability)) help.push(entry);
  if (events.has("interact")) help.push({ action: "interact", template: "{interact}" });
  if (world.map?.enabled) help.push({ action: "map", template: "{map}" });
  help.push(MENU_HELP);
  const used = new Set(help.flatMap((h) => helpActions(h.template)));
  return { help, actions: CONTROL_ACTION_IDS.filter((id) => used.has(id)) };
}

/** A new game's controls: every action on its default keys. */
export const defaultControls = (): Controls => ({ bindings: ControlBindings.parse({}), aim: "mouse" });
