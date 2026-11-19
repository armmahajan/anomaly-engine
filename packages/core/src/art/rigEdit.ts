import { z } from "zod";
import { Id } from "../common.ts";
import type { OperationResult } from "../operations.ts";
import type { ProjectSpec } from "../schema.ts";
import { commit, fail, issuesOf, known, parse, type Fail } from "../world/opHelpers.ts";
import { CharacterAsset } from "./asset.ts";
import type { Clip } from "./clip.ts";
import { Grip, MAX_BONES, MAX_GRIPS, Point, Rig, rigFingerprint, type Part, type Shape } from "./rig.ts";

/**
 * Bone editor operations (the creator fixing a rig by hand before animating). Each edits one
 * character asset's rig and is one undoable step. Coordinates are rig space at rest (px, y down,
 * origin at the feet).
 *
 * CONTRACT (weapons target phase 0): the inputs below are fixed. Behaviour:
 * - moveBonePivot: the bone's pivot moves to `pivot`; with `carry` (default true) the bone's own
 *   parts and every descendant bone and part move with it by the same offset, so the drawing
 *   follows the joint; without, only the pivot moves (re-centering the rotation point).
 * - rotateBoneRest: rotates the bone's descendants (bones and parts, the shapes' points) around the
 *   bone's pivot by `degrees` (a resting angle change: an arm hanging further out).
 * - scaleBone: scales the bone's own parts and moves its descendants away from (or toward) its pivot
 *   by `factor` along the line to each child pivot (a longer or shorter limb).
 * - reassignPart: moves a part to another bone (its shape stays where it is).
 * - addBone: a new bone under `parent` at `pivot` (ids unique; MAX_BONES).
 * - removeBone: removes a non-root bone; its parts and child bones go to its parent.
 * - setGrip: adds or replaces a grip by id; removeGrip removes one.
 * Clips keep working: tracks (and IK) on a removed bone are dropped from the asset's clips.
 *
 * Grips move with their bone like its parts (their angle turns with a rest rotation). Textures
 * move and scale with their part (a rest rotation turns where the texture sits, not the image).
 * Cutout image parts show the source image through their polygon at its rest place, so moving
 * them would show other pixels: carrying, rotating or scaling bones with image parts is refused
 * (moving a pivot without carry, reassigning and adding or removing bones work on every rig).
 */

const AssetBone = { assetId: Id, bone: Id };

export const MoveBonePivotInput = z.strictObject({ ...AssetBone, pivot: Point, carry: z.boolean().default(true) });
export const RotateBoneRestInput = z.strictObject({ ...AssetBone, degrees: z.number().min(-180).max(180), carry: z.boolean().default(true) });
export const ScaleBoneInput = z.strictObject({ ...AssetBone, factor: z.number().min(0.25).max(4) });
export const ReassignPartInput = z.strictObject({ assetId: Id, part: Id, bone: Id });
export const AddBoneInput = z.strictObject({ assetId: Id, bone: z.strictObject({ id: Id, parent: Id, pivot: Point }) });
export const RemoveBoneInput = z.strictObject(AssetBone);
export const SetGripInput = z.strictObject({ assetId: Id, grip: Grip });
export const RemoveGripInput = z.strictObject({ assetId: Id, gripId: Id });
export const SwapBonesInput = z.strictObject({ assetId: Id, a: Id, b: Id });

// --- geometry ---------------------------------------------------------------

type Vec = readonly [number, number];
/** A map of rig space onto itself: where a point goes, how much lengths scale and angles turn. */
interface Transform {
  point: (p: Vec) => [number, number];
  scale: number;
  degrees: number;
}

const round = (n: number) => Math.round(n * 100) / 100;
const pt = (x: number, y: number): [number, number] => [round(x), round(y)];

const translate = (dx: number, dy: number): Transform => ({ point: ([x, y]) => pt(x + dx, y + dy), scale: 1, degrees: 0 });
/** Clockwise on screen (y down), like clip rotations. */
function rotate(center: Vec, degrees: number): Transform {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    point: ([x, y]) => {
      const dx = x - center[0];
      const dy = y - center[1];
      return pt(center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos);
    },
    scale: 1,
    degrees,
  };
}
const scaleAbout = (center: Vec, factor: number): Transform => ({
  point: ([x, y]) => pt(center[0] + (x - center[0]) * factor, center[1] + (y - center[1]) * factor),
  scale: factor,
  degrees: 0,
});

