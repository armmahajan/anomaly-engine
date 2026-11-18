import type { Rig } from "@anomaly/core";

/**
 * Rig space <-> the Characters stage, and posing bones, for the bone editor's overlay.
 *
 * The stage is the runtime's (game/scripts/art/stage_view.gd): it frames the rig's rest bounds
 * (`_rest_bounds`) so the rig fills about 60% of the view, feet a little below centre (`_fit`), in a
 * 960x540 viewport stretched with canvas_items/expand (game/project.godot). These functions mirror
 * that framing so handles drawn over the iframe sit on the joints; change them together.
 */

export type Vec = [number, number];
/** 2D affine map [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (SVG's matrix order). */
export type Mat = [number, number, number, number, number, number];

const BASE = { width: 960, height: 540 };

/** stage_view.gd `_rest_bounds`: parts' points (an ellipse as its centre ± its larger radius). */
export function restBounds(rig: Rig): { x: number; y: number; width: number; height: number } {
  let lo: Vec = [Infinity, Infinity];
  let hi: Vec = [-Infinity, -Infinity];
  const add = (x: number, y: number) => {
    lo = [Math.min(lo[0], x), Math.min(lo[1], y)];
    hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
  };
  for (const part of rig.parts) {
    const s = part.shape;
    if (s.type === "ellipse") {
      const r = Math.max(s.rx, s.ry);
      add(s.center[0] - r, s.center[1] - r);
      add(s.center[0] + r, s.center[1] + r);
    } else s.points.forEach(([x, y]) => add(x, y));
  }
  if (lo[0] === Infinity) return { x: -20, y: -40, width: 40, height: 40 };
  return { x: lo[0], y: lo[1], width: hi[0] - lo[0], height: hi[1] - lo[1] };
}

/** Where rig space lands on a stage of `width` x `height` CSS px (stage_view.gd `_fit`), and back. */
export function stageMapping(rig: Rig, width: number, height: number) {
  const s = Math.min(width / BASE.width, height / BASE.height);
  const view = { x: width / s, y: height / s };
  const b = restBounds(rig);
  const size = { x: Math.max(b.width, 8), y: Math.max(b.height, 8) };
  const zoom = Math.min((view.x * 0.55) / size.x, (view.y * 0.6) / size.y);
  const cam: Vec = [b.x + b.width / 2, b.y + b.height / 2 + size.y * 0.08];
  const k = s * zoom; // CSS px per rig px
  const matrix: Mat = [k, 0, 0, k, width / 2 - cam[0] * k, height / 2 - cam[1] * k];
  return {
    /** CSS px per rig px. */
    scale: k,
    matrix,
    toScreen: ([x, y]: readonly [number, number]): Vec => [(x - cam[0]) * k + width / 2, (y - cam[1]) * k + height / 2],
    toRig: ([x, y]: readonly [number, number]): Vec => [(x - width / 2) / k + cam[0], (y - height / 2) / k + cam[1]],
  };
}

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export const multiply = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

export const apply = (m: Mat, [x, y]: readonly [number, number]): Vec => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Rotation by `degrees` (clockwise on screen, y down) about `c`. */
export function rotationAbout(c: readonly [number, number], degrees: number): Mat {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [cos, sin, -sin, cos, c[0] - cos * c[0] + sin * c[1], c[1] - sin * c[0] - cos * c[1]];
}

/**
 * Each bone's map from rest pose to `pose` (degrees per bone, about its rest pivot, children
 * following their parents), as the runtime poses rigs for rotate tracks.
 */
export function posedBones(rig: Rig, pose: Readonly<Record<string, number>>): Map<string, Mat> {
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const done = new Map<string, Mat>();
  const resolve = (id: string, depth = 0): Mat => {
    const known = done.get(id);
    if (known) return known;
    const bone = byId.get(id);
    if (!bone || depth > 64) return IDENTITY;
    const parent = bone.parent === null ? IDENTITY : resolve(bone.parent, depth + 1);
    const m = multiply(parent, rotationAbout(bone.pivot, pose[id] ?? 0));
    done.set(id, m);
    return m;
  };
  rig.bones.forEach((b) => resolve(b.id));
  return done;
}

/** Degrees from `from` to `to` as seen from `c`, in -180..180 (clockwise positive on screen). */
export function turnAngle(c: readonly [number, number], from: readonly [number, number], to: readonly [number, number]): number {
  const a = Math.atan2(from[1] - c[1], from[0] - c[0]);
  const b = Math.atan2(to[1] - c[1], to[0] - c[0]);
  let d = ((b - a) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** Closed smooth path through points (Catmull-Rom as cubic Béziers), or a polygon when `smooth` is 0. */
export function blobPath(points: readonly (readonly [number, number])[], smooth: number): string {
  const n = points.length;
  if (n < 3 || smooth <= 0) return `M${points.map((p) => p.join(",")).join("L")}Z`;
  const t = smooth / 6;
  let d = `M${points[0]!.join(",")}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % n]!;
    const p3 = points[(i + 2) % n]!;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += `C${c1.join(",")} ${c2.join(",")} ${p2.join(",")}`;
  }
  return `${d}Z`;
}

/** Open smooth path through points (a stroke's centre line). */
export function linePath(points: readonly (readonly [number, number])[], smooth: number): string {
  const n = points.length;
  if (n < 3 || smooth <= 0) return `M${points.map((p) => p.join(",")).join("L")}`;
  const t = smooth / 6;
  let d = `M${points[0]!.join(",")}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(n - 1, i + 2)]!;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += `C${c1.join(",")} ${c2.join(",")} ${p2.join(",")}`;
  }
  return d;
}
