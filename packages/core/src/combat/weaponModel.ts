import type { HitShape, Weapon, WeaponAttack, WeaponProjectile } from "./weapon.ts";

/**
 * How a weapon attack plays out, frame by frame: its phases and the region it hits. The runtime
 * (game/scripts/combat/weapon_runner.gd, weapon_projectile.gd) does the same arithmetic line for
 * line; game/test/weapons.test.ts plays attacks in both and requires them to agree. The checker
 * (world/logic/check.ts) and the weapon lints read reach from here.
 *
 * Coordinates are px in the wielder's space: the origin at the centre of its body box, facing
 * right (x forward, y down); the runtime mirrors x when it faces left. Every attack runs at the
 * fixed 60 fps: frame 0 is the frame it starts on.
 *
 * - windup, active, recovery: whole frames (active at least one); then the attack is done and its
 *   own cooldown starts.
 * - arc: the blade sweeps from `from` to `to` over the active frames; on active frame i it covers
 *   the slice between the angles at i and i + 1 (so everything within `radius` between the two
 *   angles is passed over once). Angles turn with the aim (0 = along the aim).
 * - box: centred on the wielder's front (the edge of its box along the aim) plus `offset`, its
 *   width along the aim.
 * - thrust: from the wielder's centre, `length` along the aim, `width` across.
 * - projectile: fired on the first active frame from the centre, a fan of `count` across `spread`
 *   degrees around the aim; each frame it falls (gravity), moves, ages, and breaks when its
 *   lifetime runs out or its centre is in a solid.
 * Hits are strict overlaps (touching edges don't hit), like Godot's Rect2.intersects.
 */

export const WEAPON_FPS = 60;
const DT = 1 / WEAPON_FPS;
/** Arc slices are drawn as polygons with a vertex at least every this many degrees (under 0.04% short of the radius). */
const ARC_STEP_DEG = 3;
/** Arc slices wider than this are split, so every polygon stays convex. */
const ARC_CHUNK_DEG = 90;

export interface XY {
  x: number;
  y: number;
}
export interface BodySize {
  width: number;
  height: number;
}
/** [x0, y0, x1, y1] */
export type HitBox = [number, number, number, number];

export const secondsToFrames = (seconds: number) => Math.max(0, Math.round(seconds * WEAPON_FPS));

export interface AttackFrames {
  windup: number;
  active: number;
  recovery: number;
  cooldown: number;
  /** windup + active + recovery: the frame it is done on. */
  total: number;
}

export function attackFrames(attack: Pick<WeaponAttack, "timing" | "cooldown">): AttackFrames {
  const windup = secondsToFrames(attack.timing.windup);
  const active = Math.max(1, secondsToFrames(attack.timing.active));
  const recovery = secondsToFrames(attack.timing.recovery);
  return { windup, active, recovery, cooldown: secondsToFrames(attack.cooldown), total: windup + active + recovery };
}

export type WeaponPhase = "windup" | "active" | "recovery" | "";

/** The phase on frame `frame` of an attack ("" once it is done). */
export function phaseAt(f: AttackFrames, frame: number): WeaponPhase {
  if (frame < f.windup) return "windup";
  if (frame < f.windup + f.active) return "active";
  if (frame < f.total) return "recovery";
  return "";
}

/** Unit aims in wielder space (down only counts in the air). */
export const AIM_VECTORS: Record<"forward" | "up" | "down", XY> = { forward: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

const rad = (deg: number) => (deg * Math.PI) / 180;
const rotate = (v: XY, angle: number): XY => ({ x: v.x * Math.cos(angle) - v.y * Math.sin(angle), y: v.x * Math.sin(angle) + v.y * Math.cos(angle) });

/** The wielder's front along `aim`: how far the edge of its box is from its centre. */
export const frontDistance = (aim: XY, body: BodySize) => Math.abs(aim.x) * (body.width / 2) + Math.abs(aim.y) * (body.height / 2);

function orientedBox(centre: XY, along: number, across: number, angle: number): XY[] {
  const corners: XY[] = [
    { x: along / 2, y: across / 2 },
    { x: -along / 2, y: across / 2 },
    { x: -along / 2, y: -across / 2 },
    { x: along / 2, y: -across / 2 },
  ];
  return corners.map((c) => {
    const r = rotate(c, angle);
    return { x: centre.x + r.x, y: centre.y + r.y };
  });
}

/** The arc's slice from angle a0 to a1 (radians): convex polygons (the centre and points on the arc). */
function arcSlice(radius: number, a0: number, a1: number): XY[][] {
  const out: XY[][] = [];
  const chunks = Math.max(1, Math.ceil(Math.abs(a1 - a0) / rad(ARC_CHUNK_DEG) - 1e-9));
  for (let c = 0; c < chunks; c++) {
    const from = a0 + ((a1 - a0) * c) / chunks;
    const to = a0 + ((a1 - a0) * (c + 1)) / chunks;
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) / rad(ARC_STEP_DEG) - 1e-9));
    const poly: XY[] = [{ x: 0, y: 0 }];
    for (let k = 0; k <= steps; k++) {
      const a = from + ((to - from) * k) / steps;
      poly.push({ x: radius * Math.cos(a), y: radius * Math.sin(a) });
    }
    out.push(poly);
  }
  return out;
}

