import { isObjectArt, objectAssets, type ChangeResult, type GameCondition, type ObjectArt, type Prop, type ProjectSpec, type PropSwitch, type WorldRoom } from "@anomaly/core";
import type { Session } from "./session.ts";
import type { RoomsUi } from "./RoomsView.tsx";
import { ConditionField, HandlerEditor, newCondition } from "./HandlerEditor.tsx";
import { ArtJobButton } from "./ArtJobButton.tsx";
import { fileUrl } from "./api.ts";
import { clipsOf, propArtFrom, propArtValue } from "./objects/objectRefs.ts";

/** Rooms sidebar: the selected room's props: list, look, solid / visible conditions, health, bounce, prompt, handlers. */
export function PropsSection({
  project,
  session,
  room,
  ui,
  setUi,
  locked,
  heading = true,
}: {
  project: ProjectSpec;
  session: Session;
  room: WorldRoom;
  ui: RoomsUi;
  setUi: (ui: RoomsUi) => void;
  locked: boolean;
  /** Its own "Props" heading (off when it sits in a titled section). */
  heading?: boolean;
}) {
  const prop = room.props.find((p) => p.id === ui.propId) ?? null;
  const edit = async (op: string, input: unknown) => {
    const result: ChangeResult = await session.applyOperation(op, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  return (
    <>
      {heading && <h3>Props</h3>}
      <p className="hint">Rectangles that can be seen, stood on, touched, used (Up) and struck. Draw one with ▭ Prop on the room.</p>
      {room.props.length > 0 && (
        <div className="art-actions">
          <ArtJobButton
            session={session}
            request={{ stage: "propArt", worldRoomId: room.id }}
            label={`🎨 Draw props (${room.props.filter((p) => !p.art).length})`}
            cost="$0.004 (more if pieces are painted)"
            locked={locked}
            nothing={room.props.every((p) => p.art) ? "Every prop here has art" : undefined}
          />
        </div>
      )}
      <ul className="character-list prop-list">
        {room.props.map((p) => (
          <li key={p.id}>
            <button type="button" data-testid={`prop-${p.id}`} className={p.id === prop?.id ? "selected" : ""} onClick={() => setUi({ ...ui, propId: p.id === prop?.id ? null : p.id })}>
              {p.art ? <PieceThumb project={project} art={p.art} /> : <span className="swatch" style={{ background: p.color }} />}
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

/** A prop's kit piece, small. */
function PieceThumb({ project, art }: { project: ProjectSpec; art: NonNullable<Prop["art"]> }) {
  if (!("biome" in art)) {
    const object = project.art.assets.find((a) => a.id === art.object);
    return object?.kind === "character" && object.preview ? (
      <img className="prop-thumb" src={fileUrl(object.preview.file)} alt="" data-testid="prop-art" title={`object ${art.object}`} />
    ) : (
      <span className="swatch object-swatch" title={`object ${art.object}`} />
    );
  }
  const biome = project.art.assets.find((a) => a.id === art.biome);
  const piece = biome?.kind === "biome" ? biome.kit?.pieces.find((p) => p.id === art.piece) : undefined;
  return piece ? <img className="prop-thumb" src={fileUrl(piece.file)} alt="" data-testid="prop-art" /> : <span className="swatch" />;
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
  const pieces = project.art.assets.flatMap((a) => (a.kind === "biome" && a.kit ? a.kit.pieces.map((p) => ({ value: `kit:${a.id}/${p.id}`, label: `${a.name} · ${p.name}` })) : []));
  const objects = objectAssets(project);
  const art = propArtValue(prop.art);
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
        <select aria-label="prop art" value={art} disabled={locked} onChange={(e) => change({ art: propArtFrom(project, e.target.value, prop.art) })}>
          <option value="">color only</option>
          {pieces.length > 0 && (
            <optgroup label="Kit pieces">
              {pieces.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          )}
          {objects.length > 0 && (
            <optgroup label="Objects (animated)">
              {objects.map((o) => (
                <option key={o.id} value={`object:${o.id}`}>
                  {o.name}
                </option>
              ))}
            </optgroup>
          )}
          {art && !pieces.some((p) => p.value === art) && !objects.some((o) => `object:${o.id}` === art) && <option value={art}>{art.replace(/^\w+:/, "")} (missing)</option>}
        </select>
      </div>
      {isObjectArt(prop.art) && <ObjectArtRow project={project} art={prop.art} locked={locked} onChange={(next) => change({ art: next })} />}
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
      <HandlerEditor handlers={prop.handlers} scope="prop" self={prop.id} project={project} room={room} locked={locked} label={`prop ${prop.id}`} onChange={setHandlers} />
    </div>
  );
}

/** A prop drawn with an object: the clip it loops when nothing else plays, and its size. */
function ObjectArtRow({ project, art, locked, onChange }: { project: ProjectSpec; art: ObjectArt; locked: boolean; onChange: (art: ObjectArt) => void }) {
  const clips = clipsOf(project, art.object);
  const idle = art.idle ?? "";
  return (
    <div className="prop-row" data-testid="prop-object-art">
      <label>Idle</label>
      <select aria-label="prop object idle" value={idle} disabled={locked} title="The clip it loops until a playAnimation plays another" onChange={(e) => onChange({ ...art, idle: e.target.value || null })}>
        <option value="">(rest pose)</option>
        {clips.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        {idle && !clips.includes(idle) && <option value={idle}>{idle} (not drawn yet)</option>}
      </select>
      <label>Scale</label>
      <Commit
        label="prop object scale"
        number
        value={String(art.scale)}
        locked={locked}
        onCommit={(v) => {
          const n = Number(v);
          if (v !== "" && Number.isFinite(n)) onChange({ ...art, scale: Math.min(8, Math.max(0.1, n)) });
        }}
      />
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
