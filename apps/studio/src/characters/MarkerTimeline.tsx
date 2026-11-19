import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip, ClipMarker } from "@anomaly/core";
import { addMarker, MAX_MARKERS, moveMarker, removeMarker, renameMarker, roundT, timeAt, type MarkerEdit } from "./markers.ts";

/**
 * A clip's markers on its time bar (Characters ▸ Animation): named moments that fire marker events in
 * play (a strike landing, a lever clicking). Click the bar to add one there (or + Marker), drag a
 * marker (or nudge it with the arrow keys) to move it, and rename, retime or delete the selected one.
 * Every change is one setClipMarkers operation, so Undo takes it back.
 */

type Run = (calls: { name: string; input: unknown }[]) => Promise<boolean>;

export function MarkerTimeline({ assetId, clipId, clip, locked, run }: { assetId: string; clipId: string; clip: Clip; locked: boolean; run: Run }) {
  const markers = clip.markers;
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ index: number; t: number; moved: boolean } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const current = selected !== null ? markers[selected] : undefined;

  const save = async (next: ClipMarker[], select: number | null) => {
    if (await run([{ name: "setClipMarkers", input: { assetId, clipId, markers: next } }])) setSelected(select);
  };
  const apply = (edit: MarkerEdit | null) => edit && void save(edit.markers, edit.index);

  const timeOf = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    return r ? timeAt(clientX, r.left, r.width) : 0;
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (locked || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelected(index);
    setDrag({ index, t: markers[index]!.t, moved: false });
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const t = timeOf(e.clientX);
    if (t !== drag.t) setDrag({ ...drag, t, moved: true });
  };
  const onHandleUp = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.moved) apply(moveMarker(markers, drag.index, drag.t));
  };

  const seconds = (t: number) => `${(t * clip.duration).toFixed(2)}s`;

  return (
    <div className="marker-timeline" data-testid="marker-timeline">
      <div className="marker-head">
        <span className="anim-caption">Markers</span>
        <span className="muted">{markers.length ? "events this clip fires in play (handlers on marker)" : "none: click the bar to add one where something happens"}</span>
        <button type="button" disabled={locked || markers.length >= MAX_MARKERS} onClick={() => apply(addMarker(markers))}>
          + Marker
        </button>
      </div>
      <div
        ref={bar}
        className="marker-bar"
        data-testid="marker-bar"
        title="Click to add a marker here"
        onClick={(e) => {
          if (locked || e.target !== e.currentTarget) return;
          apply(addMarker(markers, timeOf(e.clientX)));
        }}
      >
        {markers.map((m, i) => {
          const t = drag?.index === i ? drag.t : m.t;
          return (
            <button
              key={`${i}:${m.name}:${m.t}`}
              type="button"
              className={`marker-handle${i === selected ? " selected" : ""}${drag?.index === i ? " dragging" : ""}`}
              style={{ left: `${t * 100}%` }}
              data-testid={`marker-${i}`}
              aria-label={`marker ${m.name} at ${t}`}
              aria-pressed={i === selected}
              disabled={locked}
              onPointerDown={(e) => onHandleDown(e, i)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={() => setDrag(null)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                apply(moveMarker(markers, i, m.t + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01)));
              }}
            >
              <span>{m.name}</span>
            </button>
          );
        })}
      </div>
      {current && selected !== null && (
        <div className="marker-edit" data-testid="marker-edit">
          <input
            key={`name:${current.name}`}
            className="art-text"
            aria-label="marker name"
            defaultValue={current.name}
            disabled={locked}
            onBlur={(e) => {
              const edit = renameMarker(markers, selected, e.currentTarget.value);
              if (edit) apply(edit);
              else e.currentTarget.value = current.name;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") e.currentTarget.value = current.name;
            }}
          />
          <label className="marker-t">
            at
            <input
              key={`t:${current.t}`}
              type="number"
              className="wpn-number"
              aria-label="marker time"
              min={0}
              max={1}
              step={0.01}
              defaultValue={current.t}
              disabled={locked}
              onBlur={(e) => {
                const edit = e.currentTarget.value.trim() === "" ? null : moveMarker(markers, selected, roundT(Number(e.currentTarget.value)));
                if (edit) apply(edit);
                else e.currentTarget.value = String(current.t);
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <span className="muted">of the clip ({seconds(current.t)})</span>
          </label>
          <button type="button" disabled={locked} onClick={() => void save(removeMarker(markers, selected), null)}>
            Delete marker
          </button>
        </div>
      )}
    </div>
  );
}
