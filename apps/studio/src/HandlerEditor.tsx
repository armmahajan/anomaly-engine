import { useEffect, useRef } from "react";
import { z } from "zod";
import {
  Color,
  Effect,
  GameCondition,
  GameEvent,
  Look,
  MOVEMENT_ABILITIES,
  PROP_EVENTS,
  type GameEventType,
  type Handler,
  type ProjectSpec,
  type WorldRoom,
} from "@anomaly/core";
import { clipChoices, markerChoices, objectIds, stateChoices, type HandlerPlace } from "./objects/objectRefs.ts";

/**
 * Edits a list of handlers ({on, when, do}) for the world, a room, a prop or
 * an enemy spawn. The forms come from the core schemas (events/events.ts),
 * so new events, conditions and effects show up here without changes; fields
 * that name things (item, modal, room, spawn, prop, character, ability, object,
 * clip, marker name, behavior state) are menus of what exists, colours are
 * colour pickers, nested choices (a playAnimation's target, a spawnEffect's
 * place, a marker's `from`) get their own small form, and nested objects (a
 * look, its tint, aura, afterimages and emitter) a sub-form, optional ones
 * behind an add / remove toggle. Every change hands the whole new list to `onChange`.
 */

export type HandlerScope = "world" | "room" | "prop" | "spawn";

interface Props {
  handlers: Handler[];
  onChange: (handlers: Handler[]) => void;
  scope: HandlerScope;
  project: ProjectSpec;
  /** The room the handlers belong to (not for world handlers). */
  room?: WorldRoom | null;
  /** The prop's or spawn's id (prop and spawn scopes): what `self` is in playAnimation and spawnEffect. */
  self?: string;
  locked: boolean;
  /** Label prefix for accessible names, e.g. "gate". */
  label?: string;
}

type Shape = Record<string, z.ZodType>;
type Option = { type: string; shape: Shape; description: string };

/** The options of a discriminated union, keyed by its discriminator (`type`, or `kind` for targets and places). */
const optionsOf = (union: z.ZodType, disc = "type"): Option[] => {
  const resolved = union instanceof z.ZodLazy ? (union.def.getter() as z.ZodType) : union;
  return (resolved as z.ZodDiscriminatedUnion<z.ZodObject[]>).options.map((o) => ({
    type: (o.shape[disc] as z.ZodLiteral<string>).value,
    shape: o.shape as Shape,
    description: o.description ?? "",
  }));
};

const EVENTS = optionsOf(GameEvent);
const CONDITIONS = optionsOf(GameCondition);
const EFFECTS = optionsOf(Effect);

/** Events a handler in this scope can hear (a prop hears no enemy's states). */
function eventsFor(scope: HandlerScope): Option[] {
  if (scope === "prop") return EVENTS.filter((e) => e.type !== "stateEntered");
  if (scope === "spawn") return EVENTS.filter((e) => e.type === "enemyKilled" || e.type === "marker" || e.type === "stateEntered");
  return EVENTS.filter((e) => !PROP_EVENTS.includes(e.type as GameEventType));
}

/** Fields the scope pins (a room's handlers are about that room, a spawn's about that spawn; a prop's or spawn's markers are its own clips'). */
const pinned = (scope: HandlerScope) => (scope === "world" ? [] : scope === "spawn" ? ["room", "spawn", "character", "from"] : scope === "prop" ? ["room", "from"] : ["room"]);

function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let inner = schema;
  let optional = false;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault || inner instanceof z.ZodNullable || inner instanceof z.ZodPrefault) {
    optional = true;
    inner = inner.def.innerType as z.ZodType;
  }
  return { inner, optional };
}

const discriminatorOf = (schema: z.ZodType): string | null => (schema instanceof z.ZodDiscriminatedUnion ? (schema.def.discriminator as string) : null);

/** What the fields of one handler can refer to. */
interface Ctx {
  project: ProjectSpec;
  room: WorldRoom | null | undefined;
  place: HandlerPlace;
  locked: boolean;
}

/** A nested union's options that make sense here: `self` only on a prop or spawn, a room's props and spawns only in a room. */
function nestedOptions(schema: z.ZodType, disc: string, ctx: Ctx, keep?: string): Option[] {
  return optionsOf(schema, disc).filter((o) => o.type === keep || ((o.type !== "self" || ctx.place.self !== null) && ((o.type !== "prop" && o.type !== "spawn") || Boolean(ctx.room))));
}

