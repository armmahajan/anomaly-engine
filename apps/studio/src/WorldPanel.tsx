import { useEffect, useRef, useState, type ReactNode } from "react";
import { ART_COST_ESTIMATES, dressingOutOfDate, WORLD_LAYERS, type ArtState, type ProjectSpec, type WorldLayer } from "@anomaly/core";
import { JobLog, money, Zoom } from "./ArtPanel.tsx";
import { fileUrl } from "./api.ts";
import type { Session } from "./session.ts";
import { currentWorld, type WorldUi } from "./WorldBench.tsx";
import { Section } from "./worlds/Section.tsx";
import { GameRoomSelect } from "./worlds/GameRoomSelect.tsx";
import { approx, lookUsage, looksOf, nameList, roomsDressedBy, type Look } from "./worlds/scenery.ts";
import { ArtDot } from "./rooms/RoomList.tsx";
import "./worlds-rooms.css";

/**
 * Scenery mode sidebar, in sections:
 * - Looks: each region's art kit (a biome), and painting a new one;
 * - Look: what it is, where it is used, its quality;
 * - Pieces: what the kit holds, repainting a part;
 * - Dressings: the look's arrangements (biome rooms), the game room each dresses,
 *   and composing one for a room;
 * - This dressing: its room, recompose, atmosphere, the selected piece;
 * - Art generation (closed): models and spend.
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
  /** Open a game room in the Rooms tab. */
  onOpenRoom?: (roomId: string) => void;
}

const PARTS = ["backgrounds", "backdrop", "structures", "props", "ground"] as const;
const PART_TEXT: Record<(typeof PARTS)[number], string> = {
  backgrounds: "background planes",
  backdrop: "backdrop",
  structures: "structure pieces",
  props: "prop pieces",
  ground: "ground texture",
};
const KIT_COST = { draft: 0.07, final: 0.08 } as const;

/** The game room a new dressing of `look` is for: the one Rooms sent, else a plain room in its region, else the plain playtest room, else any plain room. */
function defaultTarget(project: ProjectSpec, look: Look | null, sent: string | null | undefined): string {
  const rooms = project.world.rooms;
  const plain = rooms.filter((r) => !r.dressing);
  if (sent && plain.some((r) => r.id === sent)) return sent;
  const regions = new Set<string | undefined>(look ? lookUsage(project, look).rooms.map((r) => r.regionId) : []);
  // A look painted for a region carries its name.
  for (const g of project.progression.regions) if (look && g.name === look.name) regions.add(g.id);
  const test = plain.find((r) => r.id === project.world.playtest?.room);
  return (plain.find((r) => r.regionId && regions.has(r.regionId)) ?? test ?? plain[0])?.id ?? "";
}

