import { z } from "zod";
import {
  Clip,
  ClipMarker,
  handlerEffects,
  Id,
  isObjectAsset,
  objectUses,
  wantedObjectClips,
  type CharacterAsset,
  type ProjectSpec,
  type Rig,
} from "@anomaly/core";
import { bonePoses } from "./weapons.ts";
import { OBJECT_CLIP_HINTS, type DrawnObject, type ObjectClipBrief } from "./prompts.ts";

/**
 * Objects in the art pipeline (core isObjectAsset: a lever, a trap, a shockwave, a bolt): what the
 * stages need to draw one like a character (its size and where the game uses it), which clips it
 * gets and how each plays (loop or once), and its clip markers checked in code: inside 0..1, in
 * order, at most 16, and impact-like ones (strike, click, impact...) on the frame the motion lands.
 */

/** Size when nothing in the game says how big an object is (an effect, an unused object). */
const DEFAULT_SIZE = { width: 64, height: 64 };

/** About how big an object is in the game: the first prop drawn with it, else a projectile's size, else 64x64. */
export function objectSize(project: ProjectSpec, objectId: string): { width: number; height: number } {
  for (const room of project.world.rooms) {
    for (const p of room.props) if (p.art && "object" in p.art && p.art.object === objectId) return { width: p.width, height: p.height };
  }
  for (const w of project.weapons.list) {
    for (const a of w.attacks) {
      if (a.shape.type === "projectile" && a.shape.projectile.look.art?.object === objectId) {
        const s = Math.max(16, a.shape.projectile.size * 2);
        return { width: s, height: s };
      }
    }
  }
  return DEFAULT_SIZE;
}

/** The object asset `objectId` as a stage subject, or why not. */
export function findObject(project: ProjectSpec, objectId: string): { subject: DrawnObject; asset: CharacterAsset } | { error: string } {
  const asset = project.art.assets.find((a) => a.id === objectId);
  if (!asset) return { error: `no object "${objectId}"` };
  if (!isObjectAsset(asset)) return { error: `"${objectId}" is not an object asset (createObject makes one)` };
  const uses = [...new Set(objectUses(project).filter((u) => u.object === objectId).map((u) => u.what))];
  return { asset, subject: { kind: "object", id: asset.id, name: asset.name, size: objectSize(project, objectId), uses } };
}

/**
 * How each clip of an object plays: a prop's idle and a projectile's charge and fly loop; a clip a
 * handler plays (playAnimation), an effect (spawnEffect) and a projectile's burst play once. A clip
 * that loops anywhere loops. Clips nothing plays yet: idle loops, others are up to the animator.
 */
export function objectClipModes(project: ProjectSpec, objectId: string): Map<string, boolean> {
  const loops = new Set<string>();
  const once = new Set<string>();
  const propsWith = new Set<string>();
  for (const room of project.world.rooms) {
    for (const p of room.props) {
      if (!(p.art && "object" in p.art && p.art.object === objectId)) continue;
      propsWith.add(p.id);
      if (p.art.idle) loops.add(p.art.idle);
      for (const h of p.handlers) for (const e of h.do) if (e.type === "playAnimation" && e.target.kind === "self") once.add(e.clip);
    }
  }
  for (const { effect } of handlerEffects(project)) {
    if (effect.type === "spawnEffect" && effect.object === objectId) once.add(effect.clip);
    if (effect.type === "playAnimation" && effect.target.kind === "prop" && propsWith.has(effect.target.prop)) once.add(effect.clip);
  }
  const looks = [
    ...project.weapons.list.flatMap((w) => w.attacks.flatMap((a) => (a.shape.type === "projectile" ? [a.shape.projectile.look] : []))),
    ...project.characters.flatMap((c) => (c.kind === "enemy" ? Object.values(c.behavior.states).flatMap((s) => (s.action.type === "shoot" ? [s.action.look] : [])) : [])),
  ];
  for (const look of looks) {
    if (look.art?.object !== objectId) continue;
    if (look.art.charge) loops.add(look.art.charge);
    if (look.art.fly) loops.add(look.art.fly);
    if (look.art.burst) once.add(look.art.burst);
  }
  const modes = new Map<string, boolean>();
  for (const c of once) modes.set(c, false);
  for (const c of loops) modes.set(c, true);
  if (!modes.has("idle")) modes.set("idle", true);
  return modes;
}

