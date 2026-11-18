import { z } from "zod";
import { Clip, type Grip, type OperationCall, type Rig, type Weapon, type WeaponAttack } from "@anomaly/core";
import { channels } from "./motionLimits.ts";
import { decodePng, encodePng, type Pixels } from "./match.ts";
import { WEAPON_POINTS_SYSTEM, weaponPointsPrompt, weaponSpritePrompt, type WeaponClipBrief } from "./prompts.ts";
import { askJson, BudgetExceeded, StageError, type ArtContext, type StageResult } from "./stages.ts";

/**
 * Weapon art: the held sprite (one image, pointing right) with its grip and tip, the rig's `hand`
 * grip, and attack clips that move the held weapon through its attack's shape in its timing. Nothing
 * here knows a kind of weapon: an attack is a shape (arc, box, thrust, projectile) and a timing.
 *
 * Angles are degrees, 0 = forward (+x, the character faces right), positive = clockwise (down,
 * y is down), like the rig's rotate and the weapon's arc angles.
 */

// --- the held sprite -----------------------------------------------------------------------------

export interface WeaponArtInput {
  weaponId: string;
  /** The creator's direction for a redraw. */
  feedback?: string;
}

const Points = z.object({ grip: z.tuple([z.number(), z.number()]), tip: z.tuple([z.number(), z.number()]), notes: z.string().max(500).optional() });

/** The longest side of a stored weapon sprite, px. */
const SPRITE_MAX = 512;
/** The longest side of the image the vision model sees. */
const POINTS_VIEW = 512;
const POINTS_GRID = 32;
/** Alpha at or above this is the object. */
const OPAQUE = 96;

/** How long a weapon looks in the hand, game px (grip to tip): from its longest melee reach, else a short one. */
export function heldLength(weapon: Pick<Weapon, "attacks">): number {
  let reach = 0;
  for (const a of weapon.attacks) {
    const s = a.shape;
    if (s.type === "arc") reach = Math.max(reach, s.radius);
    else if (s.type === "thrust") reach = Math.max(reach, s.length);
    else if (s.type === "box") reach = Math.max(reach, s.width);
  }
  return reach > 0 ? Math.round(Math.min(90, Math.max(16, reach * 0.55))) : 22;
}

/**
 * Draw a weapon's held sprite: one image (transparent, pointing right, in the project's look), trimmed
 * to the object; the vision model finds the grip and tip, code checks them (the grip on the object,
 * the tip at its far end) and mirrors a sprite that points left. Writes sprite, grip, tip and scale.
 */