const angle = (degrees: number) => {
  let a = degrees % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return round(a);
};

function moveShape(shape: Shape, t: Transform): Shape {
  switch (shape.type) {
    case "ellipse":
      return { ...shape, center: t.point(shape.center), rx: round(shape.rx * t.scale), ry: round(shape.ry * t.scale), rotation: angle(shape.rotation + t.degrees) };
    case "stroke":
      return {
        ...shape,
        points: shape.points.map(t.point),
        width: round(shape.width * t.scale),
        ...(shape.widthEnd !== undefined && { widthEnd: round(shape.widthEnd * t.scale) }),
      };
    case "blob":
    case "image":
      return { ...shape, points: shape.points.map(t.point) };
    case "mesh":
      // The texture travels with its vertices (uv per vertex), so a mesh can move, turn and scale.
      return { ...shape, points: shape.points.map(t.point), inner: shape.inner.map(t.point) };
  }
}

function movePart(part: Part, t: Transform): Part {
  const moved: Part = { ...part, shape: moveShape(part.shape, t) };
  if (part.texture) {
    // The texture's rectangle stays axis-aligned: its centre follows the part and its size scales.
    const [x, y, w, h] = part.texture.rect;
    const [cx, cy] = t.point([x + w / 2, y + h / 2]);
    const sw = round(w * t.scale);
    const sh = round(h * t.scale);
    moved.texture = { ...part.texture, rect: [round(cx - sw / 2), round(cy - sh / 2), sw, sh] };
  }
  return moved;
}

const moveGrip = (grip: Grip, t: Transform): Grip => ({ ...grip, at: t.point(grip.at), angle: angle(grip.angle + t.degrees) });

// --- rig helpers ------------------------------------------------------------

