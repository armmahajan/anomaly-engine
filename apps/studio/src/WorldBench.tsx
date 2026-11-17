import { useEffect } from "react";
import { worldRoomFor, worldSceneFor, type BiomeAsset, type ProjectSpec, type WorldLayer } from "@anomaly/core";
import { fileUrl } from "./api.ts";
import type { Session } from "./session.ts";

/**
 * Worlds mode workbench (main area): a layer bar over the live room (the
 * runtime's world stage: drag to pan, wheel to zoom, click a piece to select
 * it, drag it to move it) and the biome's kit shelf below. The sidebar
 * (WorldPanel) holds generation, rooms, atmosphere and the selected piece.
 */

export interface WorldUi {
  biomeId: string | null;
  roomId: string | null;
  hidden: WorldLayer[];
  fog: boolean;
  lights: boolean;
  exploded: boolean;
  /** Show the room's suggested layout instead of its room's. */
  previewLayout: boolean;
}

export const LAYERS: { id: WorldLayer; label: string }[] = [
  { id: "far", label: "Far" },
  { id: "mid", label: "Mid" },
  { id: "back", label: "Back" },
  { id: "play", label: "Play" },
  { id: "front", label: "Front" },
];

export function biomesOf(project: ProjectSpec): BiomeAsset[] {
  return project.art.assets.filter((a): a is BiomeAsset => a.kind === "biome");
}

/** The biome and room the workbench shows (falls back to the first biome / latest room). */
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
}

export function WorldBench({ project, session, ui, setUi, selected, locked, onPlacePiece }: Props) {
  const { biome, room } = currentWorld(project, ui);
  const scene = biome && room ? worldSceneFor(project, biome.id, room.id, ui.previewLayout && room.layout !== null) : null;
  const sceneKey = scene ? JSON.stringify(scene) : "";

  // Show the room in the runtime (images first, once each).
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
      [scene.backdrop, scene.ground, ...scene.pieces.map((p) => p.file)],
      { biomeId: biome.id, roomId: room.id },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sceneKey, ui.hidden.join(), ui.fog, ui.lights, ui.exploded, selected, locked]);

  const toggle = (layer: WorldLayer) =>
    setUi({ ...ui, hidden: ui.hidden.includes(layer) ? ui.hidden.filter((l) => l !== layer) : [...ui.hidden, layer] });
  const dressed = biome && room ? worldRoomFor(project, biome.id, room.id) : null;

  return (
    <div className="bench" data-testid="world-bench">
      <div className="bench-top">
        <div className="world-title">
          {biome ? (
            <>
              <strong>{biome.name}</strong>
              {room && <span> · {room.name}</span>}
              {dressed && <span className="tag">{dressed.name}</span>}
              {biome.kit && <span className="tag">{biome.kit.quality}</span>}
            </>
          ) : (
            <strong>Worlds</strong>
          )}
        </div>
        {scene && (
          <div className="stage-tools" aria-label="Layers">
            {LAYERS.map((l) => (
              <label key={l.id} title={`Show the ${l.label.toLowerCase()} layer`}>
                <input type="checkbox" checked={!ui.hidden.includes(l.id)} onChange={() => toggle(l.id)} aria-label={`${l.label} layer`} /> {l.label}
              </label>
            ))}
            <span className="tool-sep" />
            <label>
              <input type="checkbox" checked={ui.fog} onChange={(e) => setUi({ ...ui, fog: e.target.checked })} /> Fog
            </label>
            <label>
              <input type="checkbox" checked={ui.lights} onChange={(e) => setUi({ ...ui, lights: e.target.checked })} /> Lights
            </label>
            <label title="Tilt the layers apart to see how the depth is built">
              <input type="checkbox" checked={ui.exploded} onChange={(e) => setUi({ ...ui, exploded: e.target.checked })} /> Exploded
            </label>
          </div>
        )}
      </div>

      {room?.layout && (
        <div className="world-banner" role="status">
          This room suggests a new platform layout.
          <label>
            <input type="checkbox" checked={ui.previewLayout} onChange={(e) => setUi({ ...ui, previewLayout: e.target.checked })} /> Preview it
          </label>
          <button
            type="button"
            disabled={locked}
            onClick={async () => {
              const result = await session.applyOperation("applyRoomLayout", { assetId: biome!.id, roomId: room.id, worldRoomId: dressed?.id });
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
              ? `Compose a room for ${biome.name} from the sidebar.`
              : "Describe a place in the sidebar and paint its kit: a backdrop, two sheets of pieces and a ground texture for about $0.017. Rooms built from it cost about $0.004 each."}
        </div>
      )}

      <div className="bench-bottom">
        {biome?.kit && (
          <div className="kit-shelf" aria-label="Kit">
            <figure title="Backdrop (far layer)">
              <img src={fileUrl(biome.kit.backdrop)} alt="backdrop" className="kit-wide" />
              <figcaption>backdrop</figcaption>
            </figure>
            <figure title="Ground texture">
              <img src={fileUrl(biome.kit.ground)} alt="ground" />
              <figcaption>ground</figcaption>
            </figure>
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