export async function weaponArtStage(ctx: ArtContext, input: WeaponArtInput): Promise<StageResult> {
  const project = ctx.project();
  const weapon = project.weapons.list.find((w) => w.id === input.weaponId);
  if (!weapon) throw new StageError(`no weapon "${input.weaponId}" (weapons: ${project.weapons.list.map((w) => w.id).join(", ") || "none yet"})`);
  if (ctx.signal?.aborted) throw new StageError("cancelled");
  const prompt = weaponSpritePrompt({
    name: weapon.name,
    description: weapon.description,
    brief: weapon.art.brief,
    direction: project.art.direction,
    game: project.name,
    feedback: input.feedback,
  });
  const img = await ctx.image.generate({ prompt, aspectRatio: "3:2", transparent: true, quality: "low", signal: ctx.signal });
  ctx.spend(img.usage);
  ctx.log({ text: `${weapon.name} (${img.model}, low)`, cost: img.usage.cost, file: await ctx.files.put(img.image, img.ext) });
  const [piece] = await ctx.renderer.sliceGrid(img.image, 1, 1, SPRITE_MAX);
  if (!piece) throw new StageError(`the image of ${weapon.name} came back empty`);
  let pixels = decodePng(piece.png);
  if (opaqueCount(pixels) < 16) throw new StageError(`the image of ${weapon.name} came back empty`);

  let found: { grip: [number, number]; tip: [number, number] } | null = null;
  try {
    const k = POINTS_VIEW / Math.max(pixels.width, pixels.height);
    const size = { width: Math.round(pixels.width * k), height: Math.round(pixels.height * k) };
    const view = await ctx.renderer.compose({ ...size, background: "#c8c8c8", layers: [{ image: piece.png }], grid: POINTS_GRID });
    const reply = await askJson(
      ctx,
      Points,
      { system: WEAPON_POINTS_SYSTEM, content: [{ type: "image", image: view }, { type: "text", text: weaponPointsPrompt({ name: weapon.name, ...pixels, scale: k }) }], maxTokens: 2000 },
      `finding ${weapon.name}'s grip and tip`,
    );
    found = { grip: [reply.grip[0] / k, reply.grip[1] / k], tip: [reply.tip[0] / k, reply.tip[1] / k] };
  } catch (error) {
    if (error instanceof BudgetExceeded || ctx.signal?.aborted) throw error;
    ctx.log({ text: `could not find the grip by eye (${error instanceof Error ? error.message : String(error)}); placing it by shape` });
  }
  const checked = checkWeaponPoints(pixels, found);
  for (const note of checked.notes) ctx.log({ text: note });
  let { grip, tip } = checked;
  if (tip[0] < grip[0]) {
    pixels = mirrorX(pixels);
    grip = [pixels.width - 1 - grip[0], grip[1]];
    tip = [pixels.width - 1 - tip[0], tip[1]];
    ctx.log({ text: "mirrored it to point right" });
  }
  const sprite = await ctx.files.put(encodePng(pixels), "png");
  const length = Math.hypot(tip[0] - grip[0], tip[1] - grip[1]);
  const scale = Math.round(Math.min(10, Math.max(0.05, heldLength(weapon) / Math.max(length, 1))) * 1000) / 1000;
  ctx.log({ text: `${weapon.name}: grip [${grip.map(Math.round).join(", ")}], tip [${tip.map(Math.round).join(", ")}], ${heldLength(weapon)} px long in the hand`, file: sprite });
  const round = (p: [number, number]): [number, number] => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
  const operations: OperationCall[] = [{ name: "updateWeapon", input: { weaponId: weapon.id, art: { sprite, grip: round(grip), tip: round(tip), scale } } }];
  return { operations, summary: `drew ${weapon.name}` };
}

function opaqueCount(p: Pixels): number {
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i]! >= OPAQUE) n++;
  return n;
}

function mirrorX(p: Pixels): Pixels {
  const data = new Uint8Array(p.data.length);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const from = (y * p.width + x) * 4;
      data.set(p.data.subarray(from, from + 4), (y * p.width + (p.width - 1 - x)) * 4);
    }
  }
  return { width: p.width, height: p.height, data };
}

/**
 * The grip and tip, checked on the sprite's pixels: the grip must be on the object (else the nearest
 * opaque pixel), the tip at its far end (at least 85% as far from the grip as the farthest opaque
 * pixel, else that pixel). Without points (no reply), the object's long axis decides: the grip a
 * sixth of the way in from its left end, the tip at its right end.
 */
