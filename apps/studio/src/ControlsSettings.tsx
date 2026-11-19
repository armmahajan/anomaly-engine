import { useEffect, useRef, useState } from "react";
import { bindKey, CONTROL_ACTIONS, controlConflicts, DEFAULT_BINDINGS, keyFromBrowserButton, keyFromBrowserCode, keyLabel, type AimMode, type ControlActionId, type KeyName, type ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";

/** The studio's own shortcuts (not rebindable), so this page is the one place to look keys up. */
const STUDIO_SHORTCUTS: readonly [keys: string, does: string][] = [
  ["Ctrl/Cmd+Z", "Undo the last change (outside text fields)"],
  ["Enter", "Chat: send · fields: save the value"],
  ["Shift+Enter", "Chat: new line"],
  ["Escape", "Close a menu, dialog or popover · cancel a field or message edit · stop waiting for a key here"],
  ["← / →, Home / End", "Studio tabs: move between them (Enter or Space opens one)"],
  ["↑ / ↓, Home / End", "Side lists and menus: move between items"],
  ["← / → (Shift: bigger steps), Home", "A focused panel edge: resize it (Home: the default width)"],
  ["Alt while dragging", "Scenery: drop a piece where it is, without snapping it to a surface"],
  ["Ctrl/Cmd+wheel", "Progression graph: zoom (the wheel alone pans)"],
];

const same = (a: readonly string[], b: readonly string[]) => a.join() === b.join();

/** How the player aims attacks (project.controls.aim; setAimMode): mode, label, what the page says after. */
const AIM_MODES: readonly [AimMode, string, string][] = [
  ["mouse", "Mouse (toward the cursor; aim keys still work)", "Aim: toward the mouse (the aim keys still work)"],
  ["keys", "Keys only", "Aim: with the aim keys only"],
];

/** The weapon actions show only when the loadout uses them (a slot on alt/special attack, cycling on). */
function shownActions(project: ProjectSpec) {
  const { slots, cycle } = project.weapons.loadout;
  const used = new Set<string>(slots.map((s) => s.action));
  if (cycle) used.add("weapon_cycle");
  const optional = new Set(["alt_attack", "special_attack", "weapon_cycle"]);
  return CONTROL_ACTIONS.filter((a) => !optional.has(a.id) || used.has(a.id));
}

/**
 * Game tab: the game's keys per action and how attacks aim (project.controls; setControlKeys /
 * resetControls / setAimMode, undoable). Change (or + Key), then press a key, or click the waiting
 * row's "click here" with a mouse button; a key another action already uses is refused here with why.
 * Playtests and exported games use these; players can still change them in an exported game (? ▸ Change keys).
 */
export function ControlsSettings({ project, session, locked }: { project: ProjectSpec; session: Session; locked: boolean }) {
  const { bindings } = project.controls;
  const [listening, setListening] = useState<{ action: ControlActionId; mode: "replace" | "add" } | null>(null);
  const [message, setMessage] = useState("");

  const edit = async (op: string, input: unknown, done: string) => {
    const result = await session.applyOperation(op, input);
    setMessage(result.ok ? done : result.error.message);
  };
  const setKeys = (action: ControlActionId, keys: KeyName[]) =>
    void edit("setControlKeys", { action, keys }, `${label(action)}: ${keys.map(keyLabel).join(" / ")}`);

  const actions = shownActions(project);
  // Bind what was pressed (a key or a mouse button) to the waiting action, or say why not. An action
  // this page hides (the loadout doesn't use it, e.g. alt attack's right click) gives the key up, in
  // the same undo step, as long as it keeps another key.
  const capture = (key: KeyName | null, what: string) => {
    if (!listening) return;
    const { action, mode } = listening;
    setListening(null);
    if (!key) return setMessage(`${what} can't be bound; pick another.`);
    const bound = bindKey(bindings, action, key, mode, actions.map((a) => a.id));
    if (!bound.ok) return setMessage(bound.message);
    if (same(bound.keys, bindings[action])) return;
    const hidden = controlConflicts({ ...bindings, [action]: bound.keys })
      .filter((c) => c.key === key && c.actions.includes(action))
      .map((c) => (c.actions[0] === action ? c.actions[1] : c.actions[0]));
    if (hidden.length === 0) return setKeys(action, bound.keys);
    const freed = hidden.map((id) => ({ id, keys: bindings[id].filter((k) => k !== key) }));
    const stuck = freed.find((f) => f.keys.length === 0);
    if (stuck) return setMessage(`${keyLabel(key)} is ${label(stuck.id)}'s only key (unused in this game); reset Controls or pick another key.`);
    void session
      .applyBatch([...freed.map((f) => ({ name: "setControlKeys", input: { action: f.id, keys: f.keys } })), { name: "setControlKeys", input: { action, keys: bound.keys } }])
      .then((result) =>
        setMessage(result.ok ? `${label(action)}: ${bound.keys.map(keyLabel).join(" / ")} (taken from ${freed.map((f) => label(f.id)).join(", ")}, unused in this game)` : result.error.message),
      );
  };
  // A captured right click's own context menu comes after the press (the spot is gone by then).
  const menuUntil = useRef(0);

  useEffect(() => {
    if (!listening) return;
    // Capture phase: the key is for this page, not for undo, popovers or a focused button.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.key === "Escape") return (setListening(null), setMessage(""));
      capture(keyFromBrowserCode(e.code), e.key);
    };
    const swallowUp = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", swallowUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // Let the captured key's keyup pass first, so it doesn't press the focused button.
      setTimeout(() => window.removeEventListener("keyup", swallowUp, true), 300);
    };
  }, [listening, bindings]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = CONTROL_ACTIONS.some((a) => !same(bindings[a.id], DEFAULT_BINDINGS[a.id]));
  return (
    <div
      className="controls-settings"
      data-testid="controls-settings"
      onContextMenu={(e) => {
        if (Date.now() < menuUntil.current) e.preventDefault();
      }}
    >
      <p className="hint">
        The game's keys, in playtests and exported games (players can change them there: ? ▸ Change keys). Change, then press a key, or click “click here” with a mouse button;
        Escape cancels.
      </p>
      <ul className="controls-list" aria-label="Game controls">
        {actions.map((a) => {
          const waiting = listening?.action === a.id;
          const keys = bindings[a.id];
          return (
            <li key={a.id} className={`controls-row${waiting ? " listening" : ""}`} data-testid={`control-${a.id}`} title={a.description}>
              <span className="controls-label">{a.label}</span>
              <span className="controls-keys" aria-live="polite">
                {waiting ? (
                  // The spot appears only once Change was clicked, so the click that started waiting is never bound.
                  <span
                    className="controls-capture"
                    data-testid="controls-capture"
                    title="Press a key, or click here with the mouse button you want"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      menuUntil.current = Date.now() + 1000;
                      capture(keyFromBrowserButton(e.button), "That mouse button");
                    }}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    press a key or click here…
                  </span>
                ) : (
                  keys.map((k) => (
                      <span key={k} className="controls-key">
                        <kbd>{keyLabel(k)}</kbd>
                        {keys.length > 1 && (
                          <button type="button" className="controls-remove" disabled={locked} aria-label={`Remove ${keyLabel(k)} from ${a.label}`} onClick={() => setKeys(a.id, keys.filter((x) => x !== k))}>
                            ×
                          </button>
                        )}
                      </span>
                    ))
                )}
              </span>
              <button type="button" disabled={locked} aria-label={`Change ${a.label}`} onClick={() => (setListening({ action: a.id, mode: "replace" }), setMessage(`Press a key for ${a.label}…`))}>
                Change
              </button>
              <button type="button" disabled={locked} aria-label={`Add a key to ${a.label}`} onClick={() => (setListening({ action: a.id, mode: "add" }), setMessage(`Press a key to add to ${a.label}…`))}>
                + Key
              </button>
              <button
                type="button"
                disabled={locked || same(keys, DEFAULT_BINDINGS[a.id])}
                aria-label={`Reset ${a.label}`}
                title={`Back to ${DEFAULT_BINDINGS[a.id].map(keyLabel).join(" / ")}`}
                onClick={() => void edit("resetControls", { action: a.id }, `${a.label}: back to its default keys`)}
              >
                Reset
              </button>
            </li>
          );
        })}
      </ul>
      <fieldset className="controls-aim" disabled={locked} data-testid="controls-aim">
        <legend>Aim</legend>
        {AIM_MODES.map(([mode, text, done]) => (
          <label key={mode}>
            <input type="radio" name="controls-aim" checked={project.controls.aim === mode} onChange={() => void edit("setAimMode", { aim: mode }, done)} />
            {text}
          </label>
        ))}
      </fieldset>
      <p className="controls-message" role="status" data-testid="controls-message">
        {message}
      </p>
      <button type="button" disabled={locked || !changed} onClick={() => void edit("resetControls", {}, "Every action is back on its default keys")}>
        Reset all to defaults
      </button>
      <h4>Studio shortcuts</h4>
      <dl className="controls-shortcuts">
        {STUDIO_SHORTCUTS.map(([keys, does]) => (
          <div key={keys}>
            <dt>{keys}</dt>
            <dd>{does}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const label = (id: string) => CONTROL_ACTIONS.find((a) => a.id === id)?.label ?? id;