export function WorldPanel({ project, art, session, ui, setUi, selected, setSelected, locked, onOpenRoom }: Props) {
  const looks = looksOf(project);
  const { biome: look, room: dressing } = currentWorld(project, ui);
  const [creating, setCreating] = useState(looks.length === 0);
  const [theme, setTheme] = useState("");
  const [name, setName] = useState("");
  const [quality, setQuality] = useState<"draft" | "final">("draft");
  const [part, setPart] = useState<(typeof PARTS)[number]>("backdrop");
  const [repaintNote, setRepaintNote] = useState("");
  const [roomNote, setRoomNote] = useState("");
  const [newLayout, setNewLayout] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [composeFor, setComposeFor] = useState(() => defaultTarget(project, look, ui.target));
  // A room sent from Rooms, or another look, picks the room a new dressing is for.
  useEffect(() => setComposeFor(defaultTarget(project, look, ui.target)), [look?.id, ui.target]); // eslint-disable-line react-hooks/exhaustive-deps
  // Sent from Rooms: show the room's dressing, or where to compose one for it.
  const composeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ui.target) return;
    setCreating(looks.length === 0);
    const frame = requestAnimationFrame(() => {
      const panel = composeRef.current?.closest(".world-panel");
      const dressingBox = panel?.querySelector("[data-testid=dressing-section]");
      const sentDressed = project.world.rooms.find((r) => r.id === ui.target)?.dressing;
      (sentDressed && dressingBox ? dressingBox : composeRef.current)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [ui.target]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = art.running;
  const mine = running !== null && (running.biomeId === look?.id || (!running.biomeId && running.stage === "worldKit"));
  // Another job (a character's art) doesn't block this one: it queues behind it.
  const disabled = locked || mine || !art.available;
  const lastJob =
    [...art.jobs].reverse().find((j) => j.biomeId !== undefined && j.biomeId === look?.id) ?? [...art.jobs].reverse().find((j) => j.stage === "worldKit" && !j.biomeId);
  const edit = async (name: string, input: unknown) => {
    const result = await session.applyOperation(name, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  const placement = dressing?.composition.placements.find((p) => p.id === selected) ?? null;
  const piece = placement ? look?.kit?.pieces.find((p) => p.id === placement.piece) : null;
  const roomName = (id: string) => project.world.rooms.find((r) => r.id === id)?.name ?? id;
  const showDressing = (lookId: string, dressingId: string | null) => {
    setSelected(null);
    setUi({ ...ui, biomeId: lookId, roomId: dressingId, previewLayout: false });
  };
  const roomLink = (id: string, name: string) =>
    onOpenRoom ? (
      <button type="button" className="link-button" title={`Open ${name} in Rooms`} onClick={() => onOpenRoom(id)}>
        {name} ↗
      </button>
    ) : (
      <strong>{name}</strong>
    );

  /** Make the dressing draw `roomId` (and only it), in one undo step. */
  const dressRoomWith = async (roomId: string) => {
    if (!look || !dressing) return;
    const now = roomsDressedBy(project, look.id, dressing.id);
    const ops = [
      ...now.filter((r) => r.id !== roomId).map((r) => ({ name: "setDressing", input: { worldRoomId: r.id, biomeId: null } })),
      ...(roomId && !now.some((r) => r.id === roomId) ? [{ name: "setDressing", input: { worldRoomId: roomId, biomeId: look.id, roomId: dressing.id } }] : []),
    ];
    if (ops.length === 0) return;
    const result = await session.applyBatch(ops);
    if (!result.ok) session.reportProblem(result.error.message);
  };

  const target = composeFor || undefined;
  const sentPlain = project.world.rooms.find((r) => r.id === ui.target && !r.dressing && r.id === composeFor);
  const dressed = look && dressing ? roomsDressedBy(project, look.id, dressing.id) : [];
  const stale = dressed.filter(dressingOutOfDate);

  return (
    <section className="world-panel" data-testid="world-panel">
      <Section
        id="scenery:looks"
        top
        title="Looks"
        note={looks.length}
        actions={
          !creating && (
            <button type="button" className="small-button" onClick={() => setCreating(true)} disabled={disabled}>
              + New look
            </button>
          )
        }
      >
        <p className="hint">A look is a region's art kit: background planes, a ground texture and pieces. Its dressings arrange the pieces over your rooms.</p>
        <ul className="character-list look-list">
          {looks.map((b) => {
            const usage = lookUsage(project, b);
            return (
              <li key={b.id}>
                <button type="button" data-testid={`look-${b.id}`} className={b.id === look?.id && !creating ? "selected" : ""} onClick={() => {
                    setCreating(false);
                    showDressing(b.id, null);
                  }}>
                  {b.kit ? <img className="look-thumb" src={fileUrl(b.kit.backgrounds?.[0]?.file ?? b.kit.backdrop)} alt="" /> : <span className="look-thumb" />}
                  <span className="look-name">
                    {b.name}
                    <small>
                      {usage.rooms.length === 0
                        ? "not used yet"
                        : `dresses ${usage.rooms.length === 1 ? usage.rooms[0]!.name : `${usage.rooms.length} rooms`}${usage.regions.length > 0 ? ` in ${nameList(usage.regions)}` : ""}`}
                    </small>
                  </span>
                  <span className="kind">
                    {b.rooms.length} dressing{b.rooms.length === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {creating && (
          <div className="world-new">
            <h3>New look</h3>
            <label className="art-label" htmlFor="biome-theme">
              What is this place?
            </label>
            <textarea
              id="biome-theme"
              className="art-text"
              rows={3}
              placeholder="Describe the place in your own words: what it's made of, its light, weather and mood"
              value={theme}
              disabled={disabled}
              onChange={(e) => setTheme(e.target.value)}
            />
            <input className="art-text" aria-label="look name" placeholder="Name (optional)" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
            <Quality value={quality} onChange={setQuality} />
            <label className="art-label">
              Dress first
              <GameRoomSelect project={project} value={composeFor} onChange={setComposeFor} none="No room yet (preview only)" label="room to dress first" disabled={disabled} />
            </label>
            <div className="art-actions">
              <button
                type="button"
                disabled={disabled || !theme.trim()}
                onClick={async () => {
                  if (await session.startArtJob({ stage: "worldKit", brief: theme.trim(), name: name.trim() || undefined, quality, dressRoom: target })) {
                    setCreating(false);
                    setUi({ ...ui, biomeId: null, roomId: null, target: null });
                  }
                }}
              >
                Paint look + first dressing (~{approx(KIT_COST[quality])})
              </button>
              {looks.length > 0 && (
                <button type="button" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </Section>

      {look && !creating && (
        <>
          <Section id="scenery:look" title={`Look: ${look.name}`} testId="look-section">
            <LookUsageLine project={project} look={look} roomLink={roomLink} />
            <Brief text={look.brief} />
            {look.kit ? (
              <div className="art-actions">
                <span className="hint inline">{look.kit.quality === "draft" ? "Draft quality." : "Final quality."}</span>
                <button
                  type="button"
                  disabled={disabled}
                  title="Repaint the whole kit (piece ids are kept, so dressings keep working)"
                  onClick={() => void session.startArtJob({ stage: "worldKit", biomeId: look.id, quality: look.kit!.quality === "draft" ? "final" : "draft" })}
                >
                  Repaint all as {look.kit.quality === "draft" ? "final" : "draft"} (~{approx(KIT_COST[look.kit.quality === "draft" ? "final" : "draft"])})
                </button>
              </div>
            ) : (
              <div className="art-actions">
                <button type="button" disabled={disabled} onClick={() => void session.startArtJob({ stage: "worldKit", biomeId: look.id })}>
                  Paint kit
                </button>
              </div>
            )}
          </Section>

          {look.kit && (
            <Section id="scenery:pieces" title="Pieces" note={look.kit.pieces.length}>
              <p className="hint">
                {look.kit.backgrounds?.length ?? 1} background plane{(look.kit.backgrounds?.length ?? 1) === 1 ? "" : "s"}, a ground texture and {look.kit.pieces.length} pieces (
                {nameList(
                  Object.entries(
                    look.kit.pieces.reduce<Record<string, number>>((n, p) => ({ ...n, [p.kind]: (n[p.kind] ?? 0) + 1 }), {}),
                  ).map(([k, n]) => `${n} ${k}`),
                  5,
                )}
                ), on the shelf under the view: click one to place it.
              </p>
              <label className="art-label" htmlFor="repaint-part">
                Repaint one part
              </label>
              <div className="world-row">
                <select id="repaint-part" value={part} onChange={(e) => setPart(e.target.value as (typeof PARTS)[number])} aria-label="part to repaint" disabled={disabled}>
                  {PARTS.map((p) => (
                    <option key={p} value={p}>
                      {PART_TEXT[p]}
                    </option>
                  ))}
                </select>
                <input className="art-text" aria-label="repaint direction" placeholder="Direction (e.g. warmer, sunset)" value={repaintNote} disabled={disabled} onChange={(e) => setRepaintNote(e.target.value)} />
              </div>
              <div className="art-actions">
                <button type="button" disabled={disabled} onClick={() => void session.startArtJob({ stage: "worldRepaint", biomeId: look.id, part, feedback: repaintNote.trim() || undefined })}>
                  Repaint {PART_TEXT[part]}
                </button>
              </div>
            </Section>
          )}

          <Section id="scenery:dressings" title="Dressings" note={look.rooms.length} testId="dressings-section">
            <ul className="room-list dressing-list">
              {look.rooms.map((r) => {
                const over = roomsDressedBy(project, look.id, r.id);
                const old = over.filter(dressingOutOfDate);
                return (
                  <li key={r.id} className={r.id === dressing?.id ? "selected" : ""}>
                    <button type="button" data-testid={`dressing-${r.id}`} onClick={() => showDressing(look.id, r.id)}>
                      <ArtDot state={over.length === 0 ? "plain" : old.length > 0 ? "stale" : "dressed"} />
                      <span className="room-name">{r.name}</span>
                      {r.layout && (
                        <span className="tag" title="It suggests a new platform layout: open it to preview or use it">
                          layout
                        </span>
                      )}
                      {old.length > 0 && (
                        <span className="tag stale" title={`The tiles or doors of ${nameList(old.map((w) => w.name))} changed since it was composed`}>
                          recompose
                        </span>
                      )}
                      <span className="kind">{over.length === 0 ? "not used" : `→ ${nameList(over.map((w) => w.name), 1)}`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {look.kit && (
              <div className="compose-box" ref={composeRef} data-testid="compose-box">
                {sentPlain && <p className="hint sent">From Rooms: {sentPlain.name} has no scenery yet. Compose a dressing for it here.</p>}
                <label className="art-label">
                  Compose a new dressing for
                  <GameRoomSelect project={project} value={composeFor} onChange={setComposeFor} none="No room (preview only)" label="room to compose for" disabled={disabled} />
                </label>
                <input className="art-text" aria-label="dressing direction" placeholder="Direction (optional), e.g. more ruins, hanging lights" value={roomNote} disabled={disabled} onChange={(e) => setRoomNote(e.target.value)} />
                <div className="art-actions">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={async () => {
                      if (await session.startArtJob({ stage: "worldCompose", biomeId: look.id, feedback: roomNote.trim() || undefined, newLayout, dressRoom: target })) setUi({ ...ui, target: null });
                    }}
                  >
                    Compose dressing (~{approx(ART_COST_ESTIMATES.room)})
                  </button>
                  <label className="art-auto" title="Also design new platforms for the room (a suggestion you can preview and accept)">
                    <input type="checkbox" checked={newLayout} onChange={(e) => setNewLayout(e.target.checked)} /> Suggest layout
                  </label>
                </div>
              </div>
            )}
          </Section>

          {dressing && (
            <Section id="scenery:dressing" title={`This dressing: ${dressing.name}`} testId="dressing-section">
              <div className="field">
                <label className="art-label">
                  Dresses
                  <GameRoomSelect
                    project={project}
                    value={dressed[0]?.id ?? ""}
                    onChange={(id) => void dressRoomWith(id)}
                    none="No room (not used)"
                    label="game room it dresses"
                    disabled={locked}
                    ownLook={look.id}
                    ownDressing={dressing.id}
                  />
                </label>
                {dressed.length > 1 && <p className="hint">Also dresses {nameList(dressed.slice(1).map((r) => r.name), 3)}.</p>}
                {dressed.length === 0 && (
                  <p className="hint">
                    Not used by any room: previewed over {roomLink(project.world.playtest?.room ?? project.world.rooms[0]?.id ?? "", roomName(project.world.playtest?.room ?? project.world.rooms[0]?.id ?? ""))}.
                  </p>
                )}
              </div>
              {stale.length > 0 && (
                <div className="stale-box" role="status">
                  <p>
                    The tiles or doors of {nameList(stale.map((r) => r.name))} changed since this was composed: some pieces may float or sit in walls.
                  </p>
                  <button type="button" disabled={disabled} onClick={() => void session.startArtJob({ stage: "worldCompose", biomeId: look.id, roomId: dressing.id })}>
                    Recompose around the tiles now (~{approx(ART_COST_ESTIMATES.room)})
                  </button>
                </div>
              )}
              {stale.length === 0 && dressed.length > 0 && (
                <p className="hint">
                  Pieces stay where they are when a dressing moves to another room.{" "}
                  <button
                    type="button"
                    className="link-button"
                    disabled={disabled}
                    onClick={() => void session.startArtJob({ stage: "worldCompose", biomeId: look.id, roomId: dressing.id })}
                  >
                    Recompose it around {dressed[0]!.name}'s tiles (~{approx(ART_COST_ESTIMATES.room)})
                  </button>
                </p>
              )}

              <Atmosphere key={dressing.id} room={dressing} disabled={locked} onChange={(changes) => void edit("updateRoom", { assetId: look.id, roomId: dressing.id, changes })} />

              {placement ? (
                <div className="world-selection" data-testid="world-selection">
                  <h3>Selected piece: {piece?.name ?? placement.piece}</h3>
                  <div className="world-row">
                    <label title={WORLD_LAYERS[placement.layer]}>
                      Layer
                      <select
                        value={placement.layer}
                        disabled={locked}
                        aria-label="piece layer"
                        onChange={(e) => void edit("updatePlacement", { assetId: look.id, roomId: dressing.id, placementId: placement.id, changes: { layer: e.target.value as WorldLayer } })}
                      >
                        {(Object.keys(WORLD_LAYERS) as WorldLayer[])
                          .filter((l) => l !== "far")
                          .map((l) => (
                            <option key={l} value={l} title={WORLD_LAYERS[l]}>
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
                        onBlur={(e) => void edit("updatePlacement", { assetId: look.id, roomId: dressing.id, placementId: placement.id, changes: { scale: Number(e.target.value) } })}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={placement.flip}
                        disabled={locked}
                        onChange={(e) => void edit("updatePlacement", { assetId: look.id, roomId: dressing.id, placementId: placement.id, changes: { flip: e.target.checked } })}
                      />{" "}
                      Flip
                    </label>
                  </div>
                  <p className="hint">
                    x {Math.round(placement.x)}, y {Math.round(placement.y)} · drag it in the view to move it (Alt keeps it where you drop it)
                  </p>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={async () => {
                      if (await edit("removePlacement", { assetId: look.id, roomId: dressing.id, placementId: placement.id })) setSelected(null);
                    }}
                  >
                    Remove piece
                  </button>
                </div>
              ) : (
                <p className="hint">Click a piece in the view to select it; drag it to move it.</p>
              )}

              <div className="list-actions rooms-row confirm-row">
                {confirmDelete === dressing.id ? (
                  <>
                    <span className="hint">Delete {dressing.name}?{dressed.length > 0 ? ` ${nameList(dressed.map((r) => r.name))} go back to plain tiles.` : ""} Undo can restore it.</span>
                    <button
                      type="button"
                      className="danger"
                      aria-label={`delete dressing ${dressing.name}`}
                      disabled={locked}
                      onClick={() => void edit("deleteRoom", { assetId: look.id, roomId: dressing.id }).then(() => setConfirmDelete(null))}
                    >
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={locked} onClick={() => setConfirmDelete(dressing.id)}>
                    Delete dressing…
                  </button>
                )}
              </div>
            </Section>
          )}
        </>
      )}

      <Section id="scenery:generation" title="Art generation" defaultOpen={false} note={art.available ? `spent ${money(art.totalCost)}` : "off"}>
        <p className="art-meta">
          {art.available ? `Image model ${art.models.image}, vision model ${art.models.vision}. Spent ${money(art.totalCost)} so far.` : "Art generation is off: add OPENROUTER_API_KEY to the studio's .env."}
        </p>
      </Section>
      {!art.available && !creating && <p className="hint">Art generation is off, so painting and composing are unavailable (see Art generation).</p>}
      <JobLog art={art} mine={mine} lastJob={lastJob} onCancel={() => void session.cancelArtJob()} onZoom={setZoom} subject={look?.id ?? ""} />
      {zoom && <Zoom file={zoom} onClose={() => setZoom(null)} />}
    </section>
  );
}

/** Where a look is used: "Dresses Arena and Hall (The Underpass)", or not yet. */
function LookUsageLine({ project, look, roomLink }: { project: ProjectSpec; look: Look; roomLink: (id: string, name: string) => ReactNode }) {
  const usage = lookUsage(project, look);
  if (usage.rooms.length === 0) return <p className="hint">Not used by any room yet: give one of its dressings a room below.</p>;
  const shown = usage.rooms.slice(0, 4);
  return (
    <p className="look-usage" data-testid="look-usage">
      Dresses{" "}
      {shown.map((r, i) => (
        <span key={r.id}>
          {i > 0 && (i === shown.length - 1 && usage.rooms.length <= 4 ? " and " : ", ")}
          {roomLink(r.id, r.name)}
        </span>
      ))}
      {usage.rooms.length > 4 && ` and ${usage.rooms.length - 4} more`}{usage.regions.length > 0 && <span className="muted"> · {nameList(usage.regions, 3)}</span>}
    </p>
  );
}

/** The look's description, clamped to a few lines until opened. */
function Brief({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > 160;
  return (
    <p className={`look-brief${open || !long ? "" : " clamped"}`}>
      {text}
      {long && (
        <button type="button" className="link-button" onClick={() => setOpen(!open)}>
          {open ? "less" : "more"}
        </button>
      )}
    </p>
  );
}

function Quality({ value, onChange }: { value: "draft" | "final"; onChange: (q: "draft" | "final") => void }) {
  return (
    <div className="quality" role="radiogroup" aria-label="Quality">
      {(["draft", "final"] as const).map((q) => (
        <label key={q} title={q === "draft" ? "Cheapest pieces (~$0.07 per look): good for exploring" : "Better pieces (~$0.08): once you like a look"}>
          <input type="radio" name="quality" checked={value === q} onChange={() => onChange(q)} /> {q === "draft" ? "Draft" : "Final"}
        </label>
      ))}
    </div>
  );
}

type Room = NonNullable<ReturnType<typeof currentWorld>["room"]>;

/** Fog per layer, the darkness tint and dust, saved on release. */
function Atmosphere({ room, disabled, onChange }: { room: Room; disabled: boolean; onChange: (changes: object) => void }) {
  const c = room.composition;
  return (
    <div className="atmosphere">
      <h4>Atmosphere</h4>
      {(["mid", "back", "play"] as const).map((layer) => (
        <label key={layer} className="world-slider" title={`How much fog sits in front of the ${layer} layer`}>
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
      <label className="world-slider" title="The color of the dark away from lights">
        Darkness tint
        <input type="color" defaultValue={c.palette.ambient} disabled={disabled} aria-label="ambient color" onBlur={(e) => onChange({ palette: { ambient: e.target.value } })} />
      </label>
      <label className="world-slider" title="Specks floating in the air">
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
