import { z } from "zod";
import { Id } from "../common.ts";
import type { OperationError, OperationResult } from "../operations.ts";
import { ProjectSpec } from "../schema.ts";
import { ArchitectPlan, ArchitectStage, RoomContent, RoomLink, RoomPlan, RoomTerrain, StageStatus } from "./plan.ts";
import { seedPlan } from "./seedPlan.ts";

/**
 * Architect plan operations: the creator, the studio's Architect view and the
 * Architect chat all edit the plan through these (same contract as
 * ../operations.ts; undoable like any edit). Type-only imports from
 * ../operations.ts avoid a module cycle.
 */

type Fail = { ok: false; error: OperationError };
const fail = (code: OperationError["code"], message: string, issues: OperationError["issues"] = []): Fail => ({ ok: false, error: { code, message, issues } });
const issuesOf = (error: z.ZodError, prefix = "") => error.issues.map((i) => ({ path: prefix + i.path.join("."), message: i.message }));

function commit(project: ProjectSpec, architect: unknown): OperationResult {
  const parsed = ProjectSpec.safeParse({ ...project, architect, revision: project.revision + 1 });
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    return fail("invalid_result", `operation would leave the project invalid: ${issues.map((i) => i.message).join("; ")}`, issues);
  }
  return { ok: true, project: parsed.data };
}

function op<S extends z.ZodType>(Input: S, run: (project: ProjectSpec, input: z.infer<S>) => OperationResult) {
  return (project: ProjectSpec, raw: unknown): OperationResult => {
    const parsed = Input.safeParse(raw);
    if (!parsed.success) return fail("invalid_input", "input is invalid", issuesOf(parsed.error));
    return run(project, parsed.data);
  };
}

function roomOr(project: ProjectSpec, id: string): RoomPlan | Fail {
  const room = project.architect.rooms.find((r) => r.id === id);
  if (room) return room;
  const ids = project.architect.rooms.map((r) => r.id);
  return fail("not_found", `no plan room "${id}"${ids.length ? ` (known: ${ids.join(", ")})` : " (the plan has no rooms)"}`);
}
const isFail = (v: unknown): v is Fail => typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

const pinnedError = (id: string) =>
  fail("invalid_input", `plan room "${id}" is pinned (the creator's): unpin it first (setRoomPinned) to change its plan`);

export const SetArchitectGuidanceInput = z.strictObject({
  guidance: z.string().max(4000).optional().describe("The creator's notes for the whole game."),
  region: z.strictObject({ regionId: Id, notes: z.string().max(2000) }).optional().describe("Notes for one region (empty notes remove them)."),
  targetMinutes: z.tuple([z.number().min(1), z.number().min(1)]).optional().describe("Play time to aim for, [min, max] minutes."),
});
export function setArchitectGuidance(project: ProjectSpec, raw: unknown): OperationResult {
  return op(SetArchitectGuidanceInput, (p, input) => {
    const plan = { ...p.architect };
    if (input.guidance !== undefined) plan.guidance = input.guidance;
    if (input.targetMinutes) plan.target = { minutes: input.targetMinutes };
    if (input.region) {
      const rest = plan.regionNotes.filter((n) => n.regionId !== input.region!.regionId);
      plan.regionNotes = input.region.notes.trim() ? [...rest, input.region] : rest;
    }
    return commit(p, plan);
  })(project, raw);
}

export const SetArchitectPauseInput = z.strictObject({
  pauseAfter: z.array(ArchitectStage).describe("Stages that stop for review when they finish (empty: run straight through)."),
});
export const setArchitectPause = op(SetArchitectPauseInput, (p, input) => commit(p, { ...p.architect, pauseAfter: [...new Set(input.pauseAfter)] }));

export const SetArchitectPlanInput = z.strictObject({
  plan: z.unknown().describe("A whole plan (rooms, links, guidance...). Pinned rooms of the current plan are kept as they are."),
});
/** Replace the plan (the plan stage's output). The creator's pinned rooms survive whatever the new plan says. */
export const setArchitectPlan = op(SetArchitectPlanInput, (p, input) => {
  const parsed = ArchitectPlan.safeParse(input.plan);
  if (!parsed.success) return fail("invalid_input", "plan is invalid", issuesOf(parsed.error, "plan."));
  const pinned = p.architect.rooms.filter((r) => r.pinned);
  const rooms = [...pinned, ...parsed.data.rooms.filter((r) => !pinned.some((k) => k.id === r.id))];
  return commit(p, { ...parsed.data, rooms, stages: p.architect.stages });
});

/** Start the plan from the progression alone (no model): a valid plan to edit or build. */
export const seedArchitectPlan = op(z.strictObject({ maxRoomsPerRegion: z.number().int().min(1).max(40).optional() }), (p, input) =>
  commit(p, seedPlan(p, input)),
);

export const CreateRoomPlanInput = z.strictObject({ room: z.unknown() });
export const createRoomPlan = op(CreateRoomPlanInput, (p, input) => {
  const parsed = RoomPlan.safeParse(input.room);
  if (!parsed.success) return fail("invalid_input", "room is invalid", issuesOf(parsed.error, "room."));
  if (p.architect.rooms.some((r) => r.id === parsed.data.id)) return fail("invalid_input", `plan room "${parsed.data.id}" already exists`);
  return commit(p, { ...p.architect, rooms: [...p.architect.rooms, parsed.data] });
});