export function checkWeaponPoints(p: Pixels, found: { grip: [number, number]; tip: [number, number] } | null): { grip: [number, number]; tip: [number, number]; notes: string[] } {
  const notes: string[] = [];
  const opaque: [number, number][] = [];
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) if (p.data[(y * p.width + x) * 4 + 3]! >= OPAQUE) opaque.push([x + 0.5, y + 0.5]);
  if (opaque.length === 0) return { grip: [0, 0], tip: [p.width, 0], notes: ["the sprite has no opaque pixels"] };
  const nearest = (q: [number, number]) => opaque.reduce((best, o) => (dist(o, q) < dist(best, q) ? o : best));
  const farthest = (q: [number, number]) => opaque.reduce((best, o) => (dist(o, q) > dist(best, q) ? o : best));
  let grip: [number, number];
  let tip: [number, number];
  if (!found) {
    const ends = axisEnds(opaque);
    const left = ends[0][0] <= ends[1][0] ? ends[0] : ends[1];
    const right = left === ends[0] ? ends[1] : ends[0];
    grip = nearest([left[0] + (right[0] - left[0]) / 6, left[1] + (right[1] - left[1]) / 6]);
    tip = right;
    return { grip, tip, notes };
  }
  grip = found.grip;
  const onGrip = nearest(grip);
  if (dist(onGrip, grip) > 3) {
    notes.push(`the grip was off the object by ${Math.round(dist(onGrip, grip))} px: moved onto it`);
    grip = onGrip;
  }
  tip = found.tip;
  const far = farthest(grip);
  if (dist(tip, grip) < 0.85 * dist(far, grip)) {
    notes.push("the tip was not at the far end: moved to the object's far end");
    tip = far;
  } else if (dist(nearest(tip), tip) > 3) {
    tip = nearest(tip);
  }
  return { grip, tip, notes };
}

const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The two ends of a pixel cloud along its long axis (principal component). */
function axisEnds(points: [number, number][]): [[number, number], [number, number]] {
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) (mx += x, my += y);
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d: [number, number] = [Math.cos(angle), Math.sin(angle)];
  let lo = points[0]!;
  let hi = points[0]!;
  for (const p of points) {
    const t = (p[0] - mx) * d[0] + (p[1] - my) * d[1];
    if (t < (lo[0] - mx) * d[0] + (lo[1] - my) * d[1]) lo = p;
    if (t > (hi[0] - mx) * d[0] + (hi[1] - my) * d[1]) hi = p;
  }
  return [lo, hi];
}

// --- the rig's hand grip ---------------------------------------------------------------------------

/** Words of an id ("arm_near_lower" -> arm, near, lower; "forearmL" -> forearml). */
const words = (id: string) => id.toLowerCase().split(/[^a-z]+/).filter(Boolean);
const ARM_WORD = /^((fore|upper|lower|up|low)?arms?|forearm[lr]?|arm[lr]|hands?|hand[lr]|wrists?|fists?|elbows?|palms?|claws?|paws?|grip)$/;
const NOT_ARM_WORD = /^(legs?|foot|feet|thighs?|shins?|knees?|tails?|wings?|ears?|hair|cloak|cape)$/;
const HAND_WORD = /^(hands?|hand[lr]|fists?|palms?|paws?|claws?|grip)$/;
const ARM = { test: (id: string) => words(id).some((w) => ARM_WORD.test(w)) };
const NOT_ARM = { test: (id: string) => words(id).some((w) => NOT_ARM_WORD.test(w)) };
const HAND = { test: (id: string) => words(id).some((w) => HAND_WORD.test(w)) };

type Shape = Rig["parts"][number]["shape"];

function shapePoints(shape: Shape): [number, number][] {
  if (shape.type === "ellipse") {
    const { center: c, rx, ry } = shape;
    const a = (shape.rotation * Math.PI) / 180;
    return Array.from({ length: 12 }, (_, i) => {
      const t = (i / 12) * 2 * Math.PI;
      return [c[0] + rx * Math.cos(t) * Math.cos(a) - ry * Math.sin(t) * Math.sin(a), c[1] + rx * Math.cos(t) * Math.sin(a) + ry * Math.sin(t) * Math.cos(a)] as [number, number];
    });
  }
  return shape.points.map((p) => [p[0], p[1]] as [number, number]);
}

const centre = (pts: [number, number][]): [number, number] => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};

/** A bone of an arm: its id, or one of its parts' ids, names an arm or hand (and no leg, tail or wing). */
function isArmBone(rig: Rig, id: string): boolean {
  if (NOT_ARM.test(id)) return false;
  return ARM.test(id) || rig.parts.some((p) => p.bone === id && ARM.test(p.id) && !NOT_ARM.test(p.id));
}

