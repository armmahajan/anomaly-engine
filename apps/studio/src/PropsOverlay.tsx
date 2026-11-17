import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { gridCols, gridRows, TILE, type ProjectSpec, type Prop, type WorldRoom } from "@anomaly/core";
import type { Session } from "./session.ts";
import type { RoomsUi } from "./RoomsView.tsx";

export interface PropsOverlayProps {
  project: ProjectSpec;
  session: Session;
  room: WorldRoom;
  ui: RoomsUi;
  setUi: (ui: RoomsUi) => void;
  locked: boolean;
  /** Screen px per room px; the overlay box covers the room exactly. */
  scale: number;
  /** The Prop tool is selected: the overlay takes the pointer (place, select, move, resize). */
  active: boolean;
}

const SNAP = 8;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const MIN = 8;

type Rect = { x: number; y: number; width: number; height: number };
/** The gesture in progress: drawing a new prop from `from`, or moving / resizing one. */
type Drag = { kind: "create"; from: { x: number; y: number }; rect: Rect } | { kind: "move" | "resize"; id: string; grab: { x: number; y: number }; start: Rect; rect: Rect };

/** Over the room painter: draws the room's props and, with the Prop tool, places, selects, moves and resizes them (one edit per gesture). */
export function PropsOverlay({ session, room, ui, setUi, locked, scale, active }: PropsOverlayProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const width = gridCols(room.grid) * TILE;
  const height = gridRows(room.grid) * TILE;
  if (scale <= 0) return null;

  const point = (e: ReactPointerEvent) => {
    const box = (e.currentTarget as Element).closest("svg")!.getBoundingClientRect();
    return { x: (e.clientX - box.left) / scale, y: (e.clientY - box.top) / scale };
  };
  const edit = async (name: string, input: unknown) => {
    const result = await session.applyOperation(name, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result;
  };

  const begin = (e: ReactPointerEvent, next: Drag) => {
    if (!active || locked || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).closest("svg")!.setPointerCapture(e.pointerId);
    setDrag(next);
  };
  const onBackground = (e: ReactPointerEvent) => {
    const at = point(e);
    const from = { x: snap(at.x), y: snap(at.y) };
    begin(e, { kind: "create", from, rect: { ...from, width: 0, height: 0 } });
  };
  const onProp = (e: ReactPointerEvent, prop: Prop, kind: "move" | "resize") => {
    if (!active || locked) return;
    if (ui.propId !== prop.id) setUi({ ...ui, propId: prop.id });
    const start = { x: prop.x, y: prop.y, width: prop.width, height: prop.height };
    begin(e, { kind, id: prop.id, grab: point(e), start, rect: start });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const at = point(e);
    if (drag.kind === "create") {
      const x2 = snap(at.x);
      const y2 = snap(at.y);
      setDrag({ ...drag, rect: { x: Math.min(drag.from.x, x2), y: Math.min(drag.from.y, y2), width: Math.abs(x2 - drag.from.x), height: Math.abs(y2 - drag.from.y) } });
    } else if (drag.kind === "move") {
      setDrag({ ...drag, rect: { ...drag.start, x: snap(drag.start.x + at.x - drag.grab.x), y: snap(drag.start.y + at.y - drag.grab.y) } });
    } else {
      const s = drag.start;
      setDrag({ ...drag, rect: { ...s, width: Math.max(MIN, snap(s.x + s.width + at.x - drag.grab.x) - s.x), height: Math.max(MIN, snap(s.y + s.height + at.y - drag.grab.y) - s.y) } });
    }
  };
  const onUp = async () => {
    if (!drag) return;
    setDrag(null);
    const { rect } = drag;
    if (drag.kind === "create") {
      if (rect.width < MIN || rect.height < MIN) return setUi({ ...ui, propId: null }); // a click on empty space deselects
      const before = new Set(room.props.map((p) => p.id));
      const result = await edit("addProp", { roomId: room.id, ...rect });
      const added = result.ok && result.project.world.rooms.find((r) => r.id === room.id)?.props.find((p) => !before.has(p.id));
      if (added) setUi({ ...ui, propId: added.id });
      return;
    }
    const s = drag.start;
    if (rect.x === s.x && rect.y === s.y && rect.width === s.width && rect.height === s.height) return;
    const changes = drag.kind === "move" ? { x: rect.x, y: rect.y } : { width: rect.width, height: rect.height };
    await edit("updateProp", { roomId: room.id, propId: drag.id, changes });
  };

  const shown = (prop: Prop): Rect => (drag && drag.kind !== "create" && drag.id === prop.id ? drag.rect : prop);
  const handle = 10 / scale;
  return (
    <svg
      className={`props-svg${active ? " active" : ""}`}
      data-testid="props-overlay"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="100%"
      onPointerDown={onBackground}
      onPointerMove={onMove}
      onPointerUp={() => void onUp()}
    >
      {room.props.map((prop) => {
        const r = shown(prop);
        const selected = prop.id === ui.propId;
        const conditional = prop.visible !== true || typeof prop.solid !== "boolean";
        return (
          <g key={prop.id} className={`prop-shape${selected ? " selected" : ""}${conditional ? " conditional" : ""}`} data-testid={`prop-shape-${prop.id}`}>
            <rect x={r.x} y={r.y} width={r.width} height={r.height} fill={prop.color} strokeWidth={(selected ? 2 : 1) / scale} onPointerDown={(e) => onProp(e, prop, "move")} />
            <text x={r.x + 2 / scale} y={r.y - 3 / scale} fontSize={11 / scale}>
              {prop.name ?? prop.id}
            </text>
            {selected && active && (
              <rect className="prop-handle" data-testid="prop-handle" x={r.x + r.width - handle / 2} y={r.y + r.height - handle / 2} width={handle} height={handle} onPointerDown={(e) => onProp(e, prop, "resize")} />
            )}
          </g>
        );
      })}
      {drag?.kind === "create" && drag.rect.width > 0 && drag.rect.height > 0 && <rect className="prop-new" {...drag.rect} strokeWidth={1 / scale} />}
    </svg>
  );
}