/** A colour field (core Color, possibly optional or defaulted). */
const isColor = (inner: z.ZodType) => inner === Color;

/** A nested plain object (a look, an emitter, a tint...): not a target or place. */
const objectShape = (inner: z.ZodType): Shape | null => (inner instanceof z.ZodObject ? (inner.shape as Shape) : null);

/** A field's default, if it has one. */
const defaultOf = (field: z.ZodType): unknown => (field instanceof z.ZodDefault ? field.def.defaultValue : undefined);

/** A fresh value of one option: its type plus placeholders for required fields (the operation validates). */
function blank(option: Option, ctx: Ctx, disc = "type"): Record<string, unknown> {
  return { [disc]: option.type, ...blankShape(option.shape, ctx, disc, option.type) };
}

/** Placeholders for the required fields of a shape (`disc` and its value skipped). */
function blankShape(shape: Shape, ctx: Ctx, disc?: string, type?: string): Record<string, unknown> {
  const out: Record<string, unknown> = disc ? { [disc]: type } : {};
  for (const [key, field] of Object.entries(shape)) {
    if (key === disc) continue;
    const { inner, optional } = unwrap(field);
    const nested = discriminatorOf(inner);
    // A target or place defaults to `self`; where there is no self, start at the first that fits.
    if (nested && field instanceof z.ZodDefault && !ctx.place.self) {
      const first = nestedOptions(inner, nested, ctx)[0];
      if (first) out[key] = blank(first, ctx, nested);
      continue;
    }
    if (optional) continue;
    const choices = refChoices(key, out, ctx);
    const sub = objectShape(inner);
    if (sub) out[key] = blankShape(sub, ctx);
    else if (isColor(inner)) out[key] = "#ffffff";
    else if (choices) out[key] = choices[0] ?? "";
    else if (inner instanceof z.ZodNumber) out[key] = 1;
    else if (inner instanceof z.ZodBoolean) out[key] = true;
    else if (inner instanceof z.ZodEnum) out[key] = inner.options[0];
    else if (key === "of") out[key] = type === "not" ? { type: "flag", flag: "flag_name", is: true } : [{ type: "flag", flag: "flag_name", is: true }];
    else out[key] = key === "flag" ? "flag_name" : key === "timer" ? "timer_name" : key === "clip" ? "idle" : "";
  }
  if (disc) delete out[disc];
  return out;
}

/** Menus for fields that name things in the project (`value` is the object the field belongs to). */
function refChoices(key: string, value: Record<string, unknown>, { project, room, place }: Ctx): string[] | null {
  switch (key) {
    case "item":
      return project.world.items.map((i) => i.id);
    case "modal":
      return project.world.modals.map((m) => m.id);
    case "room":
      return project.world.rooms.map((r) => r.id);
    case "spawn":
      return (room?.spawns ?? []).map((s) => s.id);
    case "prop":
      return (room?.props ?? []).map((p) => p.id);
    case "character":
      return project.characters.filter((c) => c.kind === "enemy").map((c) => c.id);
    case "ability":
      return Object.keys(MOVEMENT_ABILITIES);
    case "object":
      return objectIds(project);
    case "clip":
      return clipChoices(project, value, place);
    case "name":
      return value.type === "marker" ? markerChoices(project, value, place) : null;
    case "state":
      return value.type === "stateEntered" ? stateChoices(project, value, place) : null;
    default:
      return null;
  }
}