const normAngle = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Degrees the held weapon turns forward of the forearm (a cocked wrist): a hanging arm holds it down
 * and forward, and pointing it anywhere in front (an arc's sweep, a thrust) keeps the arm in front
 * of the body rather than swinging it behind.
 */
const GRIP_TURN = 35;

/**
 * Where a humanoid rig holds a weapon: the `hand` grip at the end of its front arm (the arm path's
 * last bone whose parts are drawn in front), at its hand part if it has one, else near the far end
 * of its parts; at rest the weapon points GRIP_TURN forward of the forearm (down and forward when
 * the arm hangs). Null when the rig has no arm.
 */
export function handGrip(rig: Rig): Grip | null {
  const partsOf = new Map<string, Rig["parts"]>();
  for (const p of rig.parts) partsOf.set(p.bone, [...(partsOf.get(p.bone) ?? []), p]);
  const arms = rig.bones.filter((b) => b.parent !== null && isArmBone(rig, b.id));
  const ends = arms.filter((b) => !arms.some((c) => c.parent === b.id) && (partsOf.get(b.id)?.length ?? 0) > 0);
  if (ends.length === 0) return null;
  const front = (b: Rig["bones"][number]) => Math.max(...(partsOf.get(b.id) ?? []).map((p) => p.z));
  const end = ends.reduce((best, b) => (front(b) > front(best) || (front(b) === front(best) && b.pivot[0] > best.pivot[0]) ? b : best));
  const parts = partsOf.get(end.id)!;
  const pivot: [number, number] = [end.pivot[0], end.pivot[1]];
  const all = parts.flatMap((p) => shapePoints(p.shape));
  const far = all.reduce((best, q) => (dist(q, pivot) > dist(best, pivot) ? q : best), all[0]!);
  const hand = parts.find((p) => HAND.test(p.id));
  let at: [number, number] = hand ? centre(shapePoints(hand.shape)) : [pivot[0] + 0.85 * (far[0] - pivot[0]), pivot[1] + 0.85 * (far[1] - pivot[1])];
  if (dist(at, pivot) < 1) at = [pivot[0] + 0.85 * (far[0] - pivot[0]), pivot[1] + 0.85 * (far[1] - pivot[1])];
  const along = dist(at, pivot) >= 1 ? at : far;
  const forearm = (Math.atan2(along[1] - pivot[1], along[0] - pivot[0]) * 180) / Math.PI;
  return { id: "hand", bone: end.id, at: [r1(at[0]), r1(at[1])], angle: Math.round(normAngle(forearm - GRIP_TURN)) };
}

/** The rig with a `hand` grip (a valid one it has is kept). Never fails: a rig without arms comes back as it was. */
export function withHandGrip(rig: Rig): Rig {
  try {
    const bones = new Set(rig.bones.map((b) => b.id));
    const kept = (rig.grips ?? []).filter((g) => bones.has(g.bone));
    if (kept.some((g) => g.id === "hand")) return kept.length === (rig.grips ?? []).length ? rig : { ...rig, grips: kept };
    const grip = handGrip(rig);
    if (!grip) return kept.length > 0 ? { ...rig, grips: kept } : rig;
    return { ...rig, grips: [...kept, grip].slice(0, 4) };
  } catch {
    return rig;
  }
}

// --- posing: the grip on a clip's pose (mirrors rig_view.gd) ------------------------------------

/** An affine transform [a, b, c, d, tx, ty]: x' = a x + c y + tx, y' = b x + d y + ty. */
type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const move = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
const apply = (m: Mat, [x, y]: readonly [number, number]): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Each bone's pose at normalized time t of a clip (null = rest): bone-local offsets from its pivot -> rig space. */
export function bonePoses(rig: Rig, clip: Clip | null, t: number): Map<string, Mat> {
  const poses = new Map<string, Mat>();
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const place = (id: string, seen: Set<string>): Mat => {
    const known = poses.get(id);
    if (known) return known;
    const bone = byId.get(id)!;
    const c = clip ? channels(clip, id, t) : { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 };
    const r = (c.rotate * Math.PI) / 180;
    const local: Mat = [Math.cos(r) * c.scaleX, Math.sin(r) * c.scaleX, -Math.sin(r) * c.scaleY, Math.cos(r) * c.scaleY, c.x, c.y];
    const parent = bone.parent !== null && byId.has(bone.parent) && !seen.has(bone.parent) ? byId.get(bone.parent)! : null;
    const pose = parent
      ? mul(mul(place(parent.id, new Set([...seen, id])), move(bone.pivot[0] - parent.pivot[0], bone.pivot[1] - parent.pivot[1])), local)
      : mul(move(bone.pivot[0], bone.pivot[1]), local);
    poses.set(id, pose);
    return pose;
  };
  for (const b of rig.bones) place(b.id, new Set());
  return poses;
}

/** The grip on a pose: where the hand is (rig space) and the angle the weapon points (degrees). */
export function gripAt(rig: Rig, grip: Grip, clip: Clip | null, t: number): { at: [number, number]; angle: number } {
  const bone = rig.bones.find((b) => b.id === grip.bone);
  if (!bone) return { at: [grip.at[0], grip.at[1]], angle: grip.angle };
  const pose = bonePoses(rig, clip, t).get(bone.id)!;
  const local: [number, number] = [grip.at[0] - bone.pivot[0], grip.at[1] - bone.pivot[1]];
  const at = apply(pose, local);
  const a = (grip.angle * Math.PI) / 180;
  const dir: [number, number] = [pose[0] * Math.cos(a) + pose[2] * Math.sin(a), pose[1] * Math.cos(a) + pose[3] * Math.sin(a)];
  return { at, angle: (Math.atan2(dir[1], dir[0]) * 180) / Math.PI };
}

/** The held weapon's far end on a pose (rig space), `length` game px from the hand. */
export function tipAt(rig: Rig, grip: Grip, clip: Clip | null, t: number, length: number): [number, number] {
  const g = gripAt(rig, grip, clip, t);
  const a = (g.angle * Math.PI) / 180;
  return [g.at[0] + Math.cos(a) * length, g.at[1] + Math.sin(a) * length];
}

/** The bones whose rotation turns the grip, hand bone first, up to the root. */
export function gripBones(rig: Rig, grip: Grip): string[] {
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const path: string[] = [];
  for (let at: string | null = grip.bone; at !== null && byId.has(at) && !path.includes(at); at = byId.get(at)!.parent) path.push(at);
  return path;
}

// --- attack clips ---------------------------------------------------------------------------------

const AIM_ANGLE = { forward: 0, up: -90, down: 90, any: 0 } as const;

/** An attack's timing as one clip: seconds and the normalized times its active window starts and ends. */
export function attackTiming(attack: Pick<WeaponAttack, "timing">): { duration: number; activeFrom: number; activeTo: number } {
  const { windup, active, recovery } = attack.timing;
  const total = windup + active + recovery;
  const duration = Math.min(10, Math.max(0.2, total));
  if (total <= 0) return { duration, activeFrom: 0.2, activeTo: 0.6 };
  return { duration, activeFrom: windup / total, activeTo: (windup + active) / total };
}

type Keys = [number, number][];

/** Keys with strictly increasing times inside 0..1, rounded. */
function cleanKeys(keys: Keys): Keys {
  const out: Keys = [];
  for (const [t, v] of keys) {
    const tt = Math.round(Math.min(1, Math.max(0, t)) * 1000) / 1000;
    if (out.length && tt <= out[out.length - 1]![0]) continue;
    out.push([tt, Math.round(v * 10) / 10]);
  }
  return out;
}

/**
 * The windup's first key: the clip starts at rest unless getting from rest to the cocked pose in
 * the windup would be faster than the hit itself, in which case it starts part of the way there
 * (a snap into the anticipation pose): the fastest motion stays inside the active window.
 */
function windupStart(rest: number, cocked: number, windupSeconds: number, hitSpeed: number): number {
  const allowed = 0.5 * hitSpeed * windupSeconds;
  const gap = cocked - rest;
  return Math.abs(gap) <= allowed ? rest : cocked - Math.sign(gap) * allowed;
}

/**
 * How the held weapon moves through an attack, from its shape and timing ([t, degrees] keys):
 *  - `angles`: where the weapon points. An arc is cocked back past its start in the windup, sweeps
 *    from -> to over the active window and follows through; a thrust or box points along the aim,
 *    projectiles are raised above it and released down onto it early in the active window.
 *  - `reach` (thrust, box, projectile): which way the upper arm points (world degrees): pulled back
 *    (a thrust) or raised (projectiles) in the windup, driven along the aim in the active window (the
 *    hand travels forward with it).
 * Thrusts and projectiles snap into their anticipation pose as they start; everything ends at rest
 * (`rest` = the grip's angle, `restUpper` = the upper arm's rest direction).
 */
export function attackMotion(attack: Pick<WeaponAttack, "shape" | "timing" | "trigger">, rest: number, restUpper = 90): { angles: Keys; reach: Keys | null } {
  const { duration, activeFrom: a, activeTo: b } = attackTiming(attack);
  const windupSeconds = a * duration;
  const activeSeconds = Math.max((b - a) * duration, 0.02);
  const aim = AIM_ANGLE[attack.trigger.aim];
  const s = attack.shape;
  const angles: Keys = [];
  let reach: Keys | null = null;
  if (s.type === "arc") {
    const from = s.from + aim;
    const to = s.to + aim;
    const back = Math.sign(from - to) || -1;
    const cocked = from + back * 20;
    angles.push([0, windupStart(rest, cocked, windupSeconds, Math.abs(to - from) / activeSeconds)]);
    if (a > 0.02) angles.push([a * 0.6, cocked]);
    angles.push([a, from], [b, to], [b + (1 - b) * 0.35, to - back * 8], [1, rest]);
  } else {
    const projectile = s.type === "projectile";
    const raised = projectile ? aim - 30 : aim - 12;
    angles.push([0, raised], [a, raised + 4], [a + (b - a) * (projectile ? 0.4 : 0.6), projectile ? aim + 4 : aim], [b, aim], [1, rest]);
    // The upper arm: pulled back by the body (a thrust) or raised (projectiles), then driven along the aim.
    const back = projectile ? aim - 60 : aim + 110;
    reach = cleanKeys([[0, back], [a, back + (projectile ? 5 : -5)], [a + (b - a) * 0.6, aim], [b, aim], [1, restUpper]]);
  }
  return { angles: cleanKeys(angles), reach };
}

/** Where the held weapon should point over the attack clip (attackMotion's angles). */
export function attackAngles(attack: Pick<WeaponAttack, "shape" | "timing" | "trigger">, rest: number): Keys {
  return attackMotion(attack, rest).angles;
}

/** The attack in words for the clip prompt. */
export function attackShapeText(attack: Pick<WeaponAttack, "shape" | "trigger">): string {
  const s = attack.shape;
  const aim = attack.trigger.aim === "forward" || attack.trigger.aim === "any" ? "" : `, aimed ${attack.trigger.aim}`;
  if (s.type === "arc") return `a swing through an arc from ${s.from}° to ${s.to}° (radius ${s.radius} px)${aim}`;
  if (s.type === "thrust") return `a straight thrust ${s.length} px along the aim${aim}: pull the arm back, then drive the hand and weapon forward, arm extended`;
  if (s.type === "box") return `a short strike into a ${s.width}x${s.height} px area in front${aim}: pull back, then drive the weapon forward`;
  return `fires ${s.projectile.count > 1 ? `${s.projectile.count} projectiles` : "a projectile"} along the aim${aim}: raise the arm and point the weapon, then a sharp release (a small recoil)`;
}

export function weaponClipBrief(weapon: Pick<Weapon, "name">, attack: WeaponAttack, clip: string, rest: number, direction?: string): WeaponClipBrief {
  const timing = attackTiming(attack);
  return { clip, weapon: weapon.name, attack: attack.name, shape: attackShapeText(attack), ...timing, angles: attackAngles(attack, rest), ...(direction ? { direction } : {}) };
}

export interface WeaponClipCheck {
  ok: boolean;
  /** Normalized time the weapon's tip moves fastest. */
  peak: number;
  /** Largest gap between the weapon's angle and its target at a target's time, degrees. */
  angleError: number;
  problems: string[];
}

const SAMPLES = 60;

/** How well a clip moves the held weapon through its attack: the tip's fastest motion inside the active window, the angles near their targets. */
export function checkWeaponClip(rig: Rig, grip: Grip, attack: WeaponAttack, clip: Clip, length: number): WeaponClipCheck {
  const { activeFrom, activeTo } = attackTiming(attack);
  const targets = attackAngles(attack, grip.angle);
  const aimRad = (AIM_ANGLE[attack.trigger.aim] * Math.PI) / 180;
  const [aimX, aimY] = [Math.cos(aimRad), Math.sin(aimRad)];
  let peak = 0;
  let fastest = -1;
  let prev = tipAt(rig, grip, clip, 0, length);
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const tip = tipAt(rig, grip, clip, t, length);
    // A swing is judged by how fast the tip moves; a thrust or a shot by how fast it is driven along the aim.
    const speed = attack.shape.type === "arc" ? dist(tip, prev) : Math.max(0, (tip[0] - prev[0]) * aimX + (tip[1] - prev[1]) * aimY);
    if (speed > fastest) {
      fastest = speed;
      peak = t - 0.5 / SAMPLES;
    }
    prev = tip;
  }
  let angleError = 0;
  for (const [t, want] of targets) {
    if (t <= 0 || t >= 1) continue;
    angleError = Math.max(angleError, Math.abs(normAngle(gripAt(rig, grip, clip, t).angle - want)));
  }
  const slack = 0.5 / SAMPLES + 0.01;
  const problems: string[] = [];
  if (peak < activeFrom - slack || peak > activeTo + slack) problems.push(`the weapon moves fastest at t ${peak.toFixed(2)}, outside the hit (t ${activeFrom.toFixed(2)}-${activeTo.toFixed(2)})`);
  if (angleError > 25) problems.push(`the weapon is ${Math.round(angleError)}° off where the attack points`);
  return { ok: problems.length === 0, peak, angleError, problems };
}

