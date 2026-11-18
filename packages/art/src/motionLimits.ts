import { Clip, type Rig } from "@anomaly/core";

/**
 * Motion limits for rigs cut from a drawing (cutout and traced): their pieces
 * overlap only a little where they meet, so a joint turned, moved or scaled
 * too far opens a gap. Each bone's limits come from the rig's geometry: the
 * overlap between the parts it moves (its whole subtree) and the parts it
 * doesn't, seen from its pivot. A bone whose pieces touch nothing else (the
 * root, or a body whose parent has no parts) moves freely. Clips are fitted to
 * the limits by scaling each bone's channel down (the motion keeps its shape).
 */

export interface BoneLimit {
  /** Max rotation either way (degrees). */
  rotate: number;
  /** Max offset from rest (rig px). */
  move: number;
  /** Max |scale - 1|. */
  scale: number;
}

const MIN_ROTATE = 10;
const MAX_ROTATE = 40;
/** Raster resolution: the rig's height in cells. */
const GRID = 160;

/** Joint mode: overlap counts within this share of the moved pieces' reach from the pivot... */
const JOINT_REACH = 0.35;
/** ...and at least this many cells. */
const JOINT_MIN = 6;

export interface MotionLimitOptions {
  /**
   * Count only the overlap around each joint (within JOINT_REACH of the moved pieces' reach from
   * the pivot): where a gap can open when the joint turns. Without it, any overlap counts, so a
   * limb lying along another (two legs seen from the side) is limited as if its whole length were
   * a seam, which leaves elbow-and-knee rigs at the minimum swing.
   */
  joint?: boolean;
}

/** Limits per bone (bones absent from the map are free). */
export function motionLimits(rig: Rig, options: MotionLimitOptions = {}): Map<string, BoneLimit> {
  const limits = new Map<string, BoneLimit>();
  const bounds = partBounds(rig);
  if (!bounds) return limits;
  const cell = Math.max(bounds.maxY - bounds.minY, bounds.maxX - bounds.minX, 1) / GRID;
  const W = Math.ceil((bounds.maxX - bounds.minX) / cell) + 3;
  const H = Math.ceil((bounds.maxY - bounds.minY) / cell) + 3;
  const toGrid = ([x, y]: readonly [number, number]): [number, number] => [(x - bounds.minX) / cell + 1, (y - bounds.minY) / cell + 1];
  // Which bones' parts cover each cell (bit sets over bone indices, as arrays).
  const bones = rig.bones.map((b) => b.id);
  const masks = new Map<string, Uint8Array>();
  for (const part of rig.parts) {
    const mask = masks.get(part.bone) ?? new Uint8Array(W * H);
    rasterize(part.shape, toGrid, cell, mask, W, H);
    masks.set(part.bone, mask);
  }
  const children = new Map<string, string[]>();
  for (const b of rig.bones) if (b.parent) children.set(b.parent, [...(children.get(b.parent) ?? []), b.id]);
  const subtree = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(subtree)];

  for (const bone of rig.bones) {
    if (bone.parent === null) continue;
    const inside = new Set(subtree(bone.id));
    const mine = new Uint8Array(W * H);
    const rest = new Uint8Array(W * H);
    for (const id of bones) {
      const m = masks.get(id);
      if (!m) continue;
      const into = inside.has(id) ? mine : rest;
      for (let i = 0; i < W * H; i++) if (m[i]) into[i] = 1;
    }
    const [px, py] = toGrid(bone.pivot);
    const from = (i: number) => Math.hypot((i % W) + 0.5 - px, Math.floor(i / W) + 0.5 - py);
    let radius = Infinity;
    if (options.joint) {
      let reach = 0;
      for (let i = 0; i < W * H; i++) if (mine[i]) reach = Math.max(reach, from(i));
      radius = Math.max(JOINT_MIN, JOINT_REACH * reach);
    }
    let overlap = 0;
    let far = 0;
    for (let i = 0; i < W * H; i++) {
      if (!mine[i] || !rest[i] || from(i) > radius) continue;
      overlap++;
      const x = (i % W) + 0.5;
      const y = Math.floor(i / W) + 0.5;
      far = Math.max(far, Math.hypot(x - px, y - py));
    }
    if (overlap < 3) continue; // touches nothing: free
    const depth = overlap / Math.max(1, 2 * far); // how deep the pieces overlap, on average along the seam (cells)
    const rotate = clamp((Math.atan2(depth, Math.max(far, 1)) * 180) / Math.PI, MIN_ROTATE, MAX_ROTATE);
    limits.set(bone.id, {
      rotate: Math.round(rotate),
      move: Math.round(Math.max(0.6 * depth, 1) * cell * 10) / 10,
      scale: Math.round(clamp(depth / Math.max(far, 1), 0.05, 0.3) * 100) / 100,
    });
  }
  return limits;
}

