import { describe, expect, it } from "vitest";
import {
  applyOperation,
  bindKey,
  BROWSER_MOUSE_BUTTONS,
  cleanOverrides,
  CONTROL_ACTION_IDS,
  controlConflicts,
  createDefaultProject,
  DEFAULT_BINDINGS,
  effectiveBindings,
  encodeStudioMessage,
  gameControlHelp,
  keyFromBrowserButton,
  keyFromBrowserCode,
  keyLabel,
  keysText,
  migrateProject,
  ProjectSpec,
  renderHelp,
  undoLast,
  validateProject,
  type HistoryEntry,
  type OperationResult,
} from "../src/index.ts";

function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

/** The keys main.gd's _setup_input hard-coded before controls were data. */
const TODAYS_MAP = {
  move_left: ["A", "Left"],
  move_right: ["D", "Right"],
  jump: ["Space", "Z"],
  attack: ["X", "J", "MouseLeft"],
  aim_up: ["W", "Up"],
  aim_down: ["S", "Down"],
  dash: ["C", "Shift", "K"],
  interact: ["W", "Up"],
  map: ["M", "Tab"],
  // Weapons (the loadout's slot actions and switching): new keys nobody had.
  alt_attack: ["V", "N", "MouseRight"],
  special_attack: ["F", "U"],
  weapon_cycle: ["Q", "I"],
};

describe("controls schema", () => {
  it("defaults to today's keys, for new projects and for projects saved before controls existed", () => {
    expect(DEFAULT_BINDINGS).toEqual(TODAYS_MAP);
    expect(createDefaultProject().controls).toEqual({ bindings: TODAYS_MAP, aim: "mouse" });
    const { controls: _, ...older } = createDefaultProject();
    const loaded = ProjectSpec.parse(older);
    expect(loaded.controls.bindings).toEqual(TODAYS_MAP);
    // A project file from before controls loads as it is, no migration step needed.
    const migrated = migrateProject(JSON.parse(JSON.stringify(older)));
    expect(ProjectSpec.parse(migrated).controls.bindings).toEqual(TODAYS_MAP);
    // A project with only some actions (an action added later) gets that action's default.
    const partial = ProjectSpec.parse({ ...older, controls: { bindings: { jump: ["L"] } } });
    expect(partial.controls.bindings).toEqual({ ...TODAYS_MAP, jump: ["L"] });
  });

  it("knows every action the runtime reads, and only known actions and keys", () => {
    expect(CONTROL_ACTION_IDS).toEqual(Object.keys(TODAYS_MAP));
    const base = createDefaultProject();
    const bad = (bindings: unknown) => validateProject({ ...base, controls: { bindings } }).ok;
    expect(bad({ fly: ["F"] })).toBe(false);
    expect(bad({ jump: ["Hyper"] })).toBe(false);
    expect(bad({ jump: ["Escape"] })).toBe(false);
    expect(bad({ jump: [] })).toBe(false);
    expect(bad({ jump: ["L", "L"] })).toBe(false);
    expect(bad({ jump: ["L", "Period", "7", "Semicolon"] })).toBe(true);
  });

  it("refuses one key on two actions used at the same time, except actions that share on purpose", () => {
    expect(controlConflicts(DEFAULT_BINDINGS)).toEqual([]); // aim_up and interact share W/Up on purpose
    const base = createDefaultProject();
    const result = validateProject({ ...base, controls: { bindings: { ...TODAYS_MAP, attack: ["Space"] } } });
    expect(result).toMatchObject({ ok: false, issues: [{ path: "controls.bindings.attack", message: expect.stringContaining("Space is bound to both Jump and Attack") }] });
    expect(controlConflicts({ ...TODAYS_MAP, map: ["W"] })).toEqual([
      { key: "W", actions: ["aim_up", "map"] },
      { key: "W", actions: ["interact", "map"] },
    ]);
    // Only the actions a game uses count, when asked.
    expect(controlConflicts({ ...TODAYS_MAP, attack: ["C"] }, ["attack", "jump"])).toEqual([]);
  });
});

