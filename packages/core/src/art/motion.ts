import type { Clip, Ease, IkTrack } from "./clip.ts";
import type { Rig } from "./rig.ts";

/**
 * Clip evaluation shared with the runtime (game/scripts/art/rig_view.gd mirrors every function
 * here): eases between keys, and two-bone IK on a pose's channels. The art pipeline poses clips
 * in TypeScript (grips, motion limits) with these so its measurements match what the game shows.
 */

const C1 = 1.70158;
const C3 = C1 + 1;
const C4 = (2 * Math.PI) / 3;

/** An ease's progress at u (0..1) between two keys: 0 at u = 0, 1 at u = 1 (overshoot and elastic pass 1 on the way). */
export function easeAt(ease: Ease, u: number): number {
  switch (ease) {
    case "linear":
      return u;
    case "step":
      return 0;
    case "overshoot":
      return 1 + C3 * (u - 1) ** 3 + C1 * (u - 1) ** 2;
    case "anticipate":
      return C3 * u ** 3 - C1 * u ** 2;
    case "elastic":
      return u <= 0 ? 0 : u >= 1 ? 1 : 2 ** (-10 * u) * Math.sin((u * 10 - 0.75) * C4) + 1;
    case "bounce":
      return bounce(u);
    default:
      return u * u * (3 - 2 * u);
  }
}

function bounce(u: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (u < 1 / d1) return n1 * u * u;
  if (u < 2 / d1) return n1 * (u - 1.5 / d1) ** 2 + 0.75;
  if (u < 2.5 / d1) return n1 * (u - 2.25 / d1) ** 2 + 0.9375;
  return n1 * (u - 2.625 / d1) ** 2 + 0.984375;
}

/** Keyed values at normalized time t: the first value before the first key, the last after the last, eased between. */
export function keysAt<K extends readonly [number, ...number[]]>(keys: readonly K[], t: number, ease: Ease): number[] {
  const values = (k: K) => k.slice(1) as number[];
  if (keys.length === 0) return [];
  const last = keys[keys.length - 1]!;
  if (t >= last[0]) return values(last);
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i]!;
    const k1 = keys[i + 1]!;
    if (t >= k0[0] && t < k1[0]) {
      const u = easeAt(ease, (t - k0[0]) / Math.max(k1[0] - k0[0], 0.0001));
      return values(k0).map((v, j) => v + (values(k1)[j]! - v) * u);
    }
  }
  return values(keys[0]!);
}