/** The limits as prompt text. */
export function limitsText(limits: Map<string, BoneLimit>): string {
  return [...limits].map(([id, l]) => `${id} ±${l.rotate}° (move ±${l.move}px, scale ±${l.scale})`).join("; ");
}

/** The clip with every limited bone's rotation, offset and scale scaled down to fit its limits (unchanged when it fits). */
export function fitClip(clip: Clip, limits: Map<string, BoneLimit>): Clip {
  let out: Clip = structuredClone(clip);
  for (const [bone, limit] of limits) {
    const peak = { rotate: 0, move: 0, scale: 0 };
    for (let s = 0; s <= 64; s++) {
      const c = channels(out, bone, s / 64);
      peak.rotate = Math.max(peak.rotate, Math.abs(c.rotate));
      peak.move = Math.max(peak.move, Math.hypot(c.x, c.y));
      peak.scale = Math.max(peak.scale, Math.abs(c.scaleX - 1), Math.abs(c.scaleY - 1));
    }
    const k = {
      rotate: peak.rotate > limit.rotate ? limit.rotate / peak.rotate : 1,
      move: peak.move > limit.move ? limit.move / peak.move : 1,
      scale: peak.scale > limit.scale ? limit.scale / peak.scale : 1,
    };
    if (k.rotate === 1 && k.move === 1 && k.scale === 1) continue;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    out = {
      ...out,
      tracks: out.tracks.map((t) => {
        if (t.bone !== bone) return t;
        const f = t.property === "rotate" ? k.rotate : t.property === "x" || t.property === "y" ? k.move : k.scale;
        if (f === 1) return t;
        const scaleKey = t.property === "scaleX" || t.property === "scaleY";
        return { ...t, keys: t.keys.map(([time, v]) => [time, r(scaleKey ? 1 + (v - 1) * f : v * f)] as [number, number]) };
      }),
      motions: out.motions.map((m) => {
        if (m.bone !== bone) return m;
        if (m.type === "sway") return { ...m, degrees: r(m.degrees * k.rotate) };
        if (m.type === "bob" || m.type === "shift" || m.type === "shake") return { ...m, amount: r(m.amount * k.move) };
        return { ...m, amount: r(m.amount * k.scale) };
      }),
    };
  }
  return Clip.parse(out);
}

/** Clips fitted to the limits. */
export function fitClips(clips: Record<string, Clip>, limits: Map<string, BoneLimit>): Record<string, Clip> {
  return Object.fromEntries(Object.entries(clips).map(([id, clip]) => [id, fitClip(clip, limits)]));
}