export const UpdateRoomPlanInput = z.strictObject({
  roomId: Id,
  changes: z
    .strictObject({
      name: z.string().min(1).max(80).optional(),
      regionId: Id.optional(),
      cols: z.number().int().optional(),
      rows: z.number().int().optional(),
      at: z.strictObject({ x: z.number().int(), y: z.number().int() }).optional(),
      terrain: RoomTerrain.partial().optional(),
      contents: z.array(RoomContent).optional().describe("Replaces the whole list."),
      notes: z.string().max(2000).optional(),
      seed: z.number().int().min(0).optional(),
    })
    .describe("Fields to change (terrain merges; contents replaces)."),
});
export const updateRoomPlan = op(UpdateRoomPlanInput, (p, input) => {
  const room = roomOr(p, input.roomId);
  if (isFail(room)) return room;
  if (room.pinned) return pinnedError(room.id);
  const { terrain, ...rest } = input.changes;
  const next = { ...room, ...rest, terrain: { ...room.terrain, ...terrain } };
  return commit(p, { ...p.architect, rooms: p.architect.rooms.map((r) => (r.id === room.id ? next : r)) });
});

export const DeleteRoomPlanInput = z.strictObject({ roomId: Id });
/** Remove a plan room and its links (the world room it built stays until the geometry stage runs). */
export const deleteRoomPlan = op(DeleteRoomPlanInput, (p, input) => {
  const room = roomOr(p, input.roomId);
  if (isFail(room)) return room;
  if (room.pinned) return pinnedError(room.id);
  return commit(p, {
    ...p.architect,
    rooms: p.architect.rooms.filter((r) => r.id !== room.id),
    links: p.architect.links.filter((l) => l.a.room !== room.id && l.b.room !== room.id),
  });
});

export const LinkRoomsInput = z.strictObject({ link: z.unknown() });
export const linkRooms = op(LinkRoomsInput, (p, input) => {
  const parsed = RoomLink.safeParse(input.link);
  if (!parsed.success) return fail("invalid_input", "link is invalid", issuesOf(parsed.error, "link."));
  if (p.architect.links.some((l) => l.id === parsed.data.id)) return fail("invalid_input", `plan link "${parsed.data.id}" already exists`);
  return commit(p, { ...p.architect, links: [...p.architect.links, parsed.data] });
});

export const UpdateRoomLinkInput = z.strictObject({
  linkId: Id,
  changes: z.strictObject({
    requires: z.array(Id).max(8).optional(),
    oneWay: z.boolean().optional(),
    aSide: z.enum(["left", "right", "top", "bottom"]).nullable().optional().describe("null: let the layout stage choose."),
    bSide: z.enum(["left", "right", "top", "bottom"]).nullable().optional(),
  }),
});
export const updateRoomLink = op(UpdateRoomLinkInput, (p, input) => {
  const link = p.architect.links.find((l) => l.id === input.linkId);
  if (!link) return fail("not_found", `no plan link "${input.linkId}"`);
  const c = input.changes;
  const side = (end: RoomLink["a"], s: typeof c.aSide) => (s === undefined ? end : s === null ? { room: end.room } : { room: end.room, side: s });
  const next: RoomLink = {
    ...link,
    ...(c.requires ? { requires: c.requires } : {}),
    ...(c.oneWay !== undefined ? { oneWay: c.oneWay } : {}),
    a: side(link.a, c.aSide),
    b: side(link.b, c.bSide),
  };
  return commit(p, { ...p.architect, links: p.architect.links.map((l) => (l.id === link.id ? next : l)) });
});

export const UnlinkRoomsInput = z.strictObject({ linkId: Id });
export const unlinkRooms = op(UnlinkRoomsInput, (p, input) => {
  if (!p.architect.links.some((l) => l.id === input.linkId)) return fail("not_found", `no plan link "${input.linkId}"`);
  return commit(p, { ...p.architect, links: p.architect.links.filter((l) => l.id !== input.linkId) });
});

export const SetRoomPinnedInput = z.strictObject({ roomId: Id, pinned: z.boolean() });
/** Pin a room (the creator's: stages leave it and its world room alone) or hand it back to the Architect. */
export const setRoomPinned = op(SetRoomPinnedInput, (p, input) => {
  const room = roomOr(p, input.roomId);
  if (isFail(room)) return room;
  return commit(p, { ...p.architect, rooms: p.architect.rooms.map((r) => (r.id === room.id ? { ...r, pinned: input.pinned } : r)) });
});

export const SetStageStatusInput = z.strictObject({ stage: ArchitectStage, status: StageStatus });
/** Record a stage's progress (the Architect run does this; creators rarely need to). */
export const setStageStatus = op(SetStageStatusInput, (p, input) =>
  commit(p, { ...p.architect, stages: { ...p.architect.stages, [input.stage]: input.status } }),
);

export const architectOperations = {
  setArchitectGuidance,
  setArchitectPause,
  setArchitectPlan,
  seedArchitectPlan,
  createRoomPlan,
  updateRoomPlan,
  deleteRoomPlan,
  linkRooms,
  updateRoomLink,
  unlinkRooms,
  setRoomPinned,
  setStageStatus,
};

export type ArchitectOperationName = keyof typeof architectOperations;
export const ARCHITECT_OPERATION_NAMES = Object.keys(architectOperations) as ArchitectOperationName[];