/** The hit region on active frame `i` (0-based) of `active`, as convex polygons in wielder space. Projectiles: none (they fly on their own). */
export function hitPolygons(shape: HitShape, aim: XY, body: BodySize, i: number, active: number): XY[][] {
  const angle = Math.atan2(aim.y, aim.x);
  switch (shape.type) {
    case "arc": {
      const a0 = angle + rad(shape.from + ((shape.to - shape.from) * i) / active);
      const a1 = angle + rad(shape.from + ((shape.to - shape.from) * (i + 1)) / active);
      return arcSlice(shape.radius, a0, a1);
    }
    case "box": {
      const front = frontDistance(aim, body);
      const offset = rotate({ x: shape.offset[0], y: shape.offset[1] }, angle);
      return [orientedBox({ x: aim.x * front + offset.x, y: aim.y * front + offset.y }, shape.width, shape.height, angle)];
    }
    case "thrust":
      return [orientedBox({ x: (aim.x * shape.length) / 2, y: (aim.y * shape.length) / 2 }, shape.length, shape.width, angle)];
    case "projectile":
      return [];
  }
}

/** Strict overlap of a convex polygon and an axis-aligned box (separating axes). */
export function polygonHitsBox(poly: readonly XY[], box: HitBox): boolean {
  const axes: XY[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k]!;
    const b = poly[(k + 1) % poly.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    if (Math.abs(ex) + Math.abs(ey) > 1e-9) axes.push({ x: -ey, y: ex });
  }
  const corners: XY[] = [
    { x: box[0], y: box[1] },
    { x: box[2], y: box[1] },
    { x: box[2], y: box[3] },
    { x: box[0], y: box[3] },
  ];
  for (const axis of axes) {
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const p of poly) {
      const d = p.x * axis.x + p.y * axis.y;
      pMin = Math.min(pMin, d);
      pMax = Math.max(pMax, d);
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const p of corners) {
      const d = p.x * axis.x + p.y * axis.y;
      bMin = Math.min(bMin, d);
      bMax = Math.max(bMax, d);
    }
    const scale = Math.hypot(axis.x, axis.y);
    if (pMax <= bMin + 1e-9 * scale || bMax <= pMin + 1e-9 * scale) return false;
  }
  return true;
}

/** Strict overlap of a circle and an axis-aligned box. */
export function circleHitsBox(centre: XY, radius: number, box: HitBox): boolean {
  const cx = Math.min(Math.max(centre.x, box[0]), box[2]);
  const cy = Math.min(Math.max(centre.y, box[1]), box[3]);
  return (centre.x - cx) ** 2 + (centre.y - cy) ** 2 < radius * radius;
}

/** Polygons from wielder space to the world: the wielder's centre at `centre`, facing 1 (right) or -1. */
export const toWorld = (poly: readonly XY[], centre: XY, facing: number): XY[] => poly.map((p) => ({ x: centre.x + p.x * facing, y: centre.y + p.y }));

/** The headings (radians, wielder space) of a projectile fan around `aim`. */
export function fanHeadings(projectile: Pick<WeaponProjectile, "count" | "spread">, aim: XY): number[] {
  const angle = Math.atan2(aim.y, aim.x);
  const n = projectile.count;
  return Array.from({ length: n }, (_, k) => angle + (n === 1 ? 0 : rad(projectile.spread) * (k / (n - 1) - 0.5)));
}

/** Where one projectile is after each frame of flight (wielder space, from the centre), until its lifetime runs out (solids aside). */
export function projectilePath(projectile: Pick<WeaponProjectile, "speed" | "gravity" | "lifetime">, heading: number): XY[] {
  let vx = Math.cos(heading) * projectile.speed;
  let vy = Math.sin(heading) * projectile.speed;
  let x = 0;
  let y = 0;
  let life = projectile.lifetime;
  const out: XY[] = [];
  for (let f = 0; f < 100_000; f++) {
    vy += projectile.gravity * DT;
    x += vx * DT;
    y += vy * DT;
    life -= DT;
    if (life <= 0) break;
    out.push({ x, y });
  }
  return out;
}

