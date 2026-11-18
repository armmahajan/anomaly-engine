import { CONTROL_ACTIONS, keysText, MAX_LOADOUT_SLOTS, uniqueId, WEAPON_ACTIONS, type ControlActionId, type LoadoutSlot, type ProjectSpec } from "@anomaly/core";
import type { Session } from "../session.ts";
import { Pick, Text } from "./fields.tsx";
import "./weapons.css";

const actionLabel = (id: ControlActionId) => CONTROL_ACTIONS.find((a) => a.id === id)?.label ?? id;

/**
 * Game tab: the player's loadout (setLoadout). Up to three slots, each on a control action with
 * the weapon it starts with, and whether the player can cycle weapons. It is project data, so the
 * next playtest uses it.
 */
export function LoadoutPanel({ project, session, locked }: { project: ProjectSpec; session: Session; locked: boolean }) {
  const { loadout, list } = project.weapons;
  const { slots } = loadout;
  const keys = (action: ControlActionId) => keysText(project.controls.bindings[action] ?? []);

  const save = async (input: { slots?: LoadoutSlot[]; cycle?: boolean }) => {
    const result = await session.applyOperation("setLoadout", input);
    if (!result.ok) session.reportProblem(result.error.message);
  };
  const setSlot = (i: number, slot: LoadoutSlot) => void save({ slots: slots.map((s, j) => (j === i ? slot : s)) });

  const free = WEAPON_ACTIONS.filter((a) => !slots.some((s) => s.action === a));
  const addSlot = () => {
    const action = free[0];
    if (!action) return;
    const label = action === "attack" ? "Main" : action === "alt_attack" ? "Alt" : "Special";
    void save({ slots: [...slots, { id: uniqueId(label.toLowerCase(), slots.map((s) => s.id)), label, action, start: null }] });
  };

  return (
    <div className="loadout-panel" data-testid="loadout-panel">
      <p className="hint">The player's weapons at the start of a run, each used with its slot's key. An empty Attack slot uses the built-in attack (the player's stats). Playtests use this loadout.</p>
      <ul className="loadout-slots" aria-label="Loadout slots">
        {slots.map((slot, i) => (
          <li key={slot.id} className="loadout-slot" data-testid={`slot-${slot.id}`}>
            <Text label={`${slot.id} label`} value={slot.label} required maxLength={40} disabled={locked} onCommit={(label) => setSlot(i, { ...slot, label })} />
            <Pick
              label={`${slot.id} action`}
              value={slot.action}
              options={WEAPON_ACTIONS.map((a) => ({ id: a, label: `${actionLabel(a)} (${keys(a)})`, disabled: a !== slot.action && slots.some((s) => s.action === a) }))}
              disabled={locked}
              onPick={(action) => setSlot(i, { ...slot, action })}
            />
            <Pick
              label={`${slot.id} weapon`}
              value={slot.start ?? ""}
              options={[{ id: "", label: slot.action === "attack" ? "(built-in attack)" : "(empty)" }, ...list.map((w) => ({ id: w.id, label: w.name }))]}
              disabled={locked}
              onPick={(start) => setSlot(i, { ...slot, start: start || null })}
            />
            <button type="button" className="icon-button" aria-label={`remove slot ${slot.label}`} disabled={locked} onClick={() => void save({ slots: slots.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {slots.length === 0 && <p className="hint">No slots: the player attacks with the built-in attack.</p>}
      <div className="loadout-foot">
        <button type="button" className="link-button" disabled={locked || slots.length >= MAX_LOADOUT_SLOTS || free.length === 0} onClick={addSlot}>
          + Slot
        </button>
        <label className="field-check" title={`${actionLabel("weapon_cycle")} (${keys("weapon_cycle")}) swaps the Attack slot through the weapons the player has`}>
          <input type="checkbox" checked={loadout.cycle} disabled={locked} onChange={(e) => void save({ cycle: e.target.checked })} /> Players can switch weapons ({keys("weapon_cycle")})
        </label>
      </div>
      {list.length === 0 && <p className="hint">Make a weapon above to put it in a slot.</p>}
    </div>
  );
}

/** The loadout in a few words (the folded section's summary). */
export function loadoutSummary(project: ProjectSpec): string {
  const { slots, cycle } = project.weapons.loadout;
  if (slots.length === 0) return "built-in attack";
  const name = (id: string | null) => (id ? (project.weapons.list.find((w) => w.id === id)?.name ?? id) : "built-in");
  return slots.map((s) => `${s.label}: ${s.start ? name(s.start) : s.action === "attack" ? "built-in" : "empty"}`).join(" · ") + (cycle ? " · cycling" : "");
}
