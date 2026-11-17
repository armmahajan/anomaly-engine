import type { ChangeResult, GameCondition, Prop, ProjectSpec, PropSwitch, WorldRoom } from "@anomaly/core";
import type { Session } from "./session.ts";
import type { RoomsUi } from "./RoomsView.tsx";
import { ConditionField, HandlerEditor, newCondition } from "./HandlerEditor.tsx";

/** Rooms sidebar: the selected room's props: list, look, solid / visible conditions, health, bounce, prompt, handlers. */
export function PropsSection({ project, session, room, ui, setUi, locked }: { project: ProjectSpec; session: Session; room: WorldRoom; ui: RoomsUi; setUi: (ui: RoomsUi) => void; locked: boolean }) {
  const prop = room.props.find((p) => p.id === ui.propId) ?? null;
  const edit = async (op: string, input: unknown) => {
    const result: ChangeResult = await session.applyOperation(op, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  return (
    <>
      <h3>Props</h3>
      <p className="hint">Rectangles that can be seen, stood on, touched, used (Up) and struck. Draw one with ▭ Prop on the room.</p>
      <ul className="character-list prop-list">
        {room.props.map((p) => (
          <li key={p.id}>
            <button type="button" data-testid={`prop-${p.id}`} className={p.id === prop?.id ? "selected" : ""} onClick={() => setUi({ ...ui, propId: p.id === prop?.id ? null : p.id })}>
              <span className="swatch" style={{ background: p.color }} />
              {p.name ?? p.id}
              <span className="kind">
                {p.width}×{p.height}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {prop && (
        <PropEditor
          key={`${room.id}/${prop.id}`}
          project={project}
          room={room}
          prop={prop}
          locked={locked}
          change={(changes) => void edit("updateProp", { roomId: room.id, propId: prop.id, changes })}
          remove={() => void edit("removeProp", { roomId: room.id, propId: prop.id }).then((ok) => ok && setUi({ ...ui, propId: null }))}
          setHandlers={(handlers) => void edit("setHandlers", { roomId: room.id, propId: prop.id, handlers })}
        />
      )}
    </>
  );
}

interface EditorProps {
  project: ProjectSpec;
  room: WorldRoom;
  prop: Prop;
  locked: boolean;
  change: (changes: Record<string, unknown>) => void;
  remove: () => void;
  setHandlers: (handlers: Prop["handlers"]) => void;
}

function PropEditor({ project, room, prop, locked, change, remove, setHandlers }: EditorProps) {
  const pieces = project.art.assets.flatMap((a) => (a.kind === "biome" && a.kit ? a.kit.pieces.map((p) => ({ value: `${a.id}/${p.id}`, label: `${a.name} · ${p.name}` })) : []));
  const art = prop.art ? `${prop.art.biome}/${prop.art.piece}` : "";
  return (
    <div className="prop-editor" data-testid="prop-editor">
      <div className="prop-row">
        <span className="spawn-id">{prop.id}</span>
        <button type="button" disabled={locked} onClick={remove}>
          Delete prop
        </button>
      </div>
      <div className="prop-row">
        <label>Name</label>
        <Commit label="prop name" value={prop.name ?? ""} locked={locked} onCommit={(name) => change({ name: name.trim() || null })} />
      </div>
      <div className="prop-row">
        <label>Rect</label>
        {(["x", "y", "width", "height"] as const).map((key) => (
          <Commit key={key} label={`prop ${key}`} number value={String(prop[key])} locked={locked} onCommit={(v) => v !== "" && change({ [key]: Number(v) })} />
        ))}
      </div>
      <div className="prop-row">
        <label>Look</label>
        <input type="color" aria-label="prop color" value={prop.color} disabled={locked} onChange={(e) => change({ color: e.target.value })} />
        <select aria-label="prop art" value={art} disabled={locked} onChange={(e) => {
          const [biome, piece] = e.target.value.split("/");
          change({ art: biome && piece ? { biome, piece } : null });
        }}>
          <option value="">color only</option>
          {pieces.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          {art && !pieces.some((p) => p.value === art) && <option value={art}>{art} (missing)</option>}
        </select>
      </div>
      <SwitchField name="solid" value={prop.solid} project={project} room={room} locked={locked} onChange={(solid) => change({ solid })} />
      <SwitchField name="visible" value={prop.visible} project={project} room={room} locked={locked} onChange={(visible) => change({ visible })} />
      <div className="prop-row">
        <label>Health</label>
        <Commit label="prop health" number placeholder="—" value={prop.health === null ? "" : String(prop.health)} locked={locked} onCommit={(v) => change({ health: v === "" ? null : Number(v) })} />
        <span className="muted">hits</span>
        <label className="inline-check">
          <input type="checkbox" aria-label="prop bounce" checked={prop.bounce} disabled={locked} onChange={(e) => change({ bounce: e.target.checked })} />
          bounce
        </label>
      </div>
      <div className="prop-row">
        <label>Prompt</label>
        <Commit label="prop prompt" placeholder="↑" value={prop.prompt ?? ""} locked={locked} onCommit={(v) => change({ prompt: v.trim() || null })} />
      </div>
      <span className="muted">Handlers</span>
      <HandlerEditor handlers={prop.handlers} scope="prop" project={project} room={room} locked={locked} label={`prop ${prop.id}`} onChange={setHandlers} />
    </div>
  );
}

/** Solid / visible: always, never, or while a condition holds. */
function SwitchField({ name, value, project, room, locked, onChange }: { name: string; value: PropSwitch; project: ProjectSpec; room: WorldRoom; locked: boolean; onChange: (value: PropSwitch) => void }) {
  const mode = typeof value === "boolean" ? String(value) : "while";
  return (
    <div className="prop-row">
      <label>{name[0]!.toUpperCase() + name.slice(1)}</label>
      <select
        aria-label={`prop ${name}`}
        value={mode}
        disabled={locked}
        onChange={(e) => onChange(e.target.value === "while" ? newCondition() : e.target.value === "true")}
      >
        <option value="true">always</option>
        <option value="false">never</option>
        <option value="while">while…</option>
      </select>
      {typeof value !== "boolean" && (
        <span className="handler-row">
          <ConditionField value={value as GameCondition} project={project} room={room} locked={locked} label={`prop ${name} condition`} onChange={onChange} />
        </span>
      )}
    </div>
  );
}

/** A text or number box that commits on Enter or leaving it (one edit, not one per keystroke). */
function Commit({ value, onCommit, label, locked, number, placeholder }: { value: string; onCommit: (text: string) => void; label: string; locked: boolean; number?: boolean; placeholder?: string }) {
  return (
    <input
      key={value}
      className={number ? "number-box" : "art-text prop-text"}
      type={number ? "number" : "text"}
      aria-label={label}
      title={label}
      placeholder={placeholder}
      defaultValue={value}
      disabled={locked}
      onBlur={(e) => e.currentTarget.value !== value && onCommit(e.currentTarget.value)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}
