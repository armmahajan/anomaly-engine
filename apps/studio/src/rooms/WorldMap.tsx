import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { gridCols, gridRows, type DoorSide, type ProjectSpec, type WorldRoom } from "@anomaly/core";
import { regionColor, regionGroups, roomArt, ART_STATE_TEXT } from "../worlds/scenery.ts";

const PAD = 2;
/** Under this many px per tile the map is unreadable: scroll instead of fitting everything. */
const READABLE = 2.5;
/** The default scale when the map scrolls: small enough to show a few rooms at once. */
const SCROLL_SCALE = 3.5;
const MAX_SCALE = 7;

/**
 * Rooms where they sit in the world (`at`, in tiles), colored by region, with
 * lines for connected doors and a dot for rooms with scenery. It scrolls (wheel
 * or drag) when the world is too wide to read at once; the selected room is
 * outlined and scrolled into view; − / + zoom and "All" fits the whole world.
 */
export function WorldMap({ project, selected, onSelect }: { project: ProjectSpec; selected: string | null; onSelect: (id: string) => void }) {
  const rooms = project.world.rooms;
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(280);
  const [tall, setTall] = useState(false);
  /** px per tile, or null for the default (everything if readable, else fit the height). */
  const [zoom, setZoom] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    observer.observe(box);
    setBoxWidth(box.clientWidth);
    return () => observer.disconnect();
  }, [rooms.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const minX = Math.min(...rooms.map((r) => r.at.x)) - PAD;
  const minY = Math.min(...rooms.map((r) => r.at.y)) - PAD;
  const width = Math.max(...rooms.map((r) => r.at.x + gridCols(r.grid))) + PAD - minX;
  const height = Math.max(...rooms.map((r) => r.at.y + gridRows(r.grid))) + PAD - minY;
  const viewHeight = tall ? 320 : 140;
  const fitAll = Math.min(boxWidth / width, viewHeight / height);
  const fitHeight = Math.min(viewHeight / height, tall ? MAX_SCALE : SCROLL_SCALE);
  const scale = zoom ?? (fitAll >= READABLE ? Math.min(fitAll, MAX_SCALE) : fitHeight);

  // Keep the selected room in view.
  const sel = rooms.find((r) => r.id === selected);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !sel) return;
    const x = (sel.at.x - minX + gridCols(sel.grid) / 2) * scale;
    const y = (sel.at.y - minY + gridRows(sel.grid) / 2) * scale;
    const left = x - box.clientWidth / 2;
    const top = y - box.clientHeight / 2;
    const visible = x > box.scrollLeft + 20 && x < box.scrollLeft + box.clientWidth - 20 && y > box.scrollTop && y < box.scrollTop + box.clientHeight;
    if (!visible) box.scrollTo({ left, top, behavior: "smooth" });
  }, [sel?.id, scale, tall]); // eslint-disable-line react-hooks/exhaustive-deps

  // The wheel scrolls sideways when the map only scrolls sideways (a passive React listener can't keep the sidebar still).
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (box.scrollHeight > box.clientHeight || box.scrollWidth <= box.clientWidth || e.shiftKey) return;
      e.preventDefault();
      box.scrollLeft += e.deltaY + e.deltaX;
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [rooms.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rooms.length === 0) return null;

  const box = (r: WorldRoom) => ({ x: r.at.x, y: r.at.y, w: gridCols(r.grid), h: gridRows(r.grid) });
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
  const px = 1 / scale; // one screen px in tiles
  const font = 10 * px;
  const label = (name: string, w: number) => {
    const fits = Math.floor((w * scale - 6) / 5.6);
    if (fits < 2) return "";
    return name.length <= fits ? name : `${name.slice(0, Math.max(1, fits - 1))}…`;
  };
  const groups = regionGroups(project).filter((g) => g.id !== "" && g.rooms.length > 0);

  const scrollToRegion = (rooms: WorldRoom[]) => {
    const b = boxRef.current;
    if (!b || rooms.length === 0) return;
    const left = (Math.min(...rooms.map((r) => r.at.x)) - minX) * scale - 8;
    b.scrollTo({ left, behavior: "smooth" });
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const b = boxRef.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: b.scrollLeft, top: b.scrollTop, moved: false };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) boxRef.current!.setPointerCapture(e.pointerId);
    d.moved = true;
    boxRef.current!.scrollLeft = d.left - dx;
    boxRef.current!.scrollTop = d.top - dy;
  };
  const onUp = () => {
    // A drag isn't a click: let the click that follows see it, then forget it.
    setTimeout(() => (drag.current = null), 0);
  };

  return (
    <div className="world-map-wrap">
      <div className="world-map-tools">
        <span className="world-map-caption">World map</span>
        <button type="button" className="icon-button" aria-label="zoom out the map" title="Zoom out" onClick={() => setZoom(Math.max(fitAll, scale / 1.5))}>
          −
        </button>
        <button type="button" className="icon-button" aria-label="zoom in the map" title="Zoom in" onClick={() => setZoom(Math.min(24, scale * 1.5))}>
          +
        </button>
        <button type="button" className="icon-button" title="Fit the whole world" onClick={() => setZoom(fitAll)}>
          All
        </button>
        <button type="button" className="icon-button" aria-pressed={tall} title={tall ? "Make the map shorter" : "Make the map taller"} onClick={() => setTall(!tall)}>
          {tall ? "Shorter" : "Taller"}
        </button>
      </div>
      <div
        ref={boxRef}
        className="world-map-scroll"
        style={{ height: Math.min(viewHeight, height * scale) + 14 }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        data-testid="world-map"
      >
        <svg
          className="world-map"
          width={width * scale}
          height={height * scale}
          viewBox={`${minX} ${minY} ${width} ${height}`}
          aria-label="World map"
          role="group"
        >
          {links.map(([a, b], i) => (
            <line key={i} x1={a![0]} y1={a![1]} x2={b![0]} y2={b![1]} style={{ strokeWidth: 1.5 * px }} />
          ))}
          {rooms.map((r) => {
            const b = box(r);
            const fill = regionColor(project, r.regionId);
            const region = project.progression.regions.find((g) => g.id === r.regionId);
            const art = roomArt(project, r);
            const isSelected = r.id === selected;
            return (
              <g
                key={r.id}
                onClick={() => !drag.current?.moved && onSelect(r.id)}
                className={isSelected ? "selected" : ""}
                data-testid={`map-room-${r.id}`}
                data-region={r.regionId ?? ""}
                data-art={art.state}
              >
                <title>{`${r.name}${region ? ` · ${region.name}` : ""} · ${ART_STATE_TEXT[art.state]}`}</title>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} style={{ ...(fill ? { fill } : {}), strokeWidth: (isSelected ? 2.5 : 1) * px }} />
                <text x={b.x + 3 * px} y={b.y + 3 * px + font} style={{ fontSize: font }}>
                  {label(r.name, b.w)}
                </text>
                {art.state !== "plain" && (
                  <circle className={`art-dot ${art.state}`} cx={b.x + b.w - 5 * px} cy={b.y + b.h - 5 * px} r={2.5 * px} />
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {groups.length > 0 && (
        <div className="world-map-legend">
          {groups.map((g) => (
            <button key={g.id} type="button" className="legend-chip" title={`Scroll the map to ${g.name}`} onClick={() => scrollToRegion(g.rooms)}>
              <span className="region-swatch" style={{ background: g.color }} />
              {g.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
