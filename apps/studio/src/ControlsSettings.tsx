import { useEffect, useState } from "react";
import { bindKey, CONTROL_ACTIONS, DEFAULT_BINDINGS, keyFromBrowserCode, keyLabel, type ControlActionId, type KeyName, type ProjectSpec } from "@anomaly/core";
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

/**
 * Game tab: the game's keys per action (project.controls; setControlKeys / resetControls, undoable).
 * Change (or + Key), then press a key; a key another action already uses is refused here with why.
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

  useEffect(() => {
    if (!listening) return;
    // Capture phase: the key is for this page, not for undo, popovers or a focused button.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const { action, mode } = listening;
      setListening(null);
      if (e.key === "Escape") return setMessage("");
      const key = keyFromBrowserCode(e.code);
      if (!key) return setMessage(`${e.key} can't be bound; pick another key.`);
      const bound = bindKey(bindings, action, key, mode);
      if (!bound.ok) return setMessage(bound.message);
      if (!same(bound.keys, bindings[action])) setKeys(action, bound.keys);
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
    <div className="controls-settings" data-testid="controls-settings">
      <p className="hint">The game's keys, in playtests and exported games (players can change them there: ? ▸ Change keys). Change, then press a key; Escape cancels.</p>
      <ul className="controls-list" aria-label="Game controls">
        {CONTROL_ACTIONS.map((a) => {
          const waiting = listening?.action === a.id;
          const keys = bindings[a.id];
          return (
            <li key={a.id} className={`controls-row${waiting ? " listening" : ""}`} data-testid={`control-${a.id}`} title={a.description}>
              <span className="controls-label">{a.label}</span>
              <span className="controls-keys" aria-live="polite">
                {waiting
                  ? "press a key…"
                  : keys.map((k) => (
                      <span key={k} className="controls-key">
                        <kbd>{keyLabel(k)}</kbd>
                        {keys.length > 1 && (
                          <button type="button" className="controls-remove" disabled={locked} aria-label={`Remove ${keyLabel(k)} from ${a.label}`} onClick={() => setKeys(a.id, keys.filter((x) => x !== k))}>
                            ×
                          </button>
                        )}
                      </span>
                    ))}
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