/** A bone's channels at normalized time t, as the runtime evaluates them (rig_view.gd). */
export function channels(clip: Clip, bone: string, t: number): { rotate: number; x: number; y: number; scaleX: number; scaleY: number } {
  const c = { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 };
  for (const track of clip.tracks) {
    if (track.bone !== bone || track.keys.length === 0) continue;
    const keys = track.keys;
    let value = keys[0]![1];
    if (t >= keys[keys.length - 1]![0]) value = keys[keys.length - 1]![1];
    else {
      for (let i = 0; i < keys.length - 1; i++) {
        const [t0, v0] = keys[i]!;
        const [t1, v1] = keys[i + 1]!;
        if (t >= t0 && t < t1) {
          let u = (t - t0) / Math.max(t1 - t0, 0.0001);
          if (track.ease === "step") u = 0;
          else if (track.ease === "smooth") u = u * u * (3 - 2 * u);
          value = v0 + (v1 - v0) * u;
          break;
        }
      }
    }
    if (track.property === "rotate") c.rotate += value;
    else if (track.property === "x") c.x += value;
    else if (track.property === "y") c.y += value;
    else if (track.property === "scaleX") c.scaleX *= value;
    else c.scaleY *= value;
  }
  for (const m of clip.motions) {
    if (m.bone !== bone) continue;
    if (m.type === "shake") {
      c.x += m.amount;
      c.y += m.amount;
      continue;
    }
    if (m.type === "squash") {
      const d = Math.abs(t - m.at) / (Math.max(m.width, 0.01) * 0.5);
      const k = d < 1 ? m.amount * (0.5 + 0.5 * Math.cos(Math.PI * d)) : 0;
      c.scaleX *= 1 + k;
      c.scaleY *= 1 - k;
      continue;
    }
    const wave = Math.sin(2 * Math.PI * (t * m.cycles + m.phase));
    if (m.type === "sway") c.rotate += m.degrees * wave;
    else if (m.type === "bob") c.y -= m.amount * wave;
    else if (m.type === "shift") c.x += m.amount * wave;
    else if (m.type === "pulse") {
      c.scaleX *= 1 + m.amount * wave;
      c.scaleY *= 1 + m.amount * wave;
    }
  }
  return c;
}

// --- geometry -------------------------------------------------------------------------

type Shape = Rig["parts"][number]["shape"];

function partBounds(rig: Rig): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const part of rig.parts) {
    for (const [x, y] of outline(part.shape)) {
      const pad = part.shape.type === "stroke" ? part.shape.width / 2 : 0;
      minX = Math.min(minX, x - pad);
      minY = Math.min(minY, y - pad);
      maxX = Math.max(maxX, x + pad);
      maxY = Math.max(maxY, y + pad);
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

function outline(shape: Shape): [number, number][] {
  if (shape.type === "ellipse") {
    const a = (shape.rotation * Math.PI) / 180;
    return Array.from({ length: 24 }, (_, i) => {
      const t = (i / 24) * 2 * Math.PI;
      const x = shape.rx * Math.cos(t);
      const y = shape.ry * Math.sin(t);
      return [shape.center[0] + x * Math.cos(a) - y * Math.sin(a), shape.center[1] + x * Math.sin(a) + y * Math.cos(a)] as [number, number];
    });
  }
  return shape.points as [number, number][];
}

function rasterize(shape: Shape, toGrid: (p: readonly [number, number]) => [number, number], cell: number, mask: Uint8Array, W: number, H: number): void {
  if (shape.type === "stroke") {
    const pts = shape.points.map(toGrid);
    const r = Math.max(shape.width, shape.widthEnd ?? shape.width) / 2 / cell;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let i = 0; i + 1 < pts.length; i++) {
          if (segmentDistance(x + 0.5, y + 0.5, pts[i]!, pts[i + 1]!) <= r) {
            mask[y * W + x] = 1;
            break;
          }
        }
      }
    }
    return;
  }
  const poly = outline(shape).map(toGrid);
  const ys = poly.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(H, Math.ceil(Math.max(...ys))); y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k]! - 0.5)); x < Math.min(W, Math.ceil(xs[k + 1]! - 0.5)); x++) mask[y * W + x] = 1;
    }
  }
}

function segmentDistance(x: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