/** One bone's channels: offsets from rest (rotate in degrees, x/y px, scale multipliers). */
export interface BoneChannels {
  rotate: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/** An affine transform [a, b, c, d, tx, ty]: x' = a x + c y + tx, y' = b x + d y + ty. */
export type PoseMat = [number, number, number, number, number, number];

const mul = (m: PoseMat, n: PoseMat): PoseMat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Each bone's pose from its channels (bone-local offsets from its pivot -> rig space), as rig_view.gd builds them. */
export function posesFrom(rig: Pick<Rig, "bones">, channels: ReadonlyMap<string, BoneChannels>): Map<string, PoseMat> {
  const poses = new Map<string, PoseMat>();
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const place = (id: string, seen: Set<string>): PoseMat => {
    const known = poses.get(id);
    if (known) return known;
    const bone = byId.get(id)!;
    const c = channels.get(id) ?? { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 };
    const r = (c.rotate * Math.PI) / 180;
    const local: PoseMat = [Math.cos(r) * c.scaleX, Math.sin(r) * c.scaleX, -Math.sin(r) * c.scaleY, Math.cos(r) * c.scaleY, c.x, c.y];
    const parent = bone.parent !== null && byId.has(bone.parent) && !seen.has(bone.parent) ? byId.get(bone.parent)! : null;
    const pose = parent
      ? mul(mul(place(parent.id, new Set([...seen, id])), [1, 0, 0, 1, bone.pivot[0] - parent.pivot[0], bone.pivot[1] - parent.pivot[1]]), local)
      : mul([1, 0, 0, 1, bone.pivot[0], bone.pivot[1]], local);
    poses.set(id, pose);
    return pose;
  };
  for (const b of rig.bones) place(b.id, new Set());
  return poses;
}

/** Why an IK track can't work on a rig ("" = it can). */
export function ikProblem(rig: Pick<Rig, "bones">, track: Pick<IkTrack, "bone" | "tip">): string {
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const bone = byId.get(track.bone);
  const tip = byId.get(track.tip);
  if (!bone) return `unknown bone "${track.bone}"`;
  if (!tip) return `unknown tip bone "${track.tip}"`;
  if (tip.parent !== bone.id) return `tip "${tip.id}" is not a child of "${bone.id}" (its parent is ${tip.parent === null ? "none" : `"${tip.parent}"`})`;
  if (bone.parent === null) return `"${bone.id}" is the root: IK turns a bone's parent too`;
  return "";
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const det = (m: PoseMat | undefined) => (m ? m[0] * m[3] - m[2] * m[1] : 1);

/**
 * Solve the clip's IK tracks at normalized time t on `channels` (changed in place): each track
 * turns its upper bone (bone's parent) and `bone` so the tip's pivot reaches the target (straight
 * toward it when out of reach), and turns the tip so it keeps the angle it has without those two
 * bones' rotations (its own track still turns it).
 * Tracks on bones the rig lacks are skipped. Mirrors rig_view.gd _solve_ik.
 */
export function solveIk(rig: Pick<Rig, "bones">, clip: Pick<Clip, "ik">, t: number, channels: Map<string, BoneChannels>): void {
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const get = (id: string) => {
    let c = channels.get(id);
    if (!c) channels.set(id, (c = { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 }));
    return c;
  };
  for (const track of clip.ik ?? []) {
    if (ikProblem(rig, track)) continue;
    const lower = byId.get(track.bone)!;
    const upper = byId.get(lower.parent!)!;
    const [tx, ty] = keysAt(track.keys, t, track.ease) as [number, number];
    // The tip keeps the angle it has with the limb's two rotations left out (they are overridden): a
    // planted foot stays level with the hips unless its own track turns it.
    const unturned = new Map(channels);
    for (const id of [upper.id, lower.id]) unturned.set(id, { ...get(id), rotate: 0 });
    const tipAngle0 = angleOf(posesFrom(rig, unturned).get(track.tip)!);
    let poses = posesFrom(rig, channels);
    for (let pass = 0; pass < 2; pass++) {
      const s = origin(poses.get(upper.id)!);
      const e = origin(poses.get(lower.id)!);
      const w = origin(poses.get(track.tip)!);
      const l1 = Math.hypot(e[0] - s[0], e[1] - s[1]);
      const l2 = Math.hypot(w[0] - e[0], w[1] - e[1]);
      if (l1 < 1e-6 || l2 < 1e-6) break;
      const solved = twoBone(s, l1, l2, [tx, ty], track.bend, Math.atan2(w[1] - s[1], w[0] - s[0]));
      const sign1 = Math.sign(det(upper.parent !== null ? poses.get(upper.parent) : undefined)) || 1;
      get(upper.id).rotate += (sign1 * wrap(solved.upper - Math.atan2(e[1] - s[1], e[0] - s[0])) * 180) / Math.PI;
      poses = posesFrom(rig, channels);
      const e2 = origin(poses.get(lower.id)!);
      const w2 = origin(poses.get(track.tip)!);
      const sign2 = Math.sign(det(poses.get(upper.id))) || 1;
      get(lower.id).rotate += (sign2 * wrap(Math.atan2(solved.reach[1] - e2[1], solved.reach[0] - e2[0]) - Math.atan2(w2[1] - e2[1], w2[0] - e2[0])) * 180) / Math.PI;
      poses = posesFrom(rig, channels);
    }
    const sign3 = Math.sign(det(poses.get(lower.id))) || 1;
    get(track.tip).rotate += (sign3 * wrap(tipAngle0 - angleOf(poses.get(track.tip)!)) * 180) / Math.PI;
  }
}

const origin = (m: PoseMat): [number, number] => [m[4], m[5]];
const angleOf = (m: PoseMat) => Math.atan2(m[1], m[0]);

/**
 * Two bones of lengths l1, l2 from `s` reaching for `target`: the upper bone's angle and where the
 * tip lands (the target, or the nearest point the limb reaches along the line to it). `bend` cw puts
 * the joint clockwise of the line (a right-facing knee in front). `fallback` is the direction used
 * when the target sits on `s`.
 */
export function twoBone(s: readonly [number, number], l1: number, l2: number, target: readonly [number, number], bend: "cw" | "ccw", fallback = Math.PI / 2): { upper: number; reach: [number, number] } {
  const vx = target[0] - s[0];
  const vy = target[1] - s[1];
  const d = Math.hypot(vx, vy);
  const base = d > 1e-6 ? Math.atan2(vy, vx) : fallback;
  const dc = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-6), l1 + l2);
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc)));
  const a = Math.acos(cosA);
  return { upper: base + (bend === "cw" ? -a : a), reach: [s[0] + dc * Math.cos(base), s[1] + dc * Math.sin(base)] };
}
