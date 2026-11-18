import { useEffect, useRef } from "react";
import { dressingOutOfDate, kitFiles, worldRoomFor, worldSceneFor, WORLD_LAYERS, type BiomeAsset, type ProjectSpec, type WorldLayer } from "@anomaly/core";
import { fileUrl } from "./api.ts";
import type { Session } from "./session.ts";
import { looksOf, roomsDressedBy } from "./worlds/scenery.ts";
import "./worlds-rooms.css";

/**
 * Scenery mode workbench (main area): a layer bar over a dressing drawn over
 * its game room (the runtime's world stage: drag to pan, wheel to zoom, click
 * a piece to select it, drag it to move it) and the look's kit shelf below.
 * The sidebar (WorldPanel) holds the looks, their dressings, atmosphere and
 * the selected piece. In code a look is a biome and a dressing a biome room.
 */

export interface WorldUi {
  /** The look (biome) shown. */
  biomeId: string | null;
  /** The dressing (biome room) shown. */
  roomId: string | null;
  hidden: WorldLayer[];
  fog: boolean;
  lights: boolean;
  exploded: boolean;
  /** Show the dressing's suggested layout instead of its room's. */
  previewLayout: boolean;
  /** The game room a new dressing is composed for (set when Rooms sends a room here). */
  target?: string | null;
}

export const LAYERS: { id: WorldLayer; label: string }[] = [
  { id: "far", label: "Far" },
  { id: "mid", label: "Mid" },
  { id: "back", label: "Back" },
  { id: "play", label: "Play" },
  { id: "front", label: "Front" },
];

export const biomesOf = looksOf;

/** The look and dressing the workbench shows (falls back to the newest look / its newest dressing). */
export function currentWorld(project: ProjectSpec, ui: WorldUi): { biome: BiomeAsset | null; room: BiomeAsset["rooms"][number] | null } {
  const biomes = biomesOf(project);
  const biome = biomes.find((b) => b.id === ui.biomeId) ?? biomes.at(-1) ?? null;
  const room = biome?.rooms.find((r) => r.id === ui.roomId) ?? biome?.rooms.at(-1) ?? null;
  return { biome, room };
}

interface Props {
  project: ProjectSpec;
  session: Session;
  ui: WorldUi;
  setUi: (ui: WorldUi) => void;
  selected: string | null;
  locked: boolean;
  onPlacePiece: (pieceId: string) => void;
  /** Open a game room in the Rooms tab. */
  onOpenRoom?: (roomId: string) => void;
}