/** Marker names the game listens for on an object: its props' own marker handlers, and world/room handlers heard `from` one of them. */
export function heardMarkers(project: ProjectSpec, objectId: string): string[] {
  const names = new Set<string>();
  const props = new Set<string>();
  for (const room of project.world.rooms) {
    for (const p of room.props) {
      if (!(p.art && "object" in p.art && p.art.object === objectId)) continue;
      props.add(p.id);
      for (const h of p.handlers) if (h.on.type === "marker" && h.on.name) names.add(h.on.name);
    }
  }
  const outer = [...project.world.handlers, ...project.world.rooms.flatMap((r) => r.handlers)];
  for (const h of outer) {
    if (h.on.type === "marker" && h.on.name && h.on.from?.kind === "prop" && props.has(h.on.from.prop)) names.add(h.on.name);
  }
  return [...names];
}

/** The clips to write for an object (all of wantedObjectClips, or `only`), each with how it plays and what it should be. */
export function objectClipBriefs(project: ProjectSpec, asset: CharacterAsset, only?: string[], said?: string): ObjectClipBrief[] {
  const modes = objectClipModes(project, asset.id);
  const names = only ?? wantedObjectClips(project, asset.id);
  return names.map((name) => ({
    name,
    loop: modes.get(name) ?? null,
    direction: ((only && said) || asset.clips[name]?.direction || OBJECT_CLIP_HINTS[name] || name.replace(/_/g, " ")).slice(0, 600),
  }));
}

// --- markers ---------------------------------------------------------------------------------

const MAX_MARKERS = 16;

/** Markers as the model wrote them, made valid: well-formed names only, times clamped into 0..1, in order, one per name and time, at most 16. */
export function cleanMarkers(raw: unknown): ClipMarker[] {
  if (!Array.isArray(raw)) return [];
  const out: ClipMarker[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const { t, name } = m as { t?: unknown; name?: unknown };
    const time = typeof t === "number" ? t : typeof t === "string" ? Number(t) : NaN;
    if (!Number.isFinite(time) || typeof name !== "string" || !Id.safeParse(name).success) continue;
    const clamped = Math.min(1, Math.max(0, time));
    if (!out.some((o) => o.name === name && Math.abs(o.t - clamped) < 1e-3)) out.push({ t: clamped, name });
  }
  return out.sort((a, b) => a.t - b.t).slice(0, MAX_MARKERS);
}

/** A clip reply whose markers are cleaned before the clip is checked (a bad marker never fails the clip). */
const LenientClip = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  return { ...v, markers: cleanMarkers(v.markers) };
}, Clip);

/** Object clips by name, markers cleaned. */
export const ObjectClips = z.record(Id, LenientClip);
/** The reply to an object clip prompt. */
export const ObjectClipsReply = z.object({ clips: ObjectClips });

/** Names of moments when something lands or locks: they go on the frame the motion stops. */
export const IMPACT_MARKER = /strike|hit|impact|click|snap|slam|land|clang|close|shut|bite|crash|lock|clamp|bang|smash|stomp|thud/;

const SAMPLES = 40;

/** Points that show how a part moves (its outline points, an ellipse's centre and extremes), in rest-pose rig space. */
function partPoints(rig: Rig): { bone: string; points: [number, number][] }[] {
  return rig.parts.map((p) => {
    const s = p.shape;
    const points: [number, number][] =
      s.type === "ellipse"
        ? [[s.center[0], s.center[1]], [s.center[0] - s.rx, s.center[1]], [s.center[0] + s.rx, s.center[1]], [s.center[0], s.center[1] - s.ry], [s.center[0], s.center[1] + s.ry]]
        : s.points.map((q) => [q[0], q[1]] as [number, number]);
    return { bone: p.bone, points };
  });
}

