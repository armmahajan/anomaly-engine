import { Fragment, useRef, useState, type KeyboardEvent } from "react";
import {
  MOVEMENT_ABILITIES,
  primitiveParams,
  renderHelp,
  type ChangeResult,
  type Character,
  type Condition,
  type EnemyCharacter,
  type MovementAbility,
  type Playtest,
  type PlayerCharacter,
  type RoomSpawn,
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
  maxFallSpeed: { label: "Max fall speed", unit: "px/s" },
  coyoteTime: { label: "Coyote time", unit: "s" },
  jumpBuffer: { label: "Jump buffer", unit: "s" },
  duration: { label: "Duration", unit: "s" },
  cooldown: { label: "Cooldown", unit: "s" },
  jumps: { label: "Mid-air jumps", unit: "" },
  velocity: { label: "Velocity", unit: "px/s" },
  slideSpeed: { label: "Slide speed", unit: "px/s" },
  kickSpeed: { label: "Kick speed", unit: "px/s" },
  kickTime: { label: "Kick time", unit: "s" },
  fallSpeed: { label: "Fall speed", unit: "px/s" },
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
  armor: { label: "Armor", unit: "0–1" },
  windup: { label: "Warning", unit: "s" },
  active: { label: "Active", unit: "s" },
  recovery: { label: "Recovery", unit: "s" },
  damage: { label: "Damage", unit: "HP" },
  width: { label: "Width", unit: "px" },
  offsetX: { label: "Ahead", unit: "px" },
  lunge: { label: "Lunge", unit: "px/s" },
  count: { label: "Count", unit: "" },
  spread: { label: "Spread", unit: "°" },
  gravity: { label: "Gravity", unit: "px/s²" },
  aim: { label: "Aim", unit: "" },
  angle: { label: "Angle", unit: "°" },
  lifetime: { label: "Lifetime", unit: "s" },
  pogo: { label: "Pogo-able", unit: "" },
  maxDistance: { label: "Max distance", unit: "px" },
  waveSpeed: { label: "Wave speed", unit: "px/s" },
  waveReach: { label: "Wave reach", unit: "px" },
  waveHeight: { label: "Wave height", unit: "px" },
  character: { label: "Summons", unit: "" },
  max: { label: "Max alive", unit: "" },
  to: { label: "To", unit: "" },
  range: { label: "Range", unit: "px" },
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
  /** The playtest room (null when the game has none). */
  roomId: string | null;
  /** This character's spawns in the playtest room. */
  spawns: RoomSpawn[];
  /** Where new spawns go (null without a playtest room). */
  defaultSpawn: { x: number; y: number } | null;
  session: Session;
  locked: boolean;
  lockHint?: string;
  /** This character's wiki page, if it has one. */
  wikiPageId?: string;
  onOpenWiki?: (pageId: string) => void;
  playtest: Playtest | null;
}