/** The bone and every bone under it. */
export function boneSubtree(rig: Rig, boneId: string): Set<string> {
  const ids = new Set([boneId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of rig.bones) {
      if (b.parent !== null && ids.has(b.parent) && !ids.has(b.id)) {
        ids.add(b.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Move the bones in `bones` (pivots, parts and grips on them) by `t`. */
function moveBones(rig: Rig, bones: ReadonlySet<string>, t: Transform, pivots = true): Rig {
  return {
    ...rig,
    bones: rig.bones.map((b) => (pivots && bones.has(b.id) ? { ...b, pivot: t.point(b.pivot) } : b)),
    parts: rig.parts.map((p) => (bones.has(p.bone) ? movePart(p, t) : p)),
    ...(rig.grips && { grips: rig.grips.map((g) => (bones.has(g.bone) ? moveGrip(g, t) : g)) }),
  };
}

type Found = { ok: true; index: number; asset: CharacterAsset; rig: Rig };

function findRig(project: ProjectSpec, assetId: string): Found | Fail {
  const index = project.art.assets.findIndex((a) => a.id === assetId);
  const asset = project.art.assets[index];
  if (!asset) return fail("not_found", `no asset "${assetId}"${known(project.art.assets.map((a) => a.id))}`);
  if (asset.kind !== "character") return fail("invalid_input", `asset "${assetId}" is a ${asset.kind}, not a character`);
  if (!asset.rig) return fail("not_found", `asset "${assetId}" has no rig yet`);
  return { ok: true, index, asset, rig: asset.rig };
}

function findBone(found: Found, boneId: string): Fail | null {
  return found.rig.bones.some((b) => b.id === boneId) ? null : fail("not_found", `the rig of "${found.asset.id}" has no bone "${boneId}"${known(found.rig.bones.map((b) => b.id))}`);
}

/** Image parts can't move (they show the source at its rest place). */
function imagesIn(rig: Rig, bones: ReadonlySet<string>, op: string): Fail | null {
  const images = rig.parts.filter((p) => bones.has(p.bone) && p.shape.type === "image").map((p) => p.id);
  if (images.length === 0) return null;
  return fail("invalid_input", `${op} would move cutout image parts (${images.join(", ")}), which show the design at its place; move the pivot without carry instead, or rebuild the rig`);
}

/** Save the edited rig (and clips) into the asset, checking the rig. */
function save(project: ProjectSpec, found: Found, rig: Rig, clips?: Record<string, Clip>): OperationResult {
  const checked = Rig.safeParse(rig);
  if (!checked.success) return fail("invalid_input", `the rig would be invalid: ${checked.error.issues.map((i) => i.message).join("; ")}`, issuesOf(checked.error, "rig."));
  const asset = CharacterAsset.safeParse({ ...found.asset, rig: checked.data, ...(clips && { clips }) });
  if (!asset.success) return fail("invalid_input", "the asset would be invalid", issuesOf(asset.error));
  const assets = project.art.assets.slice();
  assets[found.index] = asset.data;
  return commit({ ...project, art: { ...project.art, assets } });
}

// --- operations -------------------------------------------------------------

/** Move a bone's pivot; with `carry`, the bone's drawing and everything under it follow. */
export function moveBonePivot(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(MoveBonePivotInput, input, "moveBonePivot");
  if (!p.ok) return p;
  const { assetId, bone, pivot, carry } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const missing = findBone(found, bone);
  if (missing) return missing;
  const { rig } = found;
  const from = rig.bones.find((b) => b.id === bone)!.pivot;
  if (!carry) return save(project, found, { ...rig, bones: rig.bones.map((b) => (b.id === bone ? { ...b, pivot: pt(pivot[0], pivot[1]) } : b)) });
  const subtree = boneSubtree(rig, bone);
  const images = imagesIn(rig, subtree, "Carrying the drawing");
  if (images) return images;
  return save(project, found, moveBones(rig, subtree, translate(pivot[0] - from[0], pivot[1] - from[1])));
}

/**
 * Turn a bone's resting angle about its pivot. With carry (default) its drawing and everything under
 * it turn too; without, only the joints under it swing round (the bone is re-aimed, the drawing stays).
 */
export function rotateBoneRest(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(RotateBoneRestInput, input, "rotateBoneRest");
  if (!p.ok) return p;
  const { assetId, bone, degrees, carry } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const missing = findBone(found, bone);
  if (missing) return missing;
  const subtree = boneSubtree(found.rig, bone);
  if (!carry) {
    const turn = rotate(found.rig.bones.find((b) => b.id === bone)!.pivot, degrees);
    return save(project, found, { ...found.rig, bones: found.rig.bones.map((b) => (b.id !== bone && subtree.has(b.id) ? { ...b, pivot: turn.point(b.pivot) } : b)) });
  }
  const images = imagesIn(found.rig, subtree, "Rotating the bone");
  if (images) return images;
  const pivot = found.rig.bones.find((b) => b.id === bone)!.pivot;
  // The bone's own pivot stays put (rotating it about itself is a no-op).
  return save(project, found, moveBones(found.rig, subtree, rotate(pivot, degrees)));
}

/** Make a bone longer or shorter: its own parts scale about its pivot, and the bones under it move along. */
export function scaleBone(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ScaleBoneInput, input, "scaleBone");
  if (!p.ok) return p;
  const { assetId, bone, factor } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const missing = findBone(found, bone);
  if (missing) return missing;
  let rig = found.rig;
  const images = imagesIn(rig, boneSubtree(rig, bone), "Scaling the bone");
  if (images) return images;
  const pivot = rig.bones.find((b) => b.id === bone)!.pivot;
  rig = moveBones(rig, new Set([bone]), scaleAbout(pivot, factor), false);
  for (const child of rig.bones.filter((b) => b.parent === bone)) {
    const offset = translate((child.pivot[0] - pivot[0]) * (factor - 1), (child.pivot[1] - pivot[1]) * (factor - 1));
    rig = moveBones(rig, boneSubtree(rig, child.id), offset);
  }
  return save(project, found, rig);
}

/** The bone and bendTo a part gets on `bone` (a bend toward its own bone is no bend). */
function onBone(part: Part, bone: string, bendTo: string | undefined): Part {
  const { bendTo: _old, ...rest } = part;
  return bendTo !== undefined && bendTo !== bone ? { ...rest, bone, bendTo } : { ...rest, bone };
}

/** Move a part to another bone; its shape stays where it is. Detail parts clipped to it come along. */
export function reassignPart(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ReassignPartInput, input, "reassignPart");
  if (!p.ok) return p;
  const { assetId, part: partId, bone } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const missing = findBone(found, bone);
  if (missing) return missing;
  const { rig } = found;
  const part = rig.parts.find((x) => x.id === partId);
  if (!part) return fail("not_found", `the rig of "${assetId}" has no part "${partId}"${known(rig.parts.map((x) => x.id))}`);
  const moved = onBone(part, bone, part.bendTo);
  const parts = rig.parts.map((x) => {
    if (x.id === partId) {
      // A detail moved off the part it was clipped to isn't clipped any more.
      const target = x.clipTo !== undefined ? rig.parts.find((t) => t.id === x.clipTo) : undefined;
      if (target && (target.bone !== moved.bone || target.bendTo !== moved.bendTo)) {
        const { clipTo: _gone, ...unclipped } = moved;
        return unclipped;
      }
      return moved;
    }
    return x.clipTo === partId ? onBone(x, moved.bone, moved.bendTo) : x;
  });
  return save(project, found, { ...rig, parts });
}

/**
 * Pair two bones and, down their branches, their children in order (while both have the same number of
 * children): a near/far upper arm with its forearm and hand, say.
 */
export function bonePairs(rig: Rig, a: string, b: string): [string, string][] {
  const children = (id: string) => rig.bones.filter((x) => x.parent === id).map((x) => x.id);
  const pairs: [string, string][] = [[a, b]];
  for (let i = 0; i < pairs.length; i++) {
    const [x, y] = pairs[i]!;
    const cx = children(x);
    const cy = children(y);
    if (cx.length === cy.length) cx.forEach((c, j) => pairs.push([c, cy[j]!]));
  }
  return pairs;
}

/**
 * Two limbs labelled the wrong way round (the near arm planned as the far one): the bones of the two
 * branches (bonePairs) trade names, and their parts trade draw order, so each name now belongs to the
 * limb it says. Nothing moves: joints, drawings and textures stay where they are. A part named after
 * its bone takes the new name too. Clips keep their bone names, so a clip's near arm drives the arm
 * that is now near; clips written for the rig stay current.
 */
export function swapBones(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SwapBonesInput, input, "swapBones");
  if (!p.ok) return p;
  const { assetId, a, b } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const missing = findBone(found, a) ?? findBone(found, b);
  if (missing) return missing;
  const { rig } = found;
  if (a === b) return fail("invalid_input", "pick two different bones to swap");
  if (boneSubtree(rig, a).has(b) || boneSubtree(rig, b).has(a)) return fail("invalid_input", `"${a}" and "${b}" are on the same branch: swap two separate limbs`);
  const swap = new Map<string, string>();
  for (const [x, y] of bonePairs(rig, a, b)) swap.set(x, y).set(y, x);
  const rename = (id: string) => swap.get(id) ?? id;
  // Draw order: each bone's parts take the other bone's place in the stack (its parts' lowest z), keeping their own spacing.
  const lowest = new Map<string, number>();
  for (const part of rig.parts) if (swap.has(part.bone)) lowest.set(part.bone, Math.min(lowest.get(part.bone) ?? Infinity, part.z));
  const partIds = new Map<string, string>();
  for (const part of rig.parts) if (swap.has(part.id) && part.id === part.bone && rig.parts.some((q) => q.id === swap.get(part.id) && q.bone === q.id)) partIds.set(part.id, swap.get(part.id)!);
  const parts = rig.parts.map((part) => {
    const other = swap.get(part.bone);
    const z = other !== undefined && lowest.has(other) ? Math.max(-100, Math.min(100, part.z - lowest.get(part.bone)! + lowest.get(other)!)) : part.z;
    return {
      ...part,
      id: partIds.get(part.id) ?? part.id,
      bone: rename(part.bone),
      ...(part.bendTo !== undefined && { bendTo: rename(part.bendTo) }),
      ...(part.clipTo !== undefined && { clipTo: partIds.get(part.clipTo) ?? part.clipTo }),
      z,
    };
  });
  const swapped: Rig = {
    ...rig,
    bones: rig.bones.map((bone) => ({ ...bone, id: rename(bone.id), parent: bone.parent === null ? null : rename(bone.parent) })),
    parts,
    ...(rig.grips && { grips: rig.grips.map((g) => ({ ...g, bone: rename(g.bone) })) }),
  };
  const result = save(project, found, swapped);
  if (!result.ok || found.asset.clipsFor !== rigFingerprint(rig)) return result;
  // The clips were current and still are (they name bones by what they are): keep them current.
  const assets = result.project.art.assets.map((x, i) => (i === found.index ? { ...x, clipsFor: rigFingerprint(swapped) } : x));
  return { ...result, project: { ...result.project, art: { ...result.project.art, assets } } };
}

/** Add a bone under `parent`. */
export function addBone(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AddBoneInput, input, "addBone");
  if (!p.ok) return p;
  const { assetId, bone } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const { rig } = found;
  if (rig.bones.some((b) => b.id === bone.id)) return fail("invalid_input", `the rig already has a bone "${bone.id}"`);
  const missing = findBone(found, bone.parent);
  if (missing) return missing;
  if (rig.bones.length >= MAX_BONES) return fail("invalid_input", `a rig has at most ${MAX_BONES} bones`);
  return save(project, found, { ...rig, bones: [...rig.bones, { id: bone.id, parent: bone.parent, pivot: pt(bone.pivot[0], bone.pivot[1]) }] });
}

/** Remove a bone (not the root): its parts, child bones and grips go to its parent; clips stop moving it. */
export function removeBone(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(RemoveBoneInput, input, "removeBone");
  if (!p.ok) return p;
  const { assetId, bone } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const missing = findBone(found, bone);
  if (missing) return missing;
  const { rig } = found;
  const parent = rig.bones.find((b) => b.id === bone)!.parent;
  if (parent === null) return fail("invalid_input", `"${bone}" is the root bone; every rig keeps one`);
  const to = (id: string) => (id === bone ? parent : id);
  const next: Rig = {
    ...rig,
    bones: rig.bones.filter((b) => b.id !== bone).map((b) => (b.parent === bone ? { ...b, parent } : b)),
    parts: rig.parts.map((x) => (x.bone === bone || x.bendTo === bone ? onBone(x, to(x.bone), x.bendTo === undefined ? undefined : to(x.bendTo)) : x)),
    ...(rig.grips && { grips: rig.grips.map((g) => (g.bone === bone ? { ...g, bone: parent } : g)) }),
  };
  const clips = Object.fromEntries(
    Object.entries(found.asset.clips).map(([id, clip]) => {
      const ik = clip.ik?.filter((k) => k.bone !== bone && k.tip !== bone);
      return [id, { ...clip, tracks: clip.tracks.filter((t) => t.bone !== bone), motions: clip.motions.filter((m) => m.bone !== bone), ...(ik && { ik }) }];
    }),
  );
  return save(project, found, next, clips);
}

/** Add a grip, or replace the one with the same id. */
export function setGrip(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetGripInput, input, "setGrip");
  if (!p.ok) return p;
  const { assetId, grip } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const missing = findBone(found, grip.bone);
  if (missing) return missing;
  const grips = found.rig.grips ?? [];
  const at = grips.findIndex((g) => g.id === grip.id);
  if (at < 0 && grips.length >= MAX_GRIPS) return fail("invalid_input", `a rig has at most ${MAX_GRIPS} grips`);
  const placed = { ...grip, at: pt(grip.at[0], grip.at[1]) };
  return save(project, found, { ...found.rig, grips: at < 0 ? [...grips, placed] : grips.map((g, i) => (i === at ? placed : g)) });
}

/** Remove a grip (with none, the runtime holds a weapon at the front of the body). */
export function removeGrip(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(RemoveGripInput, input, "removeGrip");
  if (!p.ok) return p;
  const { assetId, gripId } = p.data;
  const found = findRig(project, assetId);
  if (!found.ok) return found;
  const grips = found.rig.grips ?? [];
  if (!grips.some((g) => g.id === gripId)) return fail("not_found", `the rig of "${assetId}" has no grip "${gripId}"${known(grips.map((g) => g.id))}`);
  const { grips: _old, ...rest } = found.rig;
  const left = grips.filter((g) => g.id !== gripId);
  return save(project, found, left.length > 0 ? { ...rest, grips: left } : rest);
}

export const rigEditOperations = { moveBonePivot, rotateBoneRest, scaleBone, reassignPart, swapBones, addBone, removeBone, setGrip, removeGrip };