/** The arm bones of a grip's path: the hand bone, then up while the bones are arm bones (at most the bones below the body). */
function armBones(rig: Rig, grip: Grip): { hand: string; shoulder: string | null; upper: string | null } {
  const path = gripBones(rig, grip);
  // The arm: the run of arm bones from the hand up (never the root); a grip on a bone not named as an
  // arm turns the path's bone below the body (its last two are the body and the root).
  let limb = path.slice(0, -1);
  if (isArmBone(rig, path[0]!)) {
    let n = 1;
    while (n < limb.length && isArmBone(rig, limb[n]!)) n++;
    limb = limb.slice(0, n);
  } else limb = limb.slice(0, Math.max(1, limb.length - 1));
  const shoulder = limb.length ? limb[limb.length - 1]! : null;
  return { hand: path[0]!, shoulder, upper: shoulder && shoulder !== path[0] ? shoulder : null };
}

/** Evaluate keys (smoothstep between them) at t. */
function keyAt(keys: Keys, t: number): number {
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 0; i + 1 < keys.length; i++) {
    const [t0, v0] = keys[i]!;
    const [t1, v1] = keys[i + 1]!;
    if (t >= t0 && t <= t1) {
      const u = (t - t0) / Math.max(t1 - t0, 1e-4);
      return v0 + (v1 - v0) * (u * u * (3 - 2 * u));
    }
  }
  return keys[keys.length - 1]![1];
}

