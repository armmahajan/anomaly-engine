import { slugify, uniqueId, type ClipMarker } from "@anomaly/core";

/**
 * Pure edits of a clip's markers (named moments at normalized time 0..1 that fire marker events in
 * play). Each returns the whole new list, sorted by time as setClipMarkers stores it, with the edited
 * marker's new position so the timeline keeps it selected.
 */

/** A clip holds at most this many markers (core Clip.markers). */
export const MAX_MARKERS = 16;

/** Clamped to 0..1 and rounded to a thousandth (a millisecond of a one-second clip). */
export const roundT = (t: number): number => Math.round(Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * 1000) / 1000;

export interface MarkerEdit {
  markers: ClipMarker[];
  /** Where the added or edited marker is in the new list. */
  index: number;
}

function sorted(markers: ClipMarker[], edited: ClipMarker): MarkerEdit {
  const list = [...markers].sort((a, b) => a.t - b.t);
  return { markers: list, index: list.indexOf(edited) };
}

/** The middle of the widest stretch without a marker (where a new one goes when no time is given). */
export function freeSpot(markers: ClipMarker[]): number {
  const ts = [0, ...markers.map((m) => m.t).sort((a, b) => a - b), 1];
  let best = 0.5;
  let width = -1;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i]! - ts[i - 1]!;
    if (gap > width) {
      width = gap;
      best = (ts[i]! + ts[i - 1]!) / 2;
    }
  }
  return roundT(best);
}

/** Add a marker at `t` (default: the widest free stretch) named `name` (default: a fresh "marker"). Null when the clip is full. */
export function addMarker(markers: ClipMarker[], t?: number, name?: string): MarkerEdit | null {
  if (markers.length >= MAX_MARKERS) return null;
  const marker = { t: roundT(t ?? freeSpot(markers)), name: name ? slugify(name, "marker") : uniqueId("marker", markers.map((m) => m.name)) };
  return sorted([...markers, marker], marker);
}

/** Move marker `index` to time `t`. Null when nothing changes. */
export function moveMarker(markers: ClipMarker[], index: number, t: number): MarkerEdit | null {
  const old = markers[index];
  if (!old) return null;
  const moved = { ...old, t: roundT(t) };
  if (moved.t === old.t) return null;
  return sorted(
    markers.map((m, i) => (i === index ? moved : m)),
    moved,
  );
}

/** Rename marker `index` (to an id: lower case, underscores). Null when the name is empty or unchanged. */
export function renameMarker(markers: ClipMarker[], index: number, name: string): MarkerEdit | null {
  const old = markers[index];
  const next = slugify(name, "");
  if (!old || !next || next === old.name) return null;
  const renamed = { ...old, name: next };
  return sorted(
    markers.map((m, i) => (i === index ? renamed : m)),
    renamed,
  );
}

export const removeMarker = (markers: ClipMarker[], index: number): ClipMarker[] => markers.filter((_, i) => i !== index);

/** Normalized time under a pointer at `clientX` over a bar spanning `left`..`left + width`. */
export const timeAt = (clientX: number, left: number, width: number): number => roundT(width > 0 ? (clientX - left) / width : 0);
