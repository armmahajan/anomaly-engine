import { z } from "zod";
import { Id } from "../common.ts";
import type { OperationResult } from "../operations.ts";
import type { ProjectSpec } from "../schema.ts";
import { fail, parse } from "../world/opHelpers.ts";
import { Grip, Point } from "./rig.ts";

/**
 * Bone editor operations (the creator fixing a rig by hand before animating). Each edits one
 * character asset's rig and is one undoable step. Coordinates are rig space at rest (px, y down,
 * origin at the feet).
 *
 * CONTRACT (weapons target phase 0): the inputs below are fixed; the bodies are implemented by the
 * studio agent (W3) with unit tests. Behaviour each must have:
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
 * Clips keep working: tracks on a removed bone are dropped from the asset's clips.
 */

const AssetBone = { assetId: Id, bone: Id };

export const MoveBonePivotInput = z.strictObject({ ...AssetBone, pivot: Point, carry: z.boolean().default(true) });
export const RotateBoneRestInput = z.strictObject({ ...AssetBone, degrees: z.number().min(-180).max(180) });
export const ScaleBoneInput = z.strictObject({ ...AssetBone, factor: z.number().min(0.25).max(4) });
export const ReassignPartInput = z.strictObject({ assetId: Id, part: Id, bone: Id });
export const AddBoneInput = z.strictObject({ assetId: Id, bone: z.strictObject({ id: Id, parent: Id, pivot: Point }) });
export const RemoveBoneInput = z.strictObject(AssetBone);
export const SetGripInput = z.strictObject({ assetId: Id, grip: Grip });
export const RemoveGripInput = z.strictObject({ assetId: Id, gripId: Id });

const pending = (op: string) => (_project: ProjectSpec, input: unknown, schema: z.ZodType): OperationResult => {
  const p = parse(schema, input, op);
  if (!p.ok) return p;
  return fail("invalid_input", `${op} isn't available yet (the bone editor is being built)`);
};

export const moveBonePivot = (project: ProjectSpec, input: unknown) => pending("moveBonePivot")(project, input, MoveBonePivotInput);
export const rotateBoneRest = (project: ProjectSpec, input: unknown) => pending("rotateBoneRest")(project, input, RotateBoneRestInput);
export const scaleBone = (project: ProjectSpec, input: unknown) => pending("scaleBone")(project, input, ScaleBoneInput);
export const reassignPart = (project: ProjectSpec, input: unknown) => pending("reassignPart")(project, input, ReassignPartInput);
export const addBone = (project: ProjectSpec, input: unknown) => pending("addBone")(project, input, AddBoneInput);
export const removeBone = (project: ProjectSpec, input: unknown) => pending("removeBone")(project, input, RemoveBoneInput);
export const setGrip = (project: ProjectSpec, input: unknown) => pending("setGrip")(project, input, SetGripInput);
export const removeGrip = (project: ProjectSpec, input: unknown) => pending("removeGrip")(project, input, RemoveGripInput);

export const rigEditOperations = { moveBonePivot, rotateBoneRest, scaleBone, reassignPart, addBone, removeBone, setGrip, removeGrip };
