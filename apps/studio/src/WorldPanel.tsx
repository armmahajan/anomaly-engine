import { useState } from "react";
import { dressingOutOfDate, WORLD_LAYERS, type ArtState, type ProjectSpec, type WorldLayer } from "@anomaly/core";
import { JobLog, money, Zoom } from "./ArtPanel.tsx";
import type { Session } from "./session.ts";
import { biomesOf, currentWorld, type WorldUi } from "./WorldBench.tsx";

/**
 * Worlds mode sidebar: biomes (paint a kit at draft or final quality, repaint
 * one part), rooms (compose, suggest a layout, dress the playtest room, delete),
 * the room's atmosphere, and the selected piece.
 */

interface Props {
  project: ProjectSpec;
  art: ArtState;
  session: Session;
  ui: WorldUi;
  setUi: (ui: WorldUi) => void;
  selected: string | null;
  setSelected: (id: string | null) => void;
  locked: boolean;
}

const PARTS = ["backgrounds", "backdrop", "structures", "props", "ground"] as const;

export function WorldPanel({ project, art, session, ui, setUi, selected, setSelected, locked }: Props) {
  const biomes = biomesOf(project);
  const { biome, room } = currentWorld(project, ui);
  const [creating, setCreating] = useState(biomes.length === 0);
  const [theme, setTheme] = useState("");
  const [name, setName] = useState("");
  const [quality, setQuality] = useState<"draft" | "final">("draft");
  const [part, setPart] = useState<(typeof PARTS)[number]>("backdrop");
  const [repaintNote, setRepaintNote] = useState("");
  const [roomNote, setRoomNote] = useState("");
  const [newLayout, setNewLayout] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const running = art.running;
  const mine = running !== null && (running.biomeId === biome?.id || (!running.biomeId && running.stage === "worldKit"));
  // Another job (a character's art) doesn't block this one: it queues behind it.
  const disabled = locked || mine || !art.available;
  const lastJob = [...art.jobs].reverse().find((j) => j.biomeId !== undefined && j.biomeId === biome?.id) ??
    [...art.jobs].reverse().find((j) => j.stage === "worldKit" && !j.biomeId);
  const edit = async (name: string, input: unknown) => {
    const result = await session.applyOperation(name, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  const placement = room?.composition.placements.find((p) => p.id === selected) ?? null;
  const piece = placement ? biome?.kit?.pieces.find((p) => p.id === placement.piece) : null;
  const testRoom = project.world.rooms.find((r) => r.id === project.world.playtest?.room) ?? null;
  const dressing = testRoom?.dressing ?? null;
  /** New art dresses the playtest room while it is still plain. */
  const dressRoom = testRoom && !dressing ? testRoom.id : undefined;

  return (
    <section className="world-panel" data-testid="world-panel">
      <h2>Biomes</h2>
      <ul className="character-list">
        {biomes.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              className={b.id === biome?.id && !creating ? "selected" : ""}
              onClick={() => {
                setCreating(false);
                setSelected(null);
                setUi({ ...ui, biomeId: b.id, roomId: null, previewLayout: false });
              }}
            >
              {b.name}
              <span className="kind">{b.rooms.length} room{b.rooms.length === 1 ? "" : "s"}</span>
            </button>
          </li>
        ))}
      </ul>
      {!creating && (
        <div className="list-actions">
          <button type="button" onClick={() => setCreating(true)} disabled={disabled}>
            + New biome
          </button>
        </div>
      )}

      {creating && (
        <div className="world-new">
          <h3>New biome</h3>
          <label className="art-label" htmlFor="biome-theme">
            What is this place?
          </label>
          <textarea
            id="biome-theme"
            className="art-text"
            rows={3}
            placeholder="e.g. a forgotten underground cathedral overgrown with pale glowing fungus"
            value={theme}
            disabled={disabled}
            onChange={(e) => setTheme(e.target.value)}
          />
          <input className="art-text" aria-label="biome name" placeholder="Name (optional)" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
          <Quality value={quality} onChange={setQuality} />
          <div className="art-actions">
            <button
              type="button"
              disabled={disabled || !theme.trim()}
              onClick={async () => {
                if (await session.startArtJob({ stage: "worldKit", brief: theme.trim(), name: name.trim() || undefined, quality, dressRoom })) {
                  setCreating(false);
                  setUi({ ...ui, biomeId: null, roomId: null });
                }
              }}
            >
              Paint kit + first room (~{quality === "draft" ? "$0.02" : "$0.05"})
            </button>
            {biomes.length > 0 && (
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {biome && !creating && (
        <>
          <h3>Kit</h3>
          <p className="hint">{biome.brief}</p>
          {biome.kit ? (
            <>
              <div className="world-row">
                <select value={part} onChange={(e) => setPart(e.target.value as (typeof PARTS)[number])} aria-label="part to repaint" disabled={disabled}>
                  {PARTS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input className="art-text" aria-label="repaint direction" placeholder="Direction (e.g. warmer, sunset)" value={repaintNote} disabled={disabled} onChange={(e) => setRepaintNote(e.target.value)} />
              </div>
              <div className="art-actions">
                <button type="button" disabled={disabled} onClick={() => void session.startArtJob({ stage: "worldRepaint", biomeId: biome.id, part, feedback: repaintNote.trim() || undefined })}>
                  Repaint {part}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  title="Repaint the whole kit (piece ids are kept, so rooms keep working)"
                  onClick={() => void session.startArtJob({ stage: "worldKit", biomeId: biome.id, quality: biome.kit!.quality === "draft" ? "final" : "draft" })}
                >
                  Repaint all as {biome.kit.quality === "draft" ? "final" : "draft"}
                </button>
              </div>
            </>
          ) : (
            <div className="art-actions">
              <button type="button" disabled={disabled} onClick={() => void session.startArtJob({ stage: "worldKit", biomeId: biome.id })}>
                Paint kit
              </button>
            </div>
          )}

          <h3>Rooms</h3>
          <ul className="room-list">
            {biome.rooms.map((r) => {
              const isDressed = dressing?.biome === biome.id && dressing.room === r.id;
              const stale = project.world.rooms.filter((w) => w.dressing?.biome === biome.id && w.dressing.room === r.id && dressingOutOfDate(w));
              return (
                <li key={r.id} className={r.id === room?.id ? "selected" : ""}>
                  <button type="button" onClick={() => setUi({ ...ui, biomeId: biome.id, roomId: r.id, previewLayout: false })}>
                    {r.name}
                    {r.layout && <span className="tag">layout</span>}
                    {isDressed && <span className="tag">playtest</span>}
                    {stale.length > 0 && <span className="tag stale" title={`The tiles of ${stale.map((w) => w.name).join(", ")} changed since it was composed`}>tiles changed</span>}
                  </button>
                  {stale.length > 0 && (
                    <button type="button" className="icon-button" title="Recompose it around the room's tiles as they are now (~$0.004)" aria-label={`recompose ${r.name}`} disabled={disabled} onClick={() => void session.startArtJob({ stage: "worldCompose", biomeId: biome.id, roomId: r.id })}>
                      ↻
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    title={isDressed ? "Plain playtest room" : "Dress the playtest room with this"}
                    aria-label={isDressed ? `undress playtest room from ${r.name}` : `dress playtest room with ${r.name}`}
                    disabled={locked || !testRoom}
                    onClick={() => void edit("setDressing", isDressed ? { biomeId: null } : { biomeId: biome.id, roomId: r.id })}
                  >
                    {isDressed ? "◉" : "○"}
                  </button>
                  <button type="button" className="icon-button" aria-label={`delete room ${r.name}`} disabled={locked} onClick={() => void edit("deleteRoom", { assetId: biome.id, roomId: r.id })}>
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          {biome.kit && (
            <>
              <input className="art-text" aria-label="room direction" placeholder="Direction for a new room (optional)" value={roomNote} disabled={disabled} onChange={(e) => setRoomNote(e.target.value)} />
              <div className="art-actions">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void session.startArtJob({ stage: "worldCompose", biomeId: biome.id, feedback: roomNote.trim() || undefined, newLayout, dressRoom })
                  }
                >
                  Compose room (~$0.004)
                </button>
                <label className="art-auto" title="Also design new platforms (a suggestion you can accept)">
                  <input type="checkbox" checked={newLayout} onChange={(e) => setNewLayout(e.target.checked)} /> Suggest layout
                </label>
              </div>
            </>
          )}

          {room && (
            <Atmosphere
              key={room.id}
              room={room}
              disabled={locked}
              onChange={(changes) => void edit("updateRoom", { assetId: biome.id, roomId: room.id, changes })}
            />
          )}

          {placement && room && (
            <div className="world-selection" data-testid="world-selection">
              <h3>Selected: {piece?.name ?? placement.piece}</h3>
              <div className="world-row">
                <label>
                  Layer
                  <select
                    value={placement.layer}
                    disabled={locked}
                    aria-label="piece layer"
                    onChange={(e) => void edit("updatePlacement", { assetId: biome.id, roomId: room.id, placementId: placement.id, changes: { layer: e.target.value as WorldLayer } })}
                  >
                    {(Object.keys(WORLD_LAYERS) as WorldLayer[])
                      .filter((l) => l !== "far")
                      .map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Scale
                  <input
                    type="number"
                    step={0.1}
                    min={0.1}
                    max={6}
                    key={placement.scale}
                    defaultValue={placement.scale}
                    disabled={locked}
                    aria-label="piece scale"
                    onBlur={(e) => void edit("updatePlacement", { assetId: biome.id, roomId: room.id, placementId: placement.id, changes: { scale: Number(e.target.value) } })}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={placement.flip}
                    disabled={locked}
                    onChange={(e) => void edit("updatePlacement", { assetId: biome.id, roomId: room.id, placementId: placement.id, changes: { flip: e.target.checked } })}
                  />{" "}
                  Flip
                </label>
              </div>
              <p className="hint">
                x {Math.round(placement.x)}, y {Math.round(placement.y)} · drag it in the view to move it
              </p>
              <button
                type="button"
                disabled={locked}
                onClick={async () => {
                  if (await edit("removePlacement", { assetId: biome.id, roomId: room.id, placementId: placement.id })) setSelected(null);
                }}
              >
                Remove piece
              </button>
            </div>
          )}
        </>
      )}

      <div className="art-meta">
        {art.available ? `${art.models.image} · ${art.models.vision} · spent ${money(art.totalCost)}` : "Art generation is off: add OPENROUTER_API_KEY to the studio's .env."}
      </div>
      <JobLog art={art} mine={mine} lastJob={lastJob} onCancel={() => void session.cancelArtJob()} onZoom={setZoom} subject={biome?.id ?? ""} />
      {zoom && <Zoom file={zoom} onClose={() => setZoom(null)} />}
    </section>
  );
}

function Quality({ value, onChange }: { value: "draft" | "final"; onChange: (q: "draft" | "final") => void }) {
  return (
    <div className="quality" role="radiogroup" aria-label="Quality">
      {(["draft", "final"] as const).map((q) => (
        <label key={q} title={q === "draft" ? "Medium-quality background planes, cheapest pieces (~$0.07 per biome): good for exploring" : "Medium-quality planes and pieces (~$0.08): once you like a biome"}>
          <input type="radio" name="quality" checked={value === q} onChange={() => onChange(q)} /> {q === "draft" ? "Draft" : "Final"}
        </label>
      ))}
    </div>
  );
}

type Room = NonNullable<ReturnType<typeof currentWorld>["room"]>;

/** Fog per layer and the darkness tint, saved on release. */
function Atmosphere({ room, disabled, onChange }: { room: Room; disabled: boolean; onChange: (changes: object) => void }) {
  const c = room.composition;
  return (
    <div className="atmosphere">
      <h3>Atmosphere</h3>
      {(["mid", "back", "play"] as const).map((layer) => (
        <label key={layer} className="world-slider">
          Fog behind {layer}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={c.fog[layer]}
            disabled={disabled}
            aria-label={`fog ${layer}`}
            onPointerUp={(e) => onChange({ fog: { [layer]: Number((e.target as HTMLInputElement).value) } })}
            onKeyUp={(e) => onChange({ fog: { [layer]: Number((e.target as HTMLInputElement).value) } })}
          />
        </label>
      ))}
      <label className="world-slider">
        Darkness tint
        <input type="color" defaultValue={c.palette.ambient} disabled={disabled} aria-label="ambient color" onBlur={(e) => onChange({ palette: { ambient: e.target.value } })} />
      </label>
      <label className="world-slider">
        Dust
        <input
          type="range"
          min={0}
          max={300}
          step={10}
          defaultValue={c.dust.amount}
          disabled={disabled}
          aria-label="dust amount"
          onPointerUp={(e) => onChange({ dust: { amount: Number((e.target as HTMLInputElement).value) } })}
        />
      </label>
    </div>
  );
}
