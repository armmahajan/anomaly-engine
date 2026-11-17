import { z } from "zod";
import {
  Effect,
  GameCondition,
  GameEvent,
  MOVEMENT_ABILITIES,
  PROP_EVENTS,
  type GameEventType,
  type Handler,
  type ProjectSpec,
  type WorldRoom,
} from "@anomaly/core";

/**
 * Edits a list of handlers ({on, when, do}) for the world, a room, a prop or
 * an enemy spawn. The forms come from the core schemas (events/events.ts),
 * so new events, conditions and effects show up here without changes; fields
 * that name things (item, modal, room, spawn, character, ability) are menus
 * of what exists. Every change hands the whole new list to `onChange`.
 */

export type HandlerScope = "world" | "room" | "prop" | "spawn";

interface Props {
  handlers: Handler[];
  onChange: (handlers: Handler[]) => void;
  scope: HandlerScope;
  project: ProjectSpec;
  /** The room the handlers belong to (not for world handlers). */
  room?: WorldRoom | null;
  locked: boolean;
  /** Label prefix for accessible names, e.g. "gate". */
  label?: string;
}

type Shape = Record<string, z.ZodType>;
type Option = { type: string; shape: Shape; description: string };

const optionsOf = (union: z.ZodType): Option[] => {
  const resolved = union instanceof z.ZodLazy ? (union.def.getter() as z.ZodType) : union;
  return (resolved as z.ZodDiscriminatedUnion<z.ZodObject[]>).options.map((o) => ({
    type: (o.shape.type as z.ZodLiteral<string>).value,
    shape: o.shape as Shape,
    description: o.description ?? "",
  }));
};

const EVENTS = optionsOf(GameEvent);
const CONDITIONS = optionsOf(GameCondition);
const EFFECTS = optionsOf(Effect);

/** Events a handler in this scope can hear. */
function eventsFor(scope: HandlerScope): Option[] {
  if (scope === "prop") return EVENTS;
  if (scope === "spawn") return EVENTS.filter((e) => e.type === "enemyKilled");
  return EVENTS.filter((e) => !PROP_EVENTS.includes(e.type as GameEventType));
}

/** Fields the scope pins (a room's handlers are about that room, a spawn's about that spawn). */
const pinned = (scope: HandlerScope) => (scope === "world" ? [] : scope === "spawn" ? ["room", "spawn", "character"] : ["room"]);

function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let inner = schema;
  let optional = false;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) {
    optional = true;
    inner = inner.def.innerType as z.ZodType;
  }
  return { inner, optional };
}

/** A fresh value of one option: its type plus placeholders for required fields (the operation validates). */
function blank(option: Option, project: ProjectSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { type: option.type };
  for (const [key, field] of Object.entries(option.shape)) {
    if (key === "type") continue;
    const { inner, optional } = unwrap(field);
    if (optional) continue;
    const choices = refChoices(key, project, null);
    if (choices) out[key] = choices[0] ?? "";
    else if (inner instanceof z.ZodNumber) out[key] = 1;
    else if (inner instanceof z.ZodBoolean) out[key] = true;
    else if (inner instanceof z.ZodEnum) out[key] = inner.options[0];
    else if (key === "of") out[key] = option.type === "not" ? { type: "flag", flag: "flag_name", is: true } : [{ type: "flag", flag: "flag_name", is: true }];
    else out[key] = key === "flag" ? "flag_name" : key === "timer" ? "timer_name" : "";
  }
  return out;
}

/** Menus for fields that name things in the project. */
function refChoices(key: string, project: ProjectSpec, room: WorldRoom | null | undefined): string[] | null {
  switch (key) {
    case "item":
      return project.world.items.map((i) => i.id);
    case "modal":
      return project.world.modals.map((m) => m.id);
    case "room":
      return project.world.rooms.map((r) => r.id);
    case "spawn":
      return (room?.spawns ?? []).map((s) => s.id);
    case "character":
      return project.characters.filter((c) => c.kind === "enemy").map((c) => c.id);
    case "ability":
      return Object.keys(MOVEMENT_ABILITIES);
    default:
      return null;
  }
}