export function WorldBench({ project, session, ui, setUi, selected, locked, onPlacePiece, onOpenRoom }: Props) {
  const { biome, room } = currentWorld(project, ui);
  const scene = biome && room ? worldSceneFor(project, biome.id, room.id, ui.previewLayout && room.layout !== null) : null;
  const sceneKey = scene ? JSON.stringify(scene) : "";

  // Show the dressing in the runtime (images first, once each).
  useEffect(() => {
    if (!scene || !biome || !room) {
      session.setStage({ mode: "game" });
      return;
    }
    void session.showWorld(
      {
        mode: "world",
        scene,
        hidden: ui.hidden,
        fog: ui.fog,
        lights: ui.lights,
        exploded: ui.exploded,
        selected,
        editable: !locked,
      },
      kitFiles(scene),
      { biomeId: biome.id, roomId: room.id },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sceneKey, ui.hidden.join(), ui.fog, ui.lights, ui.exploded, selected, locked]);

  // The layer legend closes on a click elsewhere.
  const legendRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      const legend = legendRef.current;
      if (legend?.open && !legend.contains(e.target as Node)) legend.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const toggle = (layer: WorldLayer) =>
    setUi({ ...ui, hidden: ui.hidden.includes(layer) ? ui.hidden.filter((l) => l !== layer) : [...ui.hidden, layer] });
  /** The game room the dressing is drawn over: one it dresses, else (a preview) the playtest room. */
  const shownOver = biome && room ? worldRoomFor(project, biome.id, room.id) : null;
  const dresses = biome && room ? roomsDressedBy(project, biome.id, room.id) : [];
  const roomLink = (id: string, name: string) =>
    onOpenRoom ? (
      <button type="button" className="link-button" title={`Open ${name} in Rooms`} onClick={() => onOpenRoom(id)}>
        {name} ↗
      </button>
    ) : (
      <strong>{name}</strong>
    );

  return (
    <div className="bench" data-testid="world-bench">
      <div className="bench-top scenery-top">
        <div className="world-title" data-testid="scenery-title">
          {biome ? (
            <>
              <span className="muted">Look</span>
              <strong>{biome.name}</strong>
              {biome.kit && (
                <span className="tag" title={biome.kit.quality === "draft" ? "Painted at draft quality: repaint it as final once you like it" : "Painted at final quality"}>
                  {biome.kit.quality}
                </span>
              )}
              {room && (
                <>
                  <span className="muted">› Dressing</span>
                  <strong>{room.name}</strong>
                  {dresses.length > 0 ? (
                    <span className="scenery-over">
                      <span className="muted">dresses</span> {roomLink(dresses[0]!.id, dresses[0]!.name)}
                      {dresses.length > 1 && <span className="muted"> +{dresses.length - 1}</span>}
                      {dresses.some(dressingOutOfDate) && (
                        <span className="tag stale" title="Its room's tiles or doors changed since it was composed: recompose it from the sidebar">
                          needs recompose
                        </span>
                      )}
                    </span>
                  ) : (
                    shownOver && (
                      <span className="scenery-over unused" title="No game room uses this dressing: it is shown over the playtest room's tiles. Pick its room in the sidebar.">
                        not used · previewed over {roomLink(shownOver.id, shownOver.name)}
                      </span>
                    )
                  )}
                </>
              )}
            </>
          ) : (
            <strong>Scenery</strong>
          )}
        </div>
        {scene && (
          <div className="tool-groups">
            <div className="tool-group" role="group" aria-label="Layers">
              <span className="tool-group-label" title="The dressing's depth layers, back to front: untick one to hide it">
                Layers
              </span>
              {LAYERS.map((l) => (
                <label key={l.id} title={`${l.label}: ${WORLD_LAYERS[l.id]}`}>
                  <input type="checkbox" checked={!ui.hidden.includes(l.id)} onChange={() => toggle(l.id)} aria-label={`${l.label} layer`} /> {l.label}
                </label>
              ))}
            </div>
            <div className="tool-group" role="group" aria-label="View">
              <span className="tool-group-label">View</span>
              <label title="The fog between the layers (the dressing's atmosphere)">
                <input type="checkbox" checked={ui.fog} onChange={(e) => setUi({ ...ui, fog: e.target.checked })} /> Fog
              </label>
              <label title="Darkness and the glow around light pieces">
                <input type="checkbox" checked={ui.lights} onChange={(e) => setUi({ ...ui, lights: e.target.checked })} /> Lights
              </label>
              <label title="Tilt the layers apart to see how the depth is built">
                <input type="checkbox" checked={ui.exploded} onChange={(e) => setUi({ ...ui, exploded: e.target.checked })} /> Exploded
              </label>
              <details className="layer-legend" ref={legendRef}>
                <summary title="What the layers are" aria-label="What the layers are">
                  ?
                </summary>
                <div className="layer-legend-body" role="note">
                  <strong>Layers, back to front</strong>
                  <dl>
                    {LAYERS.map((l) => (
                      <div key={l.id}>
                        <dt>{l.label}</dt>
                        <dd>{WORLD_LAYERS[l.id]}</dd>
                      </div>
                    ))}
                  </dl>
                  <p>
                    <strong>Fog</strong> and <strong>Lights</strong> only change this view; the sidebar's Atmosphere sets them for the game. <strong>Exploded</strong> tilts the layers apart.
                  </p>
                </div>
              </details>
            </div>
          </div>
        )}
      </div>

      {room?.layout && (
        <div className="world-banner" role="status">
          This dressing suggests a new platform layout{shownOver ? ` for ${shownOver.name}` : ""}.
          <label>
            <input type="checkbox" checked={ui.previewLayout} onChange={(e) => setUi({ ...ui, previewLayout: e.target.checked })} /> Preview it
          </label>
          <button
            type="button"
            disabled={locked}
            onClick={async () => {
              const result = await session.applyOperation("applyRoomLayout", { assetId: biome!.id, roomId: room.id, worldRoomId: shownOver?.id });
              if (!result.ok) session.reportProblem(result.error.message);
              else setUi({ ...ui, previewLayout: false });
            }}
          >
            Use this layout
          </button>
        </div>
      )}

      {!scene && (
        <div className="world-empty">
          {biome && !biome.kit
            ? `${biome.name} has no kit yet: paint it from the sidebar.`
            : biome
              ? `Compose a dressing from ${biome.name} for one of your rooms in the sidebar.`
              : "Scenery is the art drawn over your rooms. Describe a place in the sidebar to paint a look: layered background planes, a ground texture and pieces (structures, props, lights) for about $0.07. Each room is then dressed with an arrangement of those pieces for about $0.005."}
        </div>
      )}

      <div className="bench-bottom">
        {biome?.kit && (
          <div className="kit-shelf" aria-label="Kit">
            <div className="kit-shelf-label">
              <strong>{biome.name} kit</strong>
              <span>{room ? "Click a piece to place it in the view" : "Compose a dressing to place pieces"}</span>
            </div>
            {(biome.kit.backgrounds?.length ? biome.kit.backgrounds : [{ name: "backdrop", file: biome.kit.backdrop, depth: 0.12 }]).map((plane) => (
              <figure key={plane.name} title={`Background plane "${plane.name}" (scrolls at ${plane.depth} of the camera)`}>
                <img src={fileUrl(plane.file)} alt={plane.name} className="kit-wide" />
                <figcaption>{plane.name}</figcaption>
              </figure>
            ))}
            <figure title="Ground texture (drawn on the tiles)">
              <img src={fileUrl(biome.kit.ground)} alt="ground" />
              <figcaption>ground</figcaption>
            </figure>
            <span className="tool-sep tall" />
            {biome.kit.pieces.map((p) => (
              <button
                key={p.id}
                type="button"
                className="kit-piece"
                disabled={locked || !room}
                title={`${p.name} (${p.kind}): click to place it in the middle of the view`}
                onClick={() => onPlacePiece(p.id)}
                data-testid={`piece-${p.id}`}
              >
                <img src={fileUrl(p.file)} alt={p.name} />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
