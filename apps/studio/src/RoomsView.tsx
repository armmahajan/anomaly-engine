import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  gridCols,
  gridRows,
  MOVEMENT_ABILITIES,
  OPPOSITE,
  TILE,
  tileAt,
  type ChangeResult,
  type DoorSide,
  type MovementAbility,
  type ProjectSpec,
  type TileKind,
  type WorldRoom,
  type WorldStart,
} from "@anomaly/core";
import type { Session } from "./session.ts";
import { HandlerEditor } from "./HandlerEditor.tsx";
import { PropsOverlay } from "./PropsOverlay.tsx";
import { PropsSection } from "./PropsSection.tsx";
import { SpawnDetails } from "./SpawnDetails.tsx";
import { RegionPicker } from "./RegionPicker.tsx";

/**
 * Rooms mode: the game world's rooms. The runtime shows the selected room
 * (stage "room"); a painter over it paints tiles (one stroke = one edit) or
 * drops the spot that "Set start here", "+ Enemy here" and "Play from here"
 * use; the Prop tool hands the pointer to the props overlay. The sidebar
 * lists rooms on a small world map, with doors, enemies, props, the start
 * and the room's handlers (the game's rules are in the Game tab).
 */

export type RoomTool = TileKind | "spot" | "prop";

export interface RoomsUi {
  roomId: string | null;
  tool: RoomTool;
  /** A point in the selected room (feet, px), or null for its default. */
  spot: { x: number; y: number } | null;
  abilities: MovementAbility[];
  /** The selected prop in the room, if any. */
  propId: string | null;
}

export const initialRoomsUi: RoomsUi = { roomId: null, tool: "solid", spot: null, abilities: [], propId: null };

const TOOLS: { tool: RoomTool; label: string }[] = [
  { tool: "empty", label: "Empty" },
  { tool: "solid", label: "Solid" },
  { tool: "ledge", label: "Ledge" },
  { tool: "oneway", label: "One-way" },
  { tool: "hazard", label: "Hazard" },
  { tool: "breakable", label: "Breakable" },
  { tool: "spot", label: "📍 Spot" },
  { tool: "prop", label: "▭ Prop" },
];
const isTile = (tool: RoomTool): tool is TileKind => tool !== "spot" && tool !== "prop";

const TILE_COLOR: Record<TileKind, string> = {
  empty: "#0c0e13",
  solid: "#6b7799",
  ledge: "#a7b6dc",
  oneway: "#7fc8a9",
  hazard: "#d0504c",
  breakable: "#b39c6e",
};

export const currentRoom = (project: ProjectSpec, ui: RoomsUi): WorldRoom | null =>
  project.world.rooms.find((r) => r.id === ui.roomId) ?? project.world.rooms[0] ?? null;

/** Where "here" is: the spot, else the world's start in this room, else standing on the floor in the middle. */
export function roomSpot(project: ProjectSpec, room: WorldRoom, ui: RoomsUi): { x: number; y: number } {
  if (ui.spot) return ui.spot;
  const start = project.world.start;
  if (start?.room === room.id) return { x: start.x, y: start.y };
  const col = Math.floor(gridCols(room.grid) / 2);
  for (let row = 1; row < gridRows(room.grid); row++) {
    if (tileAt(room.grid, col, row - 1) === "empty" && tileAt(room.grid, col, row) !== "empty") return { x: col * TILE + TILE / 2, y: row * TILE };
  }
  return { x: col * TILE, y: (gridRows(room.grid) * TILE) / 2 };
}

const saveKey = (project: ProjectSpec) => `anomaly-save:${project.id}`;
function hasSave(project: ProjectSpec): boolean {
  try {
    return project.world.rules.save === "room" && localStorage.getItem(saveKey(project)) !== null;
  } catch {
    return false;
  }
}

interface BenchProps {
  project: ProjectSpec;
  session: Session;
  ui: RoomsUi;
  setUi: (ui: RoomsUi) => void;
  playing: boolean;
  ready: boolean;
  onPlay: (start: WorldStart) => void;
}

