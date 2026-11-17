import { z } from "zod";
import {
  ARCHITECT_STAGES,
  ArchitectRunRequest,
  CreateRoomPlanInput,
  DeleteRoomPlanInput,
  LinkRoomsInput,
  planIssues,
  RoomLink,
  RoomPlan,
  SetArchitectGuidanceInput,
  SetArchitectPauseInput,
  SetArchitectPlanInput,
  SetRoomPinnedInput,
  STAGE_DESCRIPTIONS,
  UnlinkRoomsInput,
  UpdateRoomLinkInput,
  UpdateRoomPlanInput,
  type ArchitectOperationName,
  type ProjectSpec,
} from "@anomaly/core";
import { designTools } from "../domains/design.ts";
import { projectSummaryTool, stageOperation, toolset, type Draft, type ToolSpec } from "../tools.ts";

/**
 * The Architect's tools: read the design (progression, wiki) and the plan, check
 * the plan, edit it through the plan operations (staged, saved as one undo step at
 * the end of the turn), and queue a build run that starts after the turn.
 */

const planWarnings = (project: ProjectSpec) => planIssues(project).issues.map((i) => i.message);

/** The plan in compact form (what the model needs to reason about and edit it). */
export function describePlan(project: ProjectSpec) {
  const plan = project.architect;
  const { issues, toCast } = planIssues(project);
  return {
    guidance: plan.guidance,
    regionNotes: plan.regionNotes,
    targetMinutes: plan.target.minutes,
    pauseAfter: plan.pauseAfter,
    stages: Object.fromEntries(ARCHITECT_STAGES.map((s) => [s, plan.stages[s] ? `${plan.stages[s]!.status}: ${plan.stages[s]!.summary}` : "pending"])),
    rooms: plan.rooms,
    links: plan.links,
    issues: issues.map((i) => `${i.code}: ${i.message}`),
    toCast,
    builtRooms: project.world.rooms.filter((r) => plan.rooms.some((p) => p.id === r.id)).map((r) => r.id),
  };
}

const descriptions: Record<Exclude<ArchitectOperationName, "setStageStatus">, string> = {
  setArchitectGuidance: "Set the creator's notes for the whole game, notes for one region, or the play-time target. Use the creator's words; don't invent guidance.",
  setArchitectPause: "Choose the stages after which a build run stops for the creator's review (empty: straight through).",
  setArchitectPlan:
    "Replace the whole plan at once (rooms, links, guidance...). Pinned rooms of the current plan are kept whatever you send. Prefer targeted edits (updateRoomPlan, createRoomPlan, linkRooms) unless restructuring everything.",
  seedArchitectPlan:
    "Start the plan from the progression alone: each region's rooms in a chain, regions linked as the progression joins them (gates copied), start, ending, every ability placed, enemies spread, a save point per region. A good first draft to refine. Keeps pinned rooms.",
  createRoomPlan: `Add a room to the plan. Give it an id (snake_case, also the built room's id), name, regionId, size (cols x rows; 30x14 is one screen), terrain knobs (0..1), contents and notes; then link it.`,
  updateRoomPlan: "Change a room's plan: name, region, size, map position, terrain knobs (merged), contents (replaces the list), notes, seed (a new seed rebuilds it differently). Refused for pinned rooms.",
  deleteRoomPlan: "Remove a room and its links from the plan. Refused for pinned rooms.",
  linkRooms: `Join two rooms with a pair of doors. requires gates passing from a to b (the gate is built in a's room); oneWay makes a drop from a to b; sides are optional (layout chooses).`,
  updateRoomLink: "Change a link's requirements, one-way flag or the sides its doors are on (null: let layout choose).",
  unlinkRooms: "Remove a link.",
  setRoomPinned: "Pin a room (the creator's: no stage rewrites its plan or its built room) or unpin it. Only when the creator asks.",
};

const schemas: Record<Exclude<ArchitectOperationName, "setStageStatus">, z.ZodType> = {
  setArchitectGuidance: SetArchitectGuidanceInput,
  setArchitectPause: SetArchitectPauseInput,
  setArchitectPlan: SetArchitectPlanInput,
  seedArchitectPlan: z.strictObject({ maxRoomsPerRegion: z.number().int().min(1).max(40).optional() }),
  createRoomPlan: CreateRoomPlanInput.extend({ room: RoomPlan }),
  updateRoomPlan: UpdateRoomPlanInput,
  deleteRoomPlan: DeleteRoomPlanInput,
  linkRooms: LinkRoomsInput.extend({ link: RoomLink }),
  updateRoomLink: UpdateRoomLinkInput,
  unlinkRooms: UnlinkRoomsInput,
  setRoomPinned: SetRoomPinnedInput,
};

const writeTools: ToolSpec[] = (Object.keys(schemas) as (keyof typeof schemas)[]).map((name) => ({
  name,
  description: descriptions[name],
  schema: schemas[name],
  run: (draft: Draft, args: unknown) => stageOperation(draft, name, args, planWarnings),
}));

const readTools: ToolSpec[] = [
  {
    name: "getArchitectPlan",
    description:
      "The whole plan: guidance, region notes, target minutes, rooms (size, terrain, contents, notes, seed, pinned), links, stage status, the plan's issues and the enemy characters the cast stage will create. Includes changes staged this turn.",
    schema: z.strictObject({}),
    run: (draft) => ({ ok: true, plan: describePlan(draft.current) }),
  },
  {
    name: "checkPlan",
    description: "Static checks of the plan (regions without rooms, start/ending, unlinked rooms, abilities given nowhere or twice, region joins missing or not gated as the progression says, cramped arenas). Fix every issue before building.",
    schema: z.strictObject({}),
    run: (draft) => {
      const { issues, toCast } = planIssues(draft.current);
      return { ok: true, issues: issues.map((i) => ({ code: i.code, message: i.message, ...(i.roomId ? { roomId: i.roomId } : {}) })), toCast };
    },
  },
  ...(designTools.reads ?? []).map(
    (r): ToolSpec => ({ name: r.name, description: r.description, schema: r.schema, run: (draft: Draft, args: unknown) => r.run(draft.current, args) }),
  ),
  projectSummaryTool,
];

const RunInput = ArchitectRunRequest;
const runTool: ToolSpec = {
  name: "runArchitect",
  description: `Build (or rebuild) the game from the plan after this turn ends: all stages, a range (from/to), or only some rooms. Stages: ${ARCHITECT_STAGES.map((s) => `${s} (${STAGE_DESCRIPTIONS[s]})`).join(" ")} Only when the creator asked to build, or asked for a change that needs a rebuild.`,
  schema: RunInput,
  run: (draft, args) => {
    const parsed = RunInput.safeParse(args);
    if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
    draft.runs.splice(0, draft.runs.length, parsed.data);
    return { ok: true, note: "Queued: the run starts when you finish your turn." };
  },
};

export const ARCHITECT_TOOLS = toolset([...readTools, ...writeTools, runTool]);
