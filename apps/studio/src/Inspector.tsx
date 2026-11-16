import { Fragment, useRef, useState, type KeyboardEvent } from "react";
import {
  primitiveParams,
  type ChangeResult,
  type Character,
  type Condition,
  type EnemyCharacter,
  type Spawn,
  type Transition,
} from "@anomaly/core";
import type { Session } from "./session.ts";

const PARAM_META: Record<string, { label: string; unit: string }> = {
  runSpeed: { label: "Run speed", unit: "px/s" },
  jumpVelocity: { label: "Jump velocity", unit: "px/s" },
  knockback: { label: "Knockback", unit: "px/s" },
  health: { label: "Health", unit: "HP" },
  contactDamage: { label: "Contact damage", unit: "HP" },
  attackDamage: { label: "Attack damage", unit: "HP" },
  attackReach: { label: "Attack reach", unit: "px" },
  attackCooldown: { label: "Attack cooldown", unit: "s" },
  pogoVelocity: { label: "Pogo bounce", unit: "px/s" },
  fraction: { label: "Fraction", unit: "0–1" },
  speed: { label: "Speed", unit: "px/s" },
  distance: { label: "Distance", unit: "px" },
  seconds: { label: "Seconds", unit: "s" },
  stopDistance: { label: "Stop distance", unit: "px" },
  height: { label: "Height", unit: "px" },
  amplitude: { label: "Amplitude", unit: "px" },
  period: { label: "Period", unit: "s" },
  margin: { label: "Margin", unit: "px" },
  p: { label: "Chance", unit: "0–1" },
  turnAtLedge: { label: "Turn at ledges", unit: "" },
  turnAtWall: { label: "Turn at walls", unit: "" },
  shake: { label: "Shake", unit: "" },
  direction: { label: "Direction", unit: "" },
  toward: { label: "Toward", unit: "" },
};

const CONDITION_TEXT: Record<Condition["type"], string> = {
  playerWithin: "when player within",
  playerBeyond: "when player beyond",
  after: "after",
  hitWall: "on hitting a wall",
  actionDone: "when the action is done",
  atLedge: "at a ledge",
  onGround: "on the ground",
  airborne: "in the air",
  playerAbove: "when player above by",
  playerBelow: "when player below by",
  playerLevel: "when player level within",
  playerInFront: "when player in front",
  playerBehind: "when player behind",
  canSeePlayer: "when it can see the player",
  wasHit: "when hit",
  healthBelow: "when health below",
  chance: "with chance",
};

const meta = (key: string) => PARAM_META[key] ?? { label: key, unit: "" };


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
  const edit = (change: object) => session.applyOperation("updateBehavior", { characterId: character.id, ...change });

  return (
    <>
      <h3>Behavior</h3>
      <div className="field">
        <label htmlFor={`${character.id}-movement`}>Movement</label>
        <select
          id={`${character.id}-movement`}
          value={character.movement}
          disabled={locked}
          onChange={(e) => void session.updateCharacter({ characterId: character.id, changes: { movement: e.target.value } })}
        >
          <option value="ground">ground</option>
          <option value="flying">flying</option>
        </select>
      </div>
      {behavior.interrupts.length > 0 && (
        <div className="state" data-testid="interrupts">
          <div className="state-header">
            <span className="state-name">any state</span>
          </div>
          {behavior.interrupts.map((t, index) => (
            <TransitionRow
              key={index}
              transition={t}
              idPrefix={`${character.id}-i${index}`}
              ariaPrefix={`any state to ${t.to}`}
              locked={locked}
              onCommit={(change) => edit({ interrupts: [{ index, ...change }] })}
            />
          ))}
        </div>
      )}
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
          {primitiveParams("action", state.action.type).map((param) => (
            <ParamField
              key={`${param.name}:${String((state.action as Record<string, unknown>)[param.name])}`}
              id={`${character.id}-${stateId}-${param.name}`}
              ariaLabel={`${stateId} ${param.name}`}
              param={param}
              value={(state.action as Record<string, unknown>)[param.name]}
              locked={locked}
              onCommit={(v) => edit({ stateId, action: { [param.name]: v } })}
            />
          ))}
          {state.transitions.map((t, index) => (
            <TransitionRow
              key={index}
              transition={t}
              idPrefix={`${character.id}-${stateId}-t${index}`}
              ariaPrefix={`${stateId} to ${t.to}`}
              locked={locked}
              onCommit={(change) => edit({ stateId, transitions: [{ index, ...change }] })}
            />
          ))}
        </div>
      ))}
    </>
  );
}

interface TransitionRowProps {
  transition: Transition;
  idPrefix: string;
  ariaPrefix: string;
  locked: boolean;
  /** A partial transition edit: `when` params, or `and` edits by position. */
  onCommit: (change: { when?: object; and?: object[] }) => Promise<ChangeResult>;
}

function TransitionRow({ transition, idPrefix, ariaPrefix, locked, onCommit }: TransitionRowProps) {
  const conditions = [transition.when, ...(transition.and ?? [])] as (Record<string, unknown> & Condition)[];
  const commit = (position: number, param: string, v: number) =>
    onCommit(
      position === 0
        ? { when: { [param]: v } }
        : { and: Array.from({ length: position }, (_, i) => (i === position - 1 ? { [param]: v } : {})) },
    );
  return (
    <div className="transition">
      <span className="arrow">→ {transition.to}</span>
      {conditions.map((condition, position) => (
        <Fragment key={position}>
          <span className="condition">
            {position === 0 ? CONDITION_TEXT[condition.type] : `and ${CONDITION_TEXT[condition.type].replace(/^when /, "")}`}
          </span>
          {primitiveParams("condition", condition.type).map(({ name }) => (
            <NumberField
              key={`${name}:${String(condition[name])}`}
              id={`${idPrefix}-${position}-${name}`}
              ariaLabel={position === 0 ? `${ariaPrefix} ${name}` : `${ariaPrefix} ${condition.type} ${name}`}
              unit={meta(name).unit}
              value={condition[name] as number}
              disabled={locked}
              compact
              onCommit={(v) => commit(position, name, v)}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

interface ParamFieldProps {
  id: string;
  ariaLabel: string;
  param: ReturnType<typeof primitiveParams>[number];
  value: unknown;
  locked: boolean;
  onCommit: (value: unknown) => Promise<ChangeResult>;
}

function ParamField({ id, ariaLabel, param, value, locked, onCommit }: ParamFieldProps) {
  const { label, unit } = meta(param.name);
  switch (param.kind) {
    case "number":
      return (
        <NumberField id={id} label={label} ariaLabel={ariaLabel} unit={unit} value={value as number} disabled={locked} onCommit={onCommit} />
      );
    case "boolean":
      return <CheckField label={label} ariaLabel={ariaLabel} value={value === true} locked={locked} onCommit={onCommit} />;
    case "enum":
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          <select id={id} aria-label={ariaLabel} value={String(value)} disabled={locked} onChange={(e) => void onCommit(e.target.value)}>
            {param.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return null;
  }
}

function CheckField(props: { label: string; ariaLabel: string; value: boolean; locked: boolean; onCommit: (v: boolean) => Promise<ChangeResult> }) {
  const [checked, setChecked] = useState(props.value);
  const toggle = async (next: boolean) => {
    setChecked(next);
    if (!(await props.onCommit(next)).ok) setChecked(!next);
  };
  return (
    <label className="field field-check">
      <input type="checkbox" aria-label={props.ariaLabel} checked={checked} disabled={props.locked} onChange={(e) => void toggle(e.target.checked)} />
      {props.label}
    </label>
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