describe("controls operations", () => {
  it("set an action's keys and reset one or all, each one undoable revision", () => {
    const base = createDefaultProject();
    let p = ok(applyOperation(base, "setControlKeys", { action: "jump", keys: ["L", "Period"] }));
    expect(p.revision).toBe(base.revision + 1);
    expect(p.controls.bindings.jump).toEqual(["L", "Period"]);
    const history: HistoryEntry[] = [{ revision: p.revision, at: "", author: "user", change: { kind: "operation", name: "setControlKeys", input: {} }, before: base }];
    const undone = undoLast(p, history);
    expect(undone.ok && undone.project.controls.bindings.jump).toEqual(["Space", "Z"]);

    p = ok(applyOperation(p, "setControlKeys", { action: "attack", keys: ["Semicolon"] }));
    p = ok(applyOperation(p, "resetControls", { action: "jump" }));
    expect(p.controls.bindings).toEqual({ ...TODAYS_MAP, attack: ["Semicolon"] });
    p = ok(applyOperation(p, "resetControls", {}));
    expect(p.controls.bindings).toEqual(TODAYS_MAP);
  });

  it("say which action already has the key", () => {
    const base = createDefaultProject();
    expect(applyOperation(base, "setControlKeys", { action: "attack", keys: ["Z"] })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("Z is already Jump's key (jump)") },
    });
    // Resetting one action onto a key another action took since is refused the same way.
    const moved = ok(applyOperation(ok(applyOperation(base, "setControlKeys", { action: "attack", keys: ["L"] })), "setControlKeys", { action: "jump", keys: ["X"] }));
    expect(applyOperation(moved, "resetControls", { action: "attack" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("X is already Jump's key") } });
    expect(applyOperation(base, "setControlKeys", { action: "fly", keys: ["F"] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(applyOperation(base, "setControlKeys", { action: "jump", keys: ["Hyper"] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("bind mouse buttons like keys, refused the same way", () => {
    const base = createDefaultProject();
    const p = ok(applyOperation(base, "setControlKeys", { action: "dash", keys: ["MouseMiddle", "C"] }));
    expect(p.controls.bindings.dash).toEqual(["MouseMiddle", "C"]);
    expect(applyOperation(base, "setControlKeys", { action: "attack", keys: ["MouseRight"] })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Right click is already Alt attack's key (alt_attack)") },
    });
    expect(applyOperation(base, "setControlKeys", { action: "attack", keys: ["MouseBack"] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("set how attacks aim (mouse or keys only), one undoable revision; the attack help follows", () => {
    const base = createDefaultProject();
    const p = ok(applyOperation(base, "setAimMode", { aim: "keys" }));
    expect(p.revision).toBe(base.revision + 1);
    expect(p.controls).toEqual({ bindings: TODAYS_MAP, aim: "keys" });
    const attack = (project: ProjectSpec) => renderHelp(gameControlHelp(project).help.find((h) => h.action === "attack")!.template, project.controls.bindings);
    expect(attack(p)).toBe("X/J/Left click (hold W/↑ or S/↓ to aim)");
    expect(attack(base)).toBe("X/J/Left click, toward the mouse (or hold W/↑ or S/↓ to aim)");
    const history: HistoryEntry[] = [{ revision: p.revision, at: "", author: "user", change: { kind: "operation", name: "setAimMode", input: {} }, before: base }];
    const undone = undoLast(p, history);
    expect(undone.ok && undone.project.controls.aim).toBe("mouse");
    expect(ok(applyOperation(p, "setAimMode", { aim: "mouse" })).controls.aim).toBe("mouse");
    expect(applyOperation(base, "setAimMode", { aim: "gamepad" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(applyOperation(base, "setAimMode", {})).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("player keys", () => {
  it("bind a pressed key (replace or add), refusing one a live action has", () => {
    expect(keyFromBrowserCode("KeyK")).toBe("K");
    expect(keyFromBrowserCode("ShiftLeft")).toBe("Shift");
    expect(keyFromBrowserCode("ArrowUp")).toBe("Up");
    expect(keyFromBrowserCode("Escape")).toBeNull();
    expect(bindKey(DEFAULT_BINDINGS, "jump", "L", "replace")).toEqual({ ok: true, keys: ["L"] });
    expect(bindKey(DEFAULT_BINDINGS, "jump", "L", "add")).toEqual({ ok: true, keys: ["Space", "Z", "L"] });
    expect(bindKey(DEFAULT_BINDINGS, "jump", "X", "replace")).toEqual({ ok: false, message: "X is already Attack's key. Give Attack another key first." });
    expect(bindKey(DEFAULT_BINDINGS, "interact", "W", "replace")).toEqual({ ok: true, keys: ["W"] });
    expect(bindKey({ ...DEFAULT_BINDINGS, dash: ["C", "Shift", "K", "L"] }, "dash", "P", "add")).toMatchObject({ ok: false, message: expect.stringContaining("already has 4 keys") });
  });

  it("bind a clicked mouse button (by MouseEvent.button) like a key", () => {
    expect([0, 1, 2, 3, 4].map(keyFromBrowserButton)).toEqual(["MouseLeft", "MouseMiddle", "MouseRight", null, null]);
    expect(BROWSER_MOUSE_BUTTONS).toEqual({ 0: "MouseLeft", 1: "MouseMiddle", 2: "MouseRight" });
    expect(["MouseLeft", "MouseRight", "MouseMiddle"].map(keyLabel)).toEqual(["Left click", "Right click", "Middle click"]);
    expect(bindKey(DEFAULT_BINDINGS, "attack", "MouseRight", "replace")).toEqual({ ok: false, message: "Right click is already Alt attack's key. Give Alt attack another key first." });
    // Among only the actions a game uses (no alt attack), the right button is free for attack.
    expect(bindKey(DEFAULT_BINDINGS, "attack", "MouseRight", "replace", ["attack", "jump"])).toEqual({ ok: true, keys: ["MouseRight"] });
    expect(bindKey(DEFAULT_BINDINGS, "jump", "MouseMiddle", "add")).toEqual({ ok: true, keys: ["Space", "Z", "MouseMiddle"] });
    expect(keysText(["X", "MouseLeft"])).toBe("X/Left click");
  });

  it("override the game's keys per action; anything malformed a browser stored is dropped", () => {
    const overrides = cleanOverrides({ jump: ["L"], attack: [], fly: ["F"], dash: ["Hyper"], map: "M" });
    expect(overrides).toEqual({ jump: ["L"] });
    expect(cleanOverrides("nonsense")).toEqual({});
    // Mouse buttons are keys too; buttons that can't be bound are dropped like unknown keys.
    expect(cleanOverrides({ attack: ["MouseRight", "X"], alt_attack: ["MouseBack"] })).toEqual({ attack: ["MouseRight", "X"] });
    expect(effectiveBindings(DEFAULT_BINDINGS, overrides)).toEqual({ ...TODAYS_MAP, jump: ["L"] });
  });

  it("help lines show the keys in effect", () => {
    const { help, actions } = gameControlHelp(createDefaultProject(), ["dash", "ground_pound"]);
    const bindings = effectiveBindings(DEFAULT_BINDINGS, { jump: ["L"] });
    expect(help.map((h) => [h.action, renderHelp(h.template, bindings)])).toEqual([
      ["move", "A/← and D/→"],
      ["jump", "L"],
      ["attack", "X/J/Left click, toward the mouse (or hold W/↑ or S/↓ to aim)"],
      ["dash", "C/Shift/K"],
      ["ground pound", "S/↓ + L in the air"],
      ["choose in menus", "A/← / D/→ and L or Enter"],
    ]);
    expect(actions).toEqual(["move_left", "move_right", "jump", "attack", "aim_up", "aim_down", "dash"]);
  });

  it("the protocol message carries the player's keys", () => {
    expect(JSON.parse(encodeStudioMessage({ type: "controls", overrides: { jump: ["L"] } }))).toMatchObject({
      source: "anomaly-studio",
      protocolVersion: 18,
      message: { type: "controls", overrides: { jump: ["L"] } },
    });
  });
});