/** Main-area bar: the painter's tools and the play controls. */
export function RoomsBench({ project, session, ui, setUi, playing, ready, onPlay }: BenchProps) {
  const room = currentRoom(project, ui);
  useEffect(() => {
    if (!playing) session.setStage(room ? { mode: "room", roomId: room.id } : { mode: "game" });
  }, [session, room?.id, playing, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = project.world.start;
  const play = (from: { room: string; x: number; y: number }, resume = false) =>
    onPlay({ ...from, abilities: ui.abilities, ...(resume && { continue: true }) });

  return (
    <div className="bench" data-testid="rooms-bench">
      <div className="bench-top rooms-top">
        <div className="world-title">
          <strong>{room ? room.name : "Rooms"}</strong>
          {room && <span className="muted"> · {gridCols(room.grid)}×{gridRows(room.grid)} tiles</span>}
        </div>
        {room && (
          <div className="stage-tools" role="toolbar" aria-label="Paint">
            {TOOLS.map(({ tool, label }) => (
              <button
                key={tool}
                type="button"
                className={`tool-button${ui.tool === tool ? " selected" : ""}`}
                aria-pressed={ui.tool === tool}
                data-testid={`tool-${tool}`}
                onClick={() => setUi({ ...ui, tool })}
              >
                {isTile(tool) && <span className="swatch" style={{ background: TILE_COLOR[tool] }} />}
                {label}
              </button>
            ))}
          </div>
        )}
        {room && (
          <div className="stage-tools" aria-label="Play">
            {(Object.keys(MOVEMENT_ABILITIES) as MovementAbility[]).map((a) => (
              <label key={a} title={MOVEMENT_ABILITIES[a]}>
                <input
                  type="checkbox"
                  checked={ui.abilities.includes(a)}
                  onChange={(e) => setUi({ ...ui, abilities: e.target.checked ? [...ui.abilities, a] : ui.abilities.filter((x) => x !== a) })}
                />
                {a.replace("_", " ")}
              </label>
            ))}
            <button type="button" disabled={playing || !ready} onClick={() => play({ room: room.id, ...roomSpot(project, room, ui) })}>
              ▶ Play from here
            </button>
            {start && (
              <button type="button" disabled={playing || !ready} onClick={() => play(start)}>
                ▶ From start
              </button>
            )}
            {start && hasSave(project) && (
              <button type="button" disabled={playing || !ready} onClick={() => play(start, true)} title="Resume the run saved in this browser">
                Continue
              </button>
            )}
          </div>
        )}
      </div>
      {!room && <div className="world-empty">No rooms yet. Add one from the sidebar.</div>}
    </div>
  );
}

interface PainterProps {
  project: ProjectSpec;
  session: Session;
  ui: RoomsUi;
  setUi: (ui: RoomsUi) => void;
  locked: boolean;
}

/**
 * Over the runtime's view of the room (the runtime fits the room to 95% of
 * the view, centred; this matches it): paints tiles by click or drag, or
 * drops the spot.
 */
export function RoomPainter({ project, session, ui, setUi, locked }: PainterProps) {
  const room = currentRoom(project, ui);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ width: 0, height: 0 });
  // The stroke being painted (cells by "c,r"); a ref, as pointer events can outpace renders.
  const stroke = useRef(new Map<string, [number, number]>());
  const [, redraw] = useState(0);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const drawing = useRef<{ last: [number, number] } | null>(null);

  useEffect(() => {
    const box = boxRef.current!;
    const observer = new ResizeObserver(() => setView({ width: box.clientWidth, height: box.clientHeight }));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const cols = room ? gridCols(room.grid) : 0;
  const rows = room ? gridRows(room.grid) : 0;
  const scale = room && view.width > 0 ? Math.min(view.width / (cols * TILE), view.height / (rows * TILE)) * 0.95 : 0;
  const size = { width: cols * TILE * scale, height: rows * TILE * scale };
  const spot = room ? roomSpot(project, room, ui) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !room) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    const g = canvas.getContext("2d")!;
    g.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0);
    g.clearRect(0, 0, cols * TILE, rows * TILE);
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.lineWidth = 1 / scale;
    g.beginPath();
    for (let c = 1; c < cols; c++) g.moveTo(c * TILE, 0), g.lineTo(c * TILE, rows * TILE);
    for (let r = 1; r < rows; r++) g.moveTo(0, r * TILE), g.lineTo(cols * TILE, r * TILE);
    g.stroke();
    if (isTile(ui.tool)) {
      g.fillStyle = TILE_COLOR[ui.tool];
      g.globalAlpha = 0.75;
      for (const [c, r] of stroke.current.values()) g.fillRect(c * TILE, r * TILE, TILE, TILE);
      g.globalAlpha = 1;
    }
    if (hover) {
      g.strokeStyle = "#ffffff";
      g.lineWidth = 2 / scale;
      g.strokeRect(hover[0] * TILE, hover[1] * TILE, TILE, TILE);
    }
    if (spot) {
      g.fillStyle = "#7aa2f7";
      g.beginPath();
      g.arc(spot.x, spot.y - 22, 7, 0, Math.PI * 2);
      g.fill();
      g.fillRect(spot.x - 1.5, spot.y - 22, 3, 22);
    }
  });

  if (!room) return <div ref={boxRef} className="room-painter" />;

  const cellAt = (e: ReactPointerEvent): [number, number] | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const c = Math.floor(x / TILE);
    const r = Math.floor(y / TILE);
    return c >= 0 && r >= 0 && c < cols && r < rows ? [c, r] : null;
  };
  /** Add the cells on the line between two cells (a fast drag skips cells between events). */
  const add = (from: [number, number], to: [number, number]) => {
    const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), 1);
    for (let i = 0; i <= steps; i++) {
      const c = Math.round(from[0] + ((to[0] - from[0]) * i) / steps);
      const r = Math.round(from[1] + ((to[1] - from[1]) * i) / steps);
      stroke.current.set(`${c},${r}`, [c, r]);
    }
    redraw((n) => n + 1);
  };

  const onDown = (e: ReactPointerEvent) => {
    if (locked || e.button !== 0 || ui.tool === "prop") return;
    const cell = cellAt(e);
    if (!cell) return;
    if (ui.tool === "spot") {
      const rect = canvasRef.current!.getBoundingClientRect();
      setUi({ ...ui, spot: { x: Math.round((e.clientX - rect.left) / scale), y: (cell[1] + 1) * TILE } });
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    drawing.current = { last: cell };
    stroke.current = new Map();
    add(cell, cell);
  };
  const onMove = (e: ReactPointerEvent) => {
    const cell = cellAt(e);
    setHover(cell);
    if (!drawing.current || !cell) return;
    add(drawing.current.last, cell);
    drawing.current.last = cell;
  };
  const onUp = async () => {
    if (!drawing.current || !isTile(ui.tool)) return;
    drawing.current = null;
    const kind = ui.tool;
    const cells = [...stroke.current.values()].filter(([c, r]) => tileAt(room.grid, c, r) !== kind);
    if (cells.length > 0) {
      const result = await session.applyOperation("paintTiles", { roomId: room.id, kind, cells });
      if (!result.ok) session.reportProblem(result.error.message);
    }
    stroke.current = new Map();
    redraw((n) => n + 1);
  };

  return (
    <div ref={boxRef} className="room-painter">
      <canvas
        ref={canvasRef}
        data-testid="room-painter"
        data-cols={cols}
        data-rows={rows}
        className={locked ? "locked" : ""}
        style={{ left: (view.width - size.width) / 2, top: (view.height - size.height) / 2, width: size.width, height: size.height }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => void onUp()}
        onPointerLeave={() => setHover(null)}
      />
      <div className="props-overlay" style={{ left: (view.width - size.width) / 2, top: (view.height - size.height) / 2, width: size.width, height: size.height, pointerEvents: ui.tool === "prop" ? "auto" : "none" }}>
        <PropsOverlay project={project} session={session} room={room} ui={ui} setUi={setUi} locked={locked} scale={scale} active={ui.tool === "prop"} />
      </div>
    </div>
  );
}