/**
 * When a clip's moves land: for each burst of motion (a local peak of how far the parts move per
 * sample, at least half the biggest), the first time after it that the motion has dropped to
 * a quarter of that peak (normalized 0..1). Empty when the clip barely moves.
 */
export function motionStops(rig: Rig, clip: Clip): number[] {
  const parts = partPoints(rig);
  const pivots = new Map(rig.bones.map((b) => [b.id, b.pivot]));
  const pose = (t: number) => {
    const poses = bonePoses(rig, clip, t);
    return parts.flatMap(({ bone, points }) => {
      const m = poses.get(bone);
      const pivot = pivots.get(bone);
      if (!m || !pivot) return points;
      return points.map(([x, y]) => {
        const lx = x - pivot[0];
        const ly = y - pivot[1];
        return [m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5]] as [number, number];
      });
    });
  };
  const frames = Array.from({ length: SAMPLES + 1 }, (_, i) => pose(i / SAMPLES));
  const speed = frames.slice(1).map((f, i) => {
    const prev = frames[i]!;
    let sum = 0;
    for (let k = 0; k < f.length; k++) sum += Math.hypot(f[k]![0] - prev[k]![0], f[k]![1] - prev[k]![1]);
    return f.length ? sum / f.length : 0;
  });
  const top = Math.max(0, ...speed);
  if (top < 0.05) return [];
  const stops: number[] = [];
  for (let i = 0; i < speed.length; i++) {
    const s = speed[i]!;
    if (s < top / 2 || s < (speed[i - 1] ?? 0) || s < (speed[i + 1] ?? 0)) continue;
    let j = i;
    while (j < speed.length && speed[j]! > s / 4) j++;
    const t = Math.min(1, j / SAMPLES);
    if (!stops.some((x) => Math.abs(x - t) < 1e-6)) stops.push(t);
  }
  return stops;
}

/**
 * An object clip's markers settled: cleaned (cleanMarkers), and impact-like ones (IMPACT_MARKER)
 * moved to the nearest moment a move lands (motionStops) when the clip moves at all.
 */
export function settleMarkers(rig: Rig, clip: Clip): Clip {
  const markers = cleanMarkers(clip.markers);
  if (!markers.some((m) => IMPACT_MARKER.test(m.name))) return { ...clip, markers };
  const stops = motionStops(rig, clip);
  if (stops.length === 0) return { ...clip, markers };
  const snapped = markers.map((m) => (IMPACT_MARKER.test(m.name) ? { ...m, t: stops.reduce((best, s) => (Math.abs(s - m.t) < Math.abs(best - m.t) ? s : best), stops[0]!) } : m));
  return { ...clip, markers: cleanMarkers(snapped) };
}

/**
 * Settle an object's written clips: each plays as the game plays it (loop or once, `modes`), its
 * markers settled; a marker the game listens for that no clip has goes on the one clip that plays
 * once (when there is exactly one), at the moment its main move lands. Returns what it added.
 */
export function settleObjectClips(rig: Rig, clips: Record<string, Clip>, modes: Map<string, boolean>, heard: string[]): { clips: Record<string, Clip>; added: string[] } {
  const out: Record<string, Clip> = {};
  for (const [name, clip] of Object.entries(clips)) {
    const loop = modes.get(name);
    out[name] = settleMarkers(rig, loop === undefined ? clip : { ...clip, loop });
  }
  const added: string[] = [];
  const once = Object.entries(out).filter(([, c]) => !c.loop);
  for (const name of heard) {
    if (Object.values(out).some((c) => c.markers.some((m) => m.name === name)) || once.length !== 1) continue;
    const [clipName, clip] = once[0]!;
    if (clip.markers.length >= MAX_MARKERS) continue;
    const stops = motionStops(rig, clip);
    const t = stops.length > 0 ? stops[0]! : 0.5;
    out[clipName] = { ...clip, markers: cleanMarkers([...clip.markers, { t, name }]) };
    added.push(`${name} on ${clipName}`);
  }
  return { clips: out, added };
}