export function HandlerEditor({ handlers, onChange, scope, project, room, self, locked, label = scope }: Props) {
  const set = (i: number, h: Handler) => onChange(handlers.map((x, j) => (j === i ? h : x)));
  const events = eventsFor(scope);
  const ctx: Ctx = { project, room, locked, place: { room: room ?? null, self: self && (scope === "prop" || scope === "spawn") ? { kind: scope, id: self } : null } };
  return (
    <div className="handlers" data-testid={`handlers-${label}`}>
      {handlers.length === 0 && <p className="hint">No handlers.</p>}
      {handlers.map((h, i) => (
        <div className="handler" key={i} data-testid={`handler-${label}-${i}`}>
          <div className="handler-row">
            <strong>on</strong>
            <Fields value={h.on} options={events} hide={pinned(scope)} ctx={ctx} label={`${label} ${i} event`} onChange={(on) => set(i, { ...h, on: on as Handler["on"] })} />
            <button type="button" className="icon-button" aria-label={`remove ${label} handler ${i}`} disabled={locked} onClick={() => onChange(handlers.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
          <List title="when" items={h.when} options={CONDITIONS} ctx={ctx} label={`${label} ${i} condition`} onChange={(when) => set(i, { ...h, when: when as Handler["when"] })} />
          <List title="do" items={h.do} options={EFFECTS} ctx={ctx} label={`${label} ${i} effect`} onChange={(effects) => set(i, { ...h, do: effects as Handler["do"] })} />
        </div>
      ))}
      <button type="button" disabled={locked} onClick={() => onChange([...handlers, { on: blank(events[0]!, ctx), when: [], do: [blank(EFFECTS[0]!, ctx)] } as unknown as Handler])}>
        + Handler
      </button>
    </div>
  );
}

const placeless = (project: ProjectSpec, room: WorldRoom | null | undefined, locked: boolean): Ctx => ({ project, room, locked, place: { room: room ?? null, self: null } });

/** A list of effects on its own (e.g. a modal button's). */
export function EffectList({ effects, onChange, project, room, locked, label }: { effects: Effect[]; onChange: (effects: Effect[]) => void; project: ProjectSpec; room?: WorldRoom | null; locked: boolean; label: string }) {
  return <List title="do" items={effects} options={EFFECTS} ctx={placeless(project, room, locked)} label={label} onChange={(items) => onChange(items as Effect[])} />;
}

/** One condition on its own (e.g. a prop's solid or visible). */
export function ConditionField({ value, onChange, project, room, locked, label }: { value: GameCondition; onChange: (condition: GameCondition) => void; project: ProjectSpec; room?: WorldRoom | null; locked: boolean; label: string }) {
  return <Fields value={value} options={CONDITIONS} ctx={placeless(project, room, locked)} label={label} onChange={(c) => onChange(c as GameCondition)} />;
}

/** A look (core Look) on its own: the same form as a setLook effect's (e.g. a behavior state's). */
export function LookFields({ value, onChange, project, room, locked, label }: { value: Look; onChange: (look: Look) => void; project: ProjectSpec; room?: WorldRoom | null; locked: boolean; label: string }) {
  return (
    <span className="handler-nested look-fields">
      <ShapeFields shape={Look.shape as Shape} value={value as Record<string, unknown>} ctx={placeless(project, room, locked)} label={label} onChange={(v) => onChange(v as Look)} />
    </span>
  );
}

/** A fresh condition (a flag check) for editors that start one. */
export const newCondition = (): GameCondition => ({ type: "flag", flag: "flag_name", is: true });

interface ListProps {
  title: string;
  items: object[];
  options: Option[];
  ctx: Ctx;
  label: string;
  onChange: (items: object[]) => void;
}

function List({ title, items, options, ctx, label, onChange }: ListProps) {
  return (
    <div className="handler-list">
      <span className="muted">{title}</span>
      {items.map((item, i) => (
        <div className="handler-row" key={i}>
          <Fields value={item} options={options} ctx={ctx} label={`${label} ${i}`} onChange={(v) => v && onChange(items.map((x, j) => (j === i ? v : x)))} />
          <button type="button" className="icon-button" aria-label={`remove ${label} ${i}`} disabled={ctx.locked} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="link-button" disabled={ctx.locked} aria-label={`add ${label}`} onClick={() => onChange([...items, blank(options[0]!, ctx)])}>
        + {title === "when" ? "condition" : "effect"}
      </button>
    </div>
  );
}

interface FieldsProps {
  /** The value (undefined: an optional nested choice not given, shown as `none`). */
  value: object | undefined;
  options: Option[];
  hide?: string[];
  ctx: Ctx;
  label: string;
  onChange: (value: object | undefined) => void;
  /** The discriminator: `type` for events, conditions and effects; `kind` for targets and places. */
  disc?: string;
  /** Optional nested choice: the label of "not given". */
  none?: string;
}

/** A type menu and one input per parameter of the chosen type. */
function Fields({ value, options, hide = [], ctx, label, onChange, disc = "type", none }: FieldsProps) {
  const { locked } = ctx;
  const current = (value ?? {}) as Record<string, unknown>;
  const kind = current[disc] as string | undefined;
  const option = kind === undefined && none ? null : (options.find((o) => o.type === kind) ?? options[0]!);
  return (
    <>
      <select
        aria-label={label}
        title={option?.description}
        value={kind ?? ""}
        disabled={locked}
        onChange={(e) => {
          const picked = options.find((o) => o.type === e.target.value);
          onChange(picked ? blank(picked, ctx, disc) : undefined);
        }}
      >
        {none && <option value="">{none}</option>}
        {options.map((o) => (
          <option key={o.type} value={o.type} title={o.description}>
            {o.type}
          </option>
        ))}
      </select>
      {option && <ShapeFields shape={option.shape} value={current} ctx={ctx} label={label} hide={[disc, ...hide]} onChange={(v) => onChange(v)} />}
    </>
  );
}

interface ShapeFieldsProps {
  shape: Shape;
  value: Record<string, unknown>;
  ctx: Ctx;
  label: string;
  hide?: string[];
  onChange: (value: Record<string, unknown>) => void;
}

/** One input per field of a shape (an option's parameters, or a nested object's fields). */
function ShapeFields({ shape, value: current, ctx, label, hide = [], onChange }: ShapeFieldsProps) {
  const { locked } = ctx;
  const setField = (key: string, v: unknown) => {
    const next = { ...current };
    if (v === undefined || v === "") delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <>
      {Object.entries(shape)
        .filter(([key]) => !hide.includes(key))
        .map(([key, field]) => {
          const { inner, optional } = unwrap(field);
          const v = current[key];
          const name = `${label} ${key}`;
          if (key === "of") {
            const nested = Array.isArray(v) ? (v as object[]) : [v as object];
            return (
              <span key={key} className="handler-nested">
                {nested.map((c, i) => (
                  <Fields key={i} value={c} options={CONDITIONS} ctx={ctx} label={`${name} ${i}`} onChange={(c2) => setField(key, Array.isArray(v) ? nested.map((x, j) => (j === i ? c2 : x)) : c2)} />
                ))}
                {Array.isArray(v) && (
                  <button type="button" className="link-button" disabled={locked} onClick={() => setField(key, [...nested, blank(CONDITIONS[0]!, ctx)])}>
                    +
                  </button>
                )}
              </span>
            );
          }
          // A target or place (AnimTarget, EffectPlace): its own small form.
          const nestedDisc = discriminatorOf(inner);
          if (nestedDisc) {
            const shown = (v as Record<string, unknown> | undefined) ?? (defaultOf(field) as Record<string, unknown> | undefined);
            let nestedOpts = nestedOptions(inner, nestedDisc, ctx, shown?.[nestedDisc] as string | undefined);
            // stateEntered's `from`: only a spawn of the room means something there.
            if (current.type === "stateEntered" && key === "from") nestedOpts = nestedOpts.filter((o) => o.type === "spawn");
            return (
              <span key={key} className="handler-nested" title={inner.description ?? field.description}>
                <span className="muted">{key}</span>
                <Fields
                  value={shown}
                  options={nestedOpts}
                  ctx={ctx}
                  label={name}
                  disc={nestedDisc}
                  none={field instanceof z.ZodOptional ? `(any ${key})` : undefined}
                  onChange={(n) => setField(key, n)}
                />
              </span>
            );
          }
          // A nested object (a look, its tint / aura / afterimages, an emitter): a sub-form; an optional one can be added and removed.
          const sub = objectShape(inner);
          if (sub) {
            if (v === undefined || v === null) {
              if (!optional) return null;
              return (
                <button key={key} type="button" className="link-button" aria-label={`add ${name}`} title={field.description ?? inner.description} disabled={locked} onClick={() => setField(key, blankShape(sub, ctx))}>
                  + {key}
                </button>
              );
            }
            return (
              <span key={key} className="handler-nested handler-object" title={field.description ?? inner.description}>
                <span className="muted">{key}</span>
                <ShapeFields shape={sub} value={v as Record<string, unknown>} ctx={ctx} label={name} onChange={(n) => setField(key, n)} />
                {optional && (
                  <button type="button" className="icon-button" aria-label={`remove ${name}`} disabled={locked} onClick={() => setField(key, undefined)}>
                    ✕
                  </button>
                )}
              </span>
            );
          }
          if (isColor(inner)) {
            const fallback = defaultOf(field) as string | undefined;
            if ((v === undefined || v === null) && optional && fallback === undefined) {
              return (
                <button key={key} type="button" className="link-button" aria-label={`add ${name}`} disabled={locked} onClick={() => setField(key, "#ffffff")}>
                  + {key}
                </button>
              );
            }
            return (
              <span key={key} className="handler-nested" title={field.description ?? key}>
                <span className="muted">{key}</span>
                <ColorInput label={name} value={(v as string | undefined) ?? fallback ?? "#ffffff"} disabled={locked} onCommit={(c) => setField(key, c)} />
                {optional && fallback === undefined && (
                  <button type="button" className="icon-button" aria-label={`remove ${name}`} disabled={locked} onClick={() => setField(key, undefined)}>
                    ✕
                  </button>
                )}
              </span>
            );
          }
          if (inner instanceof z.ZodTuple) {
            const pair = Array.isArray(v) ? (v as number[]) : [0, 0];
            return (
              <span key={key} className="handler-nested" title={key}>
                <span className="muted">{key}</span>
                {["x", "y"].map((axis, i) => (
                  <CommitInput
                    key={axis}
                    className="number-box"
                    type="number"
                    label={`${name} ${axis}`}
                    placeholder={axis}
                    value={String(pair[i] ?? 0)}
                    disabled={locked}
                    onCommit={(text) => setField(key, pair.map((n, j) => (j === i ? Number(text) || 0 : n)))}
                  />
                ))}
              </span>
            );
          }
          const refs = refChoices(key, current, ctx);
          const choices = refs ? [...refs, ...(typeof v === "string" && v && !refs.includes(v) ? [v] : [])] : inner instanceof z.ZodEnum ? (inner.options as string[]) : null;
          if (choices) {
            const shownValue = (v as string | undefined) ?? (typeof defaultOf(field) === "string" ? (defaultOf(field) as string) : "");
            return (
              <select key={key} aria-label={name} title={key} value={shownValue} disabled={locked} onChange={(e) => setField(key, e.target.value || undefined)}>
                {/* A defaulted field always has its value; only a truly optional one can be left out ("any"). */}
                {((optional && !(field instanceof z.ZodDefault)) || !choices.includes(shownValue)) && <option value="">{optional && !(field instanceof z.ZodDefault) ? `(any ${key})` : `${key}?`}</option>}
                {choices.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            );
          }
          if (inner instanceof z.ZodBoolean) {
            const fallback = defaultOf(field);
            return (
              <label key={key} className="inline-check">
                <input type="checkbox" aria-label={name} checked={(v as boolean | undefined) ?? (typeof fallback === "boolean" ? fallback : true)} disabled={locked} onChange={(e) => setField(key, e.target.checked)} />
                {key}
              </label>
            );
          }
          if (inner instanceof z.ZodNumber) {
            const fallback = defaultOf(field);
            return (
              <CommitInput
                key={key}
                className="number-box"
                type="number"
                label={name}
                placeholder={typeof fallback === "number" ? `${key} ${fallback}` : key}
                value={v === undefined || v === null ? "" : String(v)}
                disabled={locked}
                onCommit={(text) => setField(key, text === "" ? (optional ? undefined : 0) : Number(text))}
              />
            );
          }
          if (inner instanceof z.ZodArray) return null; // lists of ids (revealMap rooms): all by default
          return <CommitInput key={key} className="art-text handler-text" label={name} placeholder={key} value={(v as string) ?? ""} disabled={locked} onCommit={(text) => setField(key, text)} />;
        })}
    </>
  );
}

/** A colour picker that commits once the pick is made (the native change event), not on every drag step. */
function ColorInput({ value, onCommit, label, disabled }: { value: string; onCommit: (color: string) => void; label: string; disabled: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const changed = () => input.value !== value && commit.current(input.value);
    input.addEventListener("change", changed);
    return () => input.removeEventListener("change", changed);
  }, [value]);
  return <input ref={ref} key={value} type="color" className="color-box" aria-label={label} title={label} defaultValue={value} disabled={disabled} />;
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