export function HandlerEditor({ handlers, onChange, scope, project, room, locked, label = scope }: Props) {
  const set = (i: number, h: Handler) => onChange(handlers.map((x, j) => (j === i ? h : x)));
  const events = eventsFor(scope);
  return (
    <div className="handlers" data-testid={`handlers-${label}`}>
      {handlers.length === 0 && <p className="hint">No handlers.</p>}
      {handlers.map((h, i) => (
        <div className="handler" key={i} data-testid={`handler-${label}-${i}`}>
          <div className="handler-row">
            <strong>on</strong>
            <Fields
              value={h.on}
              options={events}
              hide={pinned(scope)}
              project={project}
              room={room}
              locked={locked}
              label={`${label} ${i} event`}
              onChange={(on) => set(i, { ...h, on: on as Handler["on"] })}
            />
            <button type="button" className="icon-button" aria-label={`remove ${label} handler ${i}`} disabled={locked} onClick={() => onChange(handlers.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
          <List
            title="when"
            items={h.when}
            options={CONDITIONS}
            project={project}
            room={room}
            locked={locked}
            label={`${label} ${i} condition`}
            onChange={(when) => set(i, { ...h, when: when as Handler["when"] })}
          />
          <List
            title="do"
            items={h.do}
            options={EFFECTS}
            project={project}
            room={room}
            locked={locked}
            label={`${label} ${i} effect`}
            onChange={(effects) => set(i, { ...h, do: effects as Handler["do"] })}
          />
        </div>
      ))}
      <button
        type="button"
        disabled={locked}
        onClick={() => onChange([...handlers, { on: blank(events[0]!, project), when: [], do: [blank(EFFECTS[0]!, project)] } as unknown as Handler])}
      >
        + Handler
      </button>
    </div>
  );
}

interface ListProps {
  title: string;
  items: object[];
  options: Option[];
  project: ProjectSpec;
  room?: WorldRoom | null;
  locked: boolean;
  label: string;
  onChange: (items: object[]) => void;
}

function List({ title, items, options, project, room, locked, label, onChange }: ListProps) {
  return (
    <div className="handler-list">
      <span className="muted">{title}</span>
      {items.map((item, i) => (
        <div className="handler-row" key={i}>
          <Fields value={item} options={options} project={project} room={room} locked={locked} label={`${label} ${i}`} onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))} />
          <button type="button" className="icon-button" aria-label={`remove ${label} ${i}`} disabled={locked} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="link-button" disabled={locked} aria-label={`add ${label}`} onClick={() => onChange([...items, blank(options[0]!, project)])}>
        + {title === "when" ? "condition" : "effect"}
      </button>
    </div>
  );
}

interface FieldsProps {
  value: object;
  options: Option[];
  hide?: string[];
  project: ProjectSpec;
  room?: WorldRoom | null;
  locked: boolean;
  label: string;
  onChange: (value: object) => void;
}

/** A type menu and one input per parameter of the chosen type. */
function Fields({ value, options, hide = [], project, room, locked, label, onChange }: FieldsProps) {
  const current = value as Record<string, unknown> & { type: string };
  const option = options.find((o) => o.type === current.type) ?? options[0]!;
  const setField = (key: string, v: unknown) => {
    const next = { ...current };
    if (v === undefined || v === "") delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <>
      <select aria-label={label} title={option.description} value={current.type} disabled={locked} onChange={(e) => onChange(blank(options.find((o) => o.type === e.target.value)!, project))}>
        {options.map((o) => (
          <option key={o.type} value={o.type} title={o.description}>
            {o.type}
          </option>
        ))}
      </select>
      {Object.entries(option.shape)
        .filter(([key]) => key !== "type" && !hide.includes(key))
        .map(([key, field]) => {
          const { inner, optional } = unwrap(field);
          const v = current[key];
          const name = `${label} ${key}`;
          if (key === "of") {
            const nested = Array.isArray(v) ? (v as object[]) : [v as object];
            return (
              <span key={key} className="handler-nested">
                {nested.map((c, i) => (
                  <Fields
                    key={i}
                    value={c}
                    options={CONDITIONS}
                    project={project}
                    room={room}
                    locked={locked}
                    label={`${name} ${i}`}
                    onChange={(c2) => setField(key, Array.isArray(v) ? nested.map((x, j) => (j === i ? c2 : x)) : c2)}
                  />
                ))}
                {Array.isArray(v) && (
                  <button type="button" className="link-button" disabled={locked} onClick={() => setField(key, [...nested, blank(CONDITIONS[0]!, project)])}>
                    +
                  </button>
                )}
              </span>
            );
          }
          const choices = refChoices(key, project, room) ?? (inner instanceof z.ZodEnum ? (inner.options as string[]) : null);
          if (choices) {
            return (
              <select key={key} aria-label={name} title={key} value={(v as string) ?? ""} disabled={locked} onChange={(e) => setField(key, e.target.value || undefined)}>
                {(optional || !choices.includes(v as string)) && <option value="">{optional ? `(any ${key})` : `${key}?`}</option>}
                {choices.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            );
          }
          if (inner instanceof z.ZodBoolean) {
            return (
              <label key={key} className="inline-check">
                <input type="checkbox" aria-label={name} checked={(v as boolean) ?? true} disabled={locked} onChange={(e) => setField(key, e.target.checked)} />
                {key}
              </label>
            );
          }
          if (inner instanceof z.ZodNumber) {
            return (
              <CommitInput
                key={key}
                className="number-box"
                type="number"
                label={name}
                placeholder={key}
                value={v === undefined || v === null ? "" : String(v)}
                disabled={locked}
                onCommit={(text) => setField(key, text === "" ? (optional ? undefined : 0) : Number(text))}
              />
            );
          }
          if (inner instanceof z.ZodArray) return null; // lists of ids (revealMap rooms): all by default
          return (
            <CommitInput
              key={key}
              className="art-text handler-text"
              label={name}
              placeholder={key}
              value={(v as string) ?? ""}
              disabled={locked}
              onCommit={(text) => setField(key, text)}
            />
          );
        })}
    </>
  );
}

/** A text or number box that commits on Enter or leaving it (one edit, not one per keystroke). */
function CommitInput({ value, onCommit, label, ...rest }: { value: string; onCommit: (text: string) => void; label: string; className: string; type?: string; placeholder: string; disabled: boolean }) {
  return (
    <input
      key={value}
      {...rest}
      aria-label={label}
      title={rest.placeholder}
      defaultValue={value}
      onBlur={(e) => e.currentTarget.value !== value && onCommit(e.currentTarget.value)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}