export function Inspector({ character, roomId, spawns, defaultSpawn, session, locked, lockHint, wikiPageId, onOpenWiki, playtest }: Props) {
  return (
    <section className="inspector">
      <h2 className="inspector-title">
        <NameField
          key={`${character.id}:${character.name}`}
          name={character.name}
          disabled={locked}
          onCommit={(name) => session.updateCharacter({ characterId: character.id, changes: { name } })}
        />
        {wikiPageId && onOpenWiki && (
          <button type="button" className="wiki-link" onClick={() => onOpenWiki(wikiPageId)}>
            Wiki page →
          </button>
        )}
      </h2>
      {locked && lockHint && <p className="hint">{lockHint}</p>}
      <div className="inspector-blocks">
        <div className="inspector-block">
          <h3>Stats</h3>
          {Object.entries(character.kind === "enemy" ? { ...character.stats, armor: character.stats.armor ?? 0 } : character.stats).map(([stat, value]) => (
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
        </div>
        {character.kind === "player" && playtest && (
          <div className="inspector-block">
            <AbilityPanel player={character} inArena={playtest.abilities} session={session} locked={locked} />
          </div>
        )}
        <div className="inspector-block">
          {character.kind === "player" ? (
            playtest && <PlaytestSpot playtest={playtest} session={session} locked={locked} />
          ) : (
            <SpawnList character={character} roomId={roomId} spawns={spawns} defaultSpawn={defaultSpawn} session={session} locked={locked} />
          )}
        </div>
        {character.kind === "enemy" && (
          <div className="inspector-block inspector-behavior">
            <BehaviorEditor character={character} session={session} locked={locked} />
          </div>
        )}
      </div>
    </section>
  );
}

const ABILITY_LABEL: Record<MovementAbility, string> = {
  dash: "Dash",
  double_jump: "Double jump",
  wall_jump: "Wall jump",
  glide: "Glide",
  ground_pound: "Ground pound",
};
const TUNING_KEY = { dash: "dash", double_jump: "doubleJump", wall_jump: "wallJump", glide: "glide", ground_pound: "groundPound" } as const;

/** Which abilities the player has in playtests, and each one's tuning. */
function AbilityPanel({ player, inArena, session, locked }: { player: PlayerCharacter; inArena: MovementAbility[]; session: Session; locked: boolean }) {
  const toggle = (ability: MovementAbility, on: boolean) =>
    session.applyOperation("setPlaytest", { abilities: on ? [...inArena, ability] : inArena.filter((a) => a !== ability) });
  return (
    <>
      <h3>Abilities</h3>
      <p className="hint">
        Checked abilities are on in playtests. Controls (Game ▸ Controls):{" "}
        {renderHelp("move {move_left} / {move_right}, jump {jump}, attack {attack}, dash {dash}, {aim_down} + jump in the air to ground pound.", session.getProject().controls.bindings)}
      </p>
      {(Object.keys(MOVEMENT_ABILITIES) as MovementAbility[]).map((ability) => {
        const key = TUNING_KEY[ability];
        return (
          <div key={ability} className="ability">
            <label className="field field-check" title={MOVEMENT_ABILITIES[ability]}>
              <input
                type="checkbox"
                checked={inArena.includes(ability)}
                disabled={locked}
                onChange={(e) => void toggle(ability, e.target.checked)}
              />
              {ABILITY_LABEL[ability]}
            </label>
            {inArena.includes(ability) &&
              Object.entries(player.abilities[key]).map(([field, value]) => (
                <NumberField
                  key={`${field}:${value}`}
                  id={`ability-${ability}-${field}`}
                  label={`${meta(field).label}`}
                  ariaLabel={`${ABILITY_LABEL[ability]} ${meta(field).label.toLowerCase()}`}
                  unit={meta(field).unit}
                  value={value}
                  disabled={locked}
                  onCommit={(v) => session.updateCharacter({ characterId: player.id, changes: { abilities: { [key]: { [field]: v } } } })}
                />
              ))}
          </div>
        );
      })}
    </>
  );
}

/** Where ▶ Play puts the player in the playtest room. */
function PlaytestSpot({ playtest, session, locked }: { playtest: Playtest; session: Session; locked: boolean }) {
  return (
    <>
      <h3>Playtest start</h3>
      <div className="spawn" data-testid="playtest-spot">
        <span className="spawn-id">{playtest.room}</span>
        {(["x", "y"] as const).map((axis) => (
          <NumberField
            key={`${axis}:${playtest[axis]}`}
            id={`playtest-${axis}`}
            ariaLabel={`playtest ${axis}`}
            unit={axis}
            value={playtest[axis]}
            disabled={locked}
            compact
            onCommit={(v) => session.applyOperation("setPlaytest", { [axis]: v })}
          />
        ))}
      </div>
    </>
  );
}

function SpawnList({
  character,
  roomId,
  spawns,
  defaultSpawn,
  session,
  locked,
}: Pick<Props, "character" | "roomId" | "spawns" | "defaultSpawn" | "session" | "locked">) {
  const report = (result: ChangeResult) => {
    if (!result.ok) session.reportProblem(result.error.message);
    return result;
  };
  if (!roomId || !defaultSpawn) return <p className="hint">Set a playtest room to place it.</p>;
  return (
    <>
      <h3>In the playtest room</h3>
      {spawns.length === 0 && <p className="hint">Not placed here. Add it to test it.</p>}
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
              onCommit={(v) => session.applyOperation("moveRoomSpawn", { roomId, spawnId: spawn.id, [axis]: v })}
            />
          ))}
          <button
            type="button"
            className="icon-button"
            aria-label={`remove ${spawn.id}`}
            disabled={locked}
            onClick={async () => report(await session.applyOperation("removeRoomSpawn", { roomId, spawnId: spawn.id }))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={locked}
        onClick={async () => report(await session.applyOperation("addRoomSpawn", { roomId, characterId: character.id, ...defaultSpawn }))}
      >
        + Add to room
      </button>
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
    case "text":
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          <input
            id={id}
            key={String(value ?? "")}
            aria-label={ariaLabel}
            className="art-text"
            defaultValue={String(value ?? "")}
            disabled={locked}
            onBlur={(e) => e.currentTarget.value !== value && void onCommit(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
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

/** The character's name, editable in place: Enter or leaving the field saves it (one undo step), Escape reverts. */
function NameField({ name, disabled, onCommit }: { name: string; disabled: boolean; onCommit: (name: string) => Promise<ChangeResult> }) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const commit = async () => {
    const next = draft.trim();
    if (pending.current || next === name) return;
    if (!next) {
      setDraft(name);
      return;
    }
    pending.current = true;
    const result = await onCommit(next);
    pending.current = false;
    if (!result.ok) setError(result.error.issues[0]?.message ?? result.error.message);
  };
  return (
    <span className="name-field">
      <input
        className="name-input"
        aria-label="Character name"
        value={draft}
        disabled={disabled}
        maxLength={80}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(name);
            setError(null);
          }
        }}
      />
      {error && <span className="field-error">{error}</span>}
    </span>
  );
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
