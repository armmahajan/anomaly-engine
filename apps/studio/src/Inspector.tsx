import { useRef, useState, type KeyboardEvent } from "react";
import type { ChangeResult, Character, Condition, EnemyCharacter, Spawn } from "@anomaly/core";
import type { Session } from "./session.ts";

const PARAM_META: Record<string, { label: string; unit: string }> = {
  runSpeed: { label: "Run speed", unit: "px/s" },
  jumpVelocity: { label: "Jump velocity", unit: "px/s" },
  knockback: { label: "Knockback", unit: "px/s" },
  speed: { label: "Speed", unit: "px/s" },
  distance: { label: "Distance", unit: "px" },
  seconds: { label: "Seconds", unit: "s" },
};

const CONDITION_TEXT: Record<Condition["type"], string> = {
  playerWithin: "when player within",
  playerBeyond: "when player beyond",
  after: "after",
  hitWall: "on hitting a wall",
};

const meta = (key: string) => PARAM_META[key] ?? { label: key, unit: "" };

/** Numeric params of a primitive (everything except its `type`). */
const numericParams = (primitive: Record<string, unknown>) =>
  Object.entries(primitive).filter((e): e is [string, number] => e[0] !== "type" && typeof e[1] === "number");

interface Props {
  character: Character;
  /** This character's spawns in the sandbox. */
  spawns: Spawn[];
  defaultSpawn: { x: number; y: number };
  session: Session;
  locked: boolean;
  lockHint?: string;
}

export function Inspector({ character, spawns, defaultSpawn, session, locked, lockHint }: Props) {
  return (
    <section className="inspector">
      <h2>{character.name}</h2>
      {locked && lockHint && <p className="hint">{lockHint}</p>}
      <h3>Stats</h3>
      {Object.entries(character.stats).map(([stat, value]) => (
        <NumberField
          // Remount when the committed value changes so the draft resyncs.
          key={`${stat}:${value}`}
          id={`${character.id}-stat-${stat}`}
          label={meta(stat).label}
          unit={meta(stat).unit}
          value={value}
          disabled={locked}
          onCommit={(v) => session.updateCharacter({ characterId: character.id, changes: { stats: { [stat]: v } } })}
        />
      ))}
      <SpawnList character={character} spawns={spawns} defaultSpawn={defaultSpawn} session={session} locked={locked} />
      {character.kind === "enemy" && <BehaviorEditor character={character} session={session} locked={locked} />}
    </section>
  );
}

function SpawnList({ character, spawns, defaultSpawn, session, locked }: Omit<Props, "spawns"> & { spawns: Spawn[] }) {
  const report = (result: ChangeResult) => {
    if (!result.ok) session.reportProblem(result.error.message);
    return result;
  };
  return (
    <>
      <h3>In the arena</h3>
      {spawns.length === 0 && <p className="hint">Not placed. Add it to the arena to test it.</p>}
      {spawns.map((spawn) => (
        <div className="spawn" key={spawn.id} data-testid={`spawn-${spawn.id}`}>
          <span className="spawn-id" title={spawn.id}>
            {spawn.id}
          </span>
          {(["x", "y"] as const).map((axis) => (
            <NumberField
              key={`${axis}:${spawn[axis]}`}
              id={`spawn-${spawn.id}-${axis}`}
              ariaLabel={`${spawn.id} ${axis}`}
              unit={axis}
              value={spawn[axis]}
              disabled={locked}
              compact
              onCommit={(v) => session.applyOperation("moveSpawn", { spawnId: spawn.id, [axis]: v })}
            />
          ))}
          {character.kind !== "player" && (
            <button
              type="button"
              className="icon-button"
              aria-label={`remove ${spawn.id}`}
              disabled={locked}
              onClick={async () => report(await session.applyOperation("removeSpawn", { spawnId: spawn.id }))}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {character.kind !== "player" && (
        <button
          type="button"
          disabled={locked}
          onClick={async () =>
            report(await session.applyOperation("addSpawn", { characterId: character.id, ...defaultSpawn }))
          }
        >
          + Add to arena
        </button>
      )}
    </>
  );
}

function BehaviorEditor({ character, session, locked }: { character: EnemyCharacter; session: Session; locked: boolean }) {
  const { behavior } = character;
  const update = (stateId: string, change: object) =>
    session.applyOperation("updateBehavior", { characterId: character.id, stateId, ...change });

  return (
    <>
      <h3>Behavior</h3>
      {Object.entries(behavior.states).map(([stateId, state]) => (
        <div className="state" key={stateId} data-testid={`state-${stateId}`}>
          <div className="state-header">
            <span className="state-name">{stateId}</span>
            {stateId === behavior.initial && <span className="tag">start</span>}
            <span className="action-type">
              {state.action.type}
              {state.action.type === "telegraph" && (
                <span className="swatch" style={{ background: state.action.color }} title={state.action.color} />
              )}
            </span>
          </div>
          {numericParams(state.action).map(([param, value]) => (
            <NumberField
              key={`${param}:${value}`}
              id={`${character.id}-${stateId}-${param}`}
              label={meta(param).label}
              ariaLabel={`${stateId} ${param}`}
              unit={meta(param).unit}
              value={value}
              disabled={locked}
              onCommit={(v) => update(stateId, { action: { [param]: v } })}
            />
          ))}
          {state.transitions.map((t, index) => (
            <div className="transition" key={index}>
              <span className="arrow">→ {t.to}</span>
              <span className="condition">{CONDITION_TEXT[t.when.type]}</span>
              {numericParams(t.when).map(([param, value]) => (
                <NumberField
                  key={`${param}:${value}`}
                  id={`${character.id}-${stateId}-t${index}-${param}`}
                  ariaLabel={`${stateId} to ${t.to} ${param}`}
                  unit={meta(param).unit}
                  value={value}
                  disabled={locked}
                  compact
                  onCommit={(v) => update(stateId, { transitions: [{ index, when: { [param]: v } }] })}
                />
              ))}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

interface FieldProps {
  id: string;
  label?: string;
  ariaLabel?: string;
  unit: string;
  value: number;
  disabled: boolean;
  compact?: boolean;
  onCommit: (value: number) => Promise<ChangeResult>;
}

function NumberField({ id, label, ariaLabel, unit, value, disabled, compact, onCommit }: FieldProps) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false); // Enter then blur must not submit twice

  const commit = async () => {
    if (pending.current) return;
    if (draft === String(value)) {
      setError(null);
      return;
    }
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setError("Enter a number");
      return;
    }
    pending.current = true;
    const result = await onCommit(parsed);
    pending.current = false;
    if (!result.ok) setError(result.error.issues[0]?.message ?? result.error.message);
    // On success the parent re-renders with a new key and this field remounts.
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void commit();
    if (e.key === "Escape") {
      setDraft(String(value));
      setError(null);
    }
  };

  return (
    <div className={compact ? "field field-compact" : "field"}>
      {label && <label htmlFor={id}>{label}</label>}
      <div className="field-input">
        <input
          id={id}
          inputMode="decimal"
          value={draft}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={error !== null}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
        />
        <span className="unit">{unit}</span>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