/** Rotate keys that follow each other without jumping a turn (each value within 180° of the one before). */
function unwrap(keys: Keys): Keys {
  const out: Keys = [];
  for (const [t, v] of keys) {
    let x = v;
    const prev = out[out.length - 1];
    if (prev) while (x - prev[1] > 180) x -= 360;
    if (prev) while (x - prev[1] < -180) x += 360;
    out.push([t, Math.round(x * 10) / 10]);
  }
  return out;
}

/** The world direction (degrees) from a bone's pivot to a point on it, posed. */
function boneDirection(rig: Rig, clip: Clip | null, t: number, bone: string, toward: readonly [number, number]): number {
  const b = rig.bones.find((x) => x.id === bone)!;
  const pose = bonePoses(rig, clip, t).get(bone)!;
  const from = apply(pose, [0, 0]);
  const to = apply(pose, [toward[0] - b.pivot[0], toward[1] - b.pivot[1]]);
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

/** Sample times for a fitted track (≤32 keys): every target's own time plus an even spread. */
function sampleTimes(...targets: Keys[]): number[] {
  const own = targets.flatMap((k) => k.map(([t]) => t));
  const n = Math.max(2, 32 - own.length);
  const spread = Array.from({ length: n }, (_, i) => i / (n - 1));
  return [...new Set([...own, ...spread].map((t) => Math.round(t * 1000) / 1000))].sort((x, y) => x - y).slice(0, 32);
}

/**
 * The clip with the arm turned so the held weapon moves through the attack (attackMotion), keeping
 * every other bone's motion. Arcs: the shoulder (the top arm bone) carries the swing. Thrusts, boxes
 * and projectiles on a two-bone arm: the upper arm drives the hand along the aim and the forearm
 * keeps the weapon pointing where the attack does. The arm's rotations are replaced; a rig whose
 * hand hangs straight off the root has nothing to turn and comes back as it was.
 */
export function fitWeaponClip(rig: Rig, grip: Grip, attack: WeaponAttack, clip: Clip): Clip {
  const arm = armBones(rig, grip);
  if (!arm.shoulder) return clip;
  const strip = (c: Clip, bone: string): Clip => ({
    ...c,
    tracks: c.tracks.filter((t) => !(t.bone === bone && t.property === "rotate")),
    motions: c.motions.filter((m) => !(m.bone === bone && m.type === "sway")),
  });
  const upperBone = rig.bones.find((b) => b.id === arm.upper);
  const elbow = arm.upper && arm.hand !== arm.upper ? (rig.bones.find((b) => b.id === arm.hand)?.pivot ?? null) : null;
  const restUpper = upperBone && elbow ? boneDirection(rig, null, 0, upperBone.id, elbow) : 90;
  const motion = attackMotion(attack, grip.angle, restUpper);
  let out = strip(clip, arm.shoulder);
  // Thrust-like attacks on a two-bone arm: the upper arm reaches, the forearm aims.
  if (motion.reach && upperBone && elbow && arm.hand !== arm.shoulder) {
    const times = sampleTimes(motion.reach);
    const keys = times.map((t) => [t, keyAt(motion.reach!, t) - boneDirection(rig, out, t, upperBone.id, elbow)] as [number, number]);
    out = Clip.parse({ ...out, tracks: [...out.tracks, { bone: upperBone.id, property: "rotate", keys: unwrap(keys), ease: "linear" }] });
    const aimBone = arm.hand;
    out = strip(out, aimBone);
    const aimKeys = sampleTimes(motion.angles).map((t) => [t, keyAt(motion.angles, t) - gripAt(rig, grip, out, t).angle] as [number, number]);
    return Clip.parse({ ...out, tracks: [...out.tracks, { bone: aimBone, property: "rotate", keys: unwrap(aimKeys), ease: "linear" }] });
  }
  const keys = sampleTimes(motion.angles).map((t) => [t, keyAt(motion.angles, t) - gripAt(rig, grip, out, t).angle] as [number, number]);
  return Clip.parse({ ...out, tracks: [...out.tracks, { bone: arm.shoulder, property: "rotate", keys: unwrap(keys), ease: "linear" }] });
}