interface PanelProps {
  project: ProjectSpec;
  session: Session;
  ui: RoomsUi;
  setUi: (ui: RoomsUi) => void;
  locked: boolean;
}

/** Sidebar: rooms and the world map, the selected room's doors, enemies and start, and the rules. */
export function RoomsPanel({ project, session, ui, setUi, locked }: PanelProps) {
  const room = currentRoom(project, ui);
  const [name, setName] = useState("");
  const [door, setDoor] = useState<{ side: DoorSide; offset: number; size: number }>({ side: "right", offset: 1, size: 3 });
  const enemies = project.characters.filter((c) => c.kind === "enemy");
  const [enemy, setEnemy] = useState(enemies[0]?.id ?? "");
  const report = (result: ChangeResult) => {
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  const edit = async (op: string, input: unknown) => report(await session.applyOperation(op, input));
  const select = (roomId: string) => setUi({ ...ui, roomId, spot: null });
  const spot = room ? roomSpot(project, room, ui) : null;

  const addRoom = async () => {
    const before = new Set(project.world.rooms.map((r) => r.id));
    const result = await session.applyOperation("createWorldRoom", { name: name.trim() || `Room ${project.world.rooms.length + 1}`, cols: 30, rows: 17 });
    if (!report(result) || !result.ok) return;
    const created = result.project.world.rooms.find((r) => !before.has(r.id));
    if (created) select(created.id);
    setName("");
  };

  return (
    <section className="rooms-panel" data-testid="rooms-panel">
      <h2>Rooms</h2>
      <WorldMap project={project} selected={room?.id ?? null} onSelect={select} />
      <ul className="character-list">
        {project.world.rooms.map((r) => (
          <li key={r.id}>
            <button type="button" data-testid={`room-${r.id}`} className={r.id === room?.id ? "selected" : ""} onClick={() => select(r.id)}>
              {r.name}
              {project.world.start?.room === r.id && <span className="tag">start</span>}
              {project.world.playtest?.room === r.id && <span className="tag">playtest</span>}
              <span className="kind">
                {gridCols(r.grid)}×{gridRows(r.grid)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="list-actions">
        <input className="art-text" aria-label="new room name" placeholder="New room name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={() => void addRoom()} disabled={locked}>
          + Room
        </button>
      </div>

      {room && (
        <>
          <h3>Room</h3>
          <div className="field">
            <label htmlFor="room-name">Name</label>
            <input
              id="room-name"
              key={`${room.id}:${room.name}`}
              defaultValue={room.name}
              disabled={locked}
              onKeyDown={(e) => e.key === "Enter" && void edit("updateWorldRoom", { roomId: room.id, changes: { name: e.currentTarget.value } })}
            />
          </div>
          <SizeEditor key={`${room.id}:${gridCols(room.grid)}x${gridRows(room.grid)}`} room={room} locked={locked} onResize={(cols, rows) => void edit("resizeWorldRoom", { roomId: room.id, cols, rows })} />
          <RegionPicker project={project} session={session} room={room} locked={locked} />

          <h3>Doors</h3>
          {room.doors.map((d) => {
            const targets = project.world.rooms.flatMap((r) =>
              r.id === room.id ? [] : r.doors.filter((t) => t.side === OPPOSITE[d.side]).map((t) => ({ value: `${r.id}/${t.id}`, label: `${r.name} · ${t.id}` })),
            );
            return (
              <div key={d.id} className="spawn" data-testid={`door-${d.id}`}>
                <span className="spawn-id">
                  {d.id} · {d.side} {d.offset}+{d.size}
                </span>
                <select
                  aria-label={`${d.id} leads to`}
                  value={d.to ? `${d.to.room}/${d.to.door}` : ""}
                  disabled={locked}
                  onChange={(e) => {
                    const [roomId, doorId] = e.target.value.split("/");
                    void edit("connectDoors", { from: { roomId: room.id, doorId: d.id }, to: roomId ? { roomId, doorId } : null });
                  }}
                >
                  <option value="">— not connected —</option>
                  {targets.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="icon-button" aria-label={`remove ${d.id}`} disabled={locked} onClick={() => void edit("removeDoor", { roomId: room.id, doorId: d.id })}>
                  ✕
                </button>
              </div>
            );
          })}
          <div className="spawn">
            <select aria-label="door side" value={door.side} disabled={locked} onChange={(e) => setDoor({ ...door, side: e.target.value as DoorSide })}>
              {(["left", "right", "top", "bottom"] as const).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <NumberBox label="door offset" value={door.offset} onChange={(offset) => setDoor({ ...door, offset })} />
            <NumberBox label="door size" value={door.size} onChange={(size) => setDoor({ ...door, size })} />
            <button type="button" disabled={locked} onClick={() => void edit("setDoor", { roomId: room.id, door })}>
              + Door
            </button>
          </div>
          <p className="hint">Offset: tiles from the top (left/right doors) or the left (top/bottom).</p>

          <h3>Enemies</h3>
          {room.spawns.map((s) => (
            <div key={s.id}>
              <div className="spawn">
                <span className="spawn-id">
                  {s.id} ({Math.round(s.x)}, {Math.round(s.y)})
                </span>
                <button type="button" className="icon-button" aria-label={`remove ${s.id}`} disabled={locked} onClick={() => void edit("removeRoomSpawn", { roomId: room.id, spawnId: s.id })}>
                  ✕
                </button>
              </div>
              <SpawnDetails project={project} session={session} room={room} spawn={s} locked={locked} />
            </div>
          ))}
          <div className="spawn">
            <select aria-label="enemy" value={enemy} disabled={locked} onChange={(e) => setEnemy(e.target.value)}>
              {enemies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={locked || !enemy || !spot} onClick={() => void edit("addRoomSpawn", { roomId: room.id, characterId: enemy, ...spot })}>
              + Enemy at spot
            </button>
          </div>

          <PropsSection project={project} session={session} room={room} ui={ui} setUi={setUi} locked={locked} />

          <h3>Room handlers</h3>
          <HandlerEditor
            handlers={room.handlers}
            scope="room"
            project={project}
            room={room}
            locked={locked}
            label={`room ${room.id}`}
            onChange={(handlers) => void edit("setHandlers", { roomId: room.id, handlers })}
          />

          <h3>Start</h3>
          <p className="hint">
            {project.world.start ? `The game starts in ${project.world.start.room} at (${Math.round(project.world.start.x)}, ${Math.round(project.world.start.y)}).` : "No start yet."} Drop the
            spot with 📍, then:
          </p>
          <div className="list-actions rooms-row">
            <button type="button" disabled={locked || !spot} onClick={() => void edit("setWorldStart", { roomId: room.id, ...spot })}>
              Set start here
            </button>
            <button type="button" disabled={locked || !spot} title="Where ▶ Play in the Playtest tab starts" onClick={() => void edit("setPlaytest", { roomId: room.id, ...spot })}>
              Playtest here
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => window.confirm(`Delete ${room.name}? (Undo can restore it.)`) && void edit("deleteWorldRoom", { roomId: room.id }).then((ok) => ok && setUi({ ...ui, roomId: null, spot: null }))}
            >
              Delete room
            </button>
          </div>
        </>
      )}

    </section>
  );
}

function NumberBox({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <input
      className="number-box"
      type="number"
      min={0}
      aria-label={label}
      title={label}
      value={value}
      onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
    />
  );
}

function SizeEditor({ room, locked, onResize }: { room: WorldRoom; locked: boolean; onResize: (cols: number, rows: number) => void }) {
  const [cols, setCols] = useState(gridCols(room.grid));
  const [rows, setRows] = useState(gridRows(room.grid));
  const changed = cols !== gridCols(room.grid) || rows !== gridRows(room.grid);
  return (
    <div className="spawn">
      <span className="spawn-id">Size (tiles)</span>
      <NumberBox label="room columns" value={cols} onChange={setCols} />
      <NumberBox label="room rows" value={rows} onChange={setRows} />
      <button type="button" disabled={locked || !changed} onClick={() => onResize(cols, rows)}>
        Resize
      </button>
    </div>
  );
}

/** Rooms where they sit on the world map (`at`, in tiles), with lines for connected doors. */
function WorldMap({ project, selected, onSelect }: { project: ProjectSpec; selected: string | null; onSelect: (id: string) => void }) {
  const rooms = project.world.rooms;
  if (rooms.length === 0) return null;
  const box = (r: WorldRoom) => ({ x: r.at.x, y: r.at.y, w: gridCols(r.grid), h: gridRows(r.grid) });
  const minX = Math.min(...rooms.map((r) => r.at.x));
  const minY = Math.min(...rooms.map((r) => r.at.y));
  const maxX = Math.max(...rooms.map((r) => r.at.x + gridCols(r.grid)));
  const maxY = Math.max(...rooms.map((r) => r.at.y + gridRows(r.grid)));
  const doorPoint = (r: WorldRoom, side: DoorSide, offset: number, size: number) => {
    const b = box(r);
    const mid = offset + size / 2;
    return side === "left" ? [b.x, b.y + mid] : side === "right" ? [b.x + b.w, b.y + mid] : side === "top" ? [b.x + mid, b.y] : [b.x + mid, b.y + b.h];
  };
  const links = rooms.flatMap((r) =>
    r.doors.flatMap((d) => {
      const other = d.to && rooms.find((o) => o.id === d.to!.room);
      const target = other?.doors.find((t) => t.id === d.to!.door);
      if (!other || !target || `${r.id}/${d.id}` > `${other.id}/${target.id}`) return [];
      return [[doorPoint(r, d.side, d.offset, d.size), doorPoint(other, target.side, target.offset, target.size)]];
    }),
  );
  const pad = 4;
  return (
    <svg className="world-map" viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`} aria-label="World map">
      {rooms.map((r) => {
        const b = box(r);
        return (
          <g key={r.id} onClick={() => onSelect(r.id)} className={r.id === selected ? "selected" : ""}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} />
            <text x={b.x + 1.5} y={b.y + 5}>
              {r.name}
            </text>
          </g>
        );
      })}
      {links.map(([a, b], i) => (
        <line key={i} x1={a![0]} y1={a![1]} x2={b![0]} y2={b![1]} />
      ))}
    </svg>
  );
}