/** Every region an attack can hit (wielder space): its polygons on every active frame, or its projectiles' circles along their paths. */
export function attackRegions(attack: Pick<WeaponAttack, "shape" | "timing" | "cooldown">, aim: XY, body: BodySize): { polygons: XY[][]; circles: { centre: XY; radius: number }[] } {
  const f = attackFrames(attack);
  if (attack.shape.type === "projectile") {
    const p = attack.shape.projectile;
    return { polygons: [], circles: fanHeadings(p, aim).flatMap((h) => projectilePath(p, h).map((centre) => ({ centre, radius: p.size }))) };
  }
  const polygons: XY[][] = [];
  for (let i = 0; i < f.active; i++) polygons.push(...hitPolygons(attack.shape, aim, body, i, f.active));
  return { polygons, circles: [] };
}

/** The bounding box of everything an attack can hit (wielder space), or null when it hits nothing. */
export function attackBounds(attack: Pick<WeaponAttack, "shape" | "timing" | "cooldown">, aim: XY, body: BodySize): HitBox | null {
  const { polygons, circles } = attackRegions(attack, aim, body);
  let b: HitBox | null = null;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
  };
  for (const poly of polygons) for (const p of poly) add(p.x, p.y, p.x, p.y);
  for (const c of circles) add(c.centre.x - c.radius, c.centre.y - c.radius, c.centre.x + c.radius, c.centre.y + c.radius);
  return b;
}

/** Does the attack hit `box` (wielder space) anywhere in its active window (projectiles: anywhere along their flight, solids aside)? */
export function attackHits(attack: Pick<WeaponAttack, "shape" | "timing" | "cooldown">, aim: XY, body: BodySize, box: HitBox): boolean {
  const { polygons, circles } = attackRegions(attack, aim, body);
  return polygons.some((p) => polygonHitsBox(p, box)) || circles.some((c) => circleHitsBox(c.centre, c.radius, box));
}

/** The aims an attack's trigger is used with: standing (`ground`) or in the air. Down only counts in the air. */
export function triggerAims(attack: Pick<WeaponAttack, "trigger">, where: "ground" | "air"): XY[] {
  const t = attack.trigger;
  if (t.where !== "both" && t.where !== where) return [];
  const aims = t.aim === "any" ? (["forward", "up", "down"] as const) : [t.aim];
  return aims.filter((a) => a !== "down" || where === "air").map((a) => AIM_VECTORS[a]);
}

/** Attacks that are another attack's combo `next` (used by chaining; a press picks the others first). */
export function comboFollowups(weapon: Pick<Weapon, "attacks">): Set<string> {
  return new Set(weapon.attacks.flatMap((a) => (a.combo.next ? [a.combo.next] : [])));
}

/**
 * The attack a press (hold = 0) or a release after holding `held` seconds picks: one whose trigger
 * matches the aim (`aim`: "forward" | "up" | "down", down only in the air), where the wielder is and
 * the hold; an exact aim beats "any", a longer matching hold beats a shorter one, an attack that is
 * not a combo's next beats one that is, then list order. Mirrors weapon_runner.gd `pick`.
 */
const better = (a: number[], b: number[]) => {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k]! > b[k]!;
  return false;
};

export function pickAttack(weapon: Pick<Weapon, "attacks">, aim: "forward" | "up" | "down", airborne: boolean, held: number | null): WeaponAttack | null {
  const effective = aim === "down" && !airborne ? "forward" : aim;
  const followups = comboFollowups(weapon);
  let best: WeaponAttack | null = null;
  let bestRank: number[] = [];
  for (const a of weapon.attacks) {
    const t = a.trigger;
    if (t.where === "ground" && airborne) continue;
    if (t.where === "air" && !airborne) continue;
    if (t.aim !== "any" && t.aim !== effective) continue;
    if (held === null ? t.hold > 0 : t.hold <= 0 || t.hold > held + 1e-9) continue;
    // Longer hold, then an exact aim, then not a combo's next; ties keep the earlier attack.
    const rank = [t.hold, t.aim === "any" ? 0 : 1, followups.has(a.id) ? 0 : 1];
    if (best === null || better(rank, bestRank)) {
      best = a;
      bestRank = rank;
    }
  }
  return best;
}
