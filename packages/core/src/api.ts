import { z } from "zod";
import { Author } from "./history.ts";
import type { OperationError } from "./operations.ts";
import { ProjectSpec } from "./schema.ts";
import { FileRef } from "./art/fileRef.ts";
import { Id } from "./common.ts";

/**
 * HTTP API of the local project server (shared by server and clients).
 *
 *   GET  /api/project              -> ProjectState
 *   GET  /api/history              -> { entries: HistorySummary[] }
 *   POST /api/ops       OperationRequest -> ChangeResult
 *   POST /api/batch     BatchRequest     -> ChangeResult  (all-or-nothing, one revision)
 *   POST /api/undo      UndoRequest      -> ChangeResult
 *   POST /api/playtest  PlaytestRequest  -> PlaytestResult
 *   POST /api/reset     ResetRequest     -> ChangeResult  (backs up, then starts a fresh project)
 *   GET  /api/chat?agent=build|narrative -> ChatState (agent defaults to build)
 *   POST /api/chat      ChatRequest      -> { ok } (the turn runs in the background)
 *   POST /api/chat/cancel          -> { ok }
 *   GET  /api/events?clientId=…    -> server-sent events, `data:` = ServerEvent
 *
 * Every edit names the revision it was based on (`baseRevision`) and is
 * rejected with `stale_revision` if the project has moved on since.
 */

export const OperationRequest = z.strictObject({
  name: z.string(),
  input: z.unknown(),
  baseRevision: z.number().int().min(0),
  author: Author.default("user"),
});
export type OperationRequest = z.input<typeof OperationRequest>;

export const BatchRequest = z.strictObject({
  /** Validated by core applyBatch. */
  operations: z.unknown(),
  baseRevision: z.number().int().min(0),
  author: Author.default("user"),
});
export type BatchRequest = z.input<typeof BatchRequest>;

export const UndoRequest = z.strictObject({
  baseRevision: z.number().int().min(0),
  author: Author.default("user"),
});
export type UndoRequest = z.input<typeof UndoRequest>;

/** The studio holds the playtest lock while playing; edits are rejected meanwhile. */
export const PlaytestRequest = z.strictObject({
  active: z.boolean(),
  clientId: z.string().min(1).max(100),
});

export const ResetRequest = z.strictObject({ baseRevision: z.number().int().min(0) });

export const ChatRequest = z.strictObject({ message: z.string().trim().min(1).max(4000) });

/** The studio's AI agents, each with its own chat: build assistant (the game) and director (wiki and progression). */
export const AgentId = z.enum(["build", "narrative"]);
export type AgentId = z.infer<typeof AgentId>;

export interface ProjectState {
  project: ProjectSpec;
  canUndo: boolean;
}

export type ChangeResult = ({ ok: true } & ProjectState) | { ok: false; error: OperationError };

export type PlaytestResult = { ok: true; revision: number } | { ok: false; error: OperationError };

export interface HistorySummary {
  revision: number;
  at: string;
  author: Author;
  summary: string;
}

export const ProjectEvent = z.object({
  type: z.literal("project"),
  project: ProjectSpec,
  canUndo: z.boolean(),
  /** What caused this event; null for the initial snapshot on connect. */
  cause: z.object({ revision: z.number(), author: Author, summary: z.string() }).nullable(),
});
export type ProjectEvent = z.infer<typeof ProjectEvent>;

export const ChatOutcome = z.enum(["committed", "no_changes", "commit_failed", "step_limit", "cancelled", "model_error"]);

export const ChatEntry = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), at: z.string(), text: z.string() }),
  z.object({
    role: z.literal("assistant"),
    at: z.string(),
    text: z.string(),
    outcome: ChatOutcome,
    /** Revision the turn's changes were saved as (committed turns only). */
    revision: z.number().nullable(),
    changes: z.array(z.string()),
    usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), cost: z.number().optional() }),
    error: z.string().optional(),
  }),
]);
export type ChatEntry = z.infer<typeof ChatEntry>;

export const ChatActivity = z.object({ kind: z.enum(["text", "tool"]), text: z.string(), ok: z.boolean().optional() });
export type ChatActivity = z.infer<typeof ChatActivity>;

export const ChatState = z.object({
  entries: z.array(ChatEntry),
  /** The turn in progress, if any. Edits and playtests are locked meanwhile. */
  running: z.object({ activity: z.array(ChatActivity) }).nullable(),
  /** Revisions that have since been undone. */
  undone: z.array(z.number()).default([]),
});
export type ChatState = z.infer<typeof ChatState>;

export const ChatEvent = z.object({ type: z.literal("chat"), agent: AgentId, chat: ChatState });
export type ChatEvent = z.infer<typeof ChatEvent>;

// --- art jobs ------------------------------------------------------------------
//   GET  /api/art                 -> ArtState
//   POST /api/art/jobs  ArtJobRequest -> { ok } (runs in the background; progress via `art` events)
//   POST /api/art/cancel          -> { ok }
//   GET  /api/files/<ref>         -> the stored image (concept sheets, renders)

/**
 * concepts: new 2x2 concept sheet (creates the character's art asset if needed)
 * choose:   pick a design from a sheet (default: latest sheet, AI's recommendation)
 * rig:      build (or, with feedback, revise) the rig from the chosen design
 * animate:  write the clips the character needs
 * auto:     all of the above in order, taking the AI's recommendations
 */
export const ArtStage = z.enum(["concepts", "choose", "rig", "animate", "auto", "worldKit", "worldCompose", "worldRepaint"]);
export type ArtStage = z.infer<typeof ArtStage>;

/** Stages that work on a biome (the rest work on a character). */
export const WORLD_STAGES: readonly ArtStage[] = ["worldKit", "worldCompose", "worldRepaint"];

/**
 * Character stages need `characterId`. World stages:
 *   worldKit:     paint a biome's kit (new biome from `brief` = theme, or `biomeId` to repaint all of it); `quality`
 *   worldCompose: compose a room for `biomeId` around a world room's tiles (`newLayout` also suggests platforms; `dressRoom` dresses that world room)
 *   worldRepaint: repaint one `part` of `biomeId`'s kit
 */
export const ArtJobRequest = z
  .strictObject({
    stage: ArtStage,
    characterId: Id.optional(),
    biomeId: Id.optional(),
    /** New biome / room name. */
    name: z.string().trim().max(80).optional(),
    quality: z.enum(["draft", "final"]).optional(),
    newLayout: z.boolean().optional(),
    /** A world room to dress with the composed room. */
    dressRoom: Id.optional(),
    part: z.enum(["backdrop", "structures", "props", "ground"]).optional(),
    brief: z.string().trim().max(2000).optional(),
  feedback: z.string().trim().max(1000).optional(),
  /** concepts: variations on the chosen design (it is sent as a reference image). */
  refine: z.boolean().optional(),
  sheet: z.number().int().min(0).optional(),
  cell: z.number().int().min(0).max(3).optional(),
  })
  .superRefine((r, ctx) => {
    const world = WORLD_STAGES.includes(r.stage);
    if (!world && !r.characterId) ctx.addIssue({ code: "custom", path: ["characterId"], message: `${r.stage} needs a characterId` });
    if (world && r.stage !== "worldKit" && !r.biomeId) ctx.addIssue({ code: "custom", path: ["biomeId"], message: `${r.stage} needs a biomeId` });
    if (r.stage === "worldKit" && !r.biomeId && !r.brief) ctx.addIssue({ code: "custom", path: ["brief"], message: "a new biome needs a brief (its theme)" });
    if (r.stage === "worldRepaint" && !r.part) ctx.addIssue({ code: "custom", path: ["part"], message: "worldRepaint needs a part" });
  });
export type ArtJobRequest = z.input<typeof ArtJobRequest>;

export const ArtActivityEntry = z.object({
  at: z.string(),
  text: z.string(),
  cost: z.number().optional(),
  file: FileRef.optional(),
});
export type ArtActivityEntry = z.infer<typeof ArtActivityEntry>;

export const ArtJobOutcome = z.enum(["committed", "failed", "cancelled", "over_budget"]);

export const ArtJobSummary = z.object({
  id: z.string(),
  stage: ArtStage,
  /** The character or biome the job worked on. */
  characterId: z.string().optional(),
  biomeId: z.string().optional(),
  at: z.string(),
  outcome: ArtJobOutcome,
  /** USD. */
  cost: z.number(),
  summary: z.string(),
  error: z.string().optional(),
  /** Revisions saved by this job (one per completed stage). */
  revisions: z.array(z.number()),
  activity: z.array(ArtActivityEntry),
});
export type ArtJobSummary = z.infer<typeof ArtJobSummary>;

export const ArtState = z.object({
  /** False when no model key is configured; jobs are refused. */
  available: z.boolean(),
  models: z.object({ image: z.string(), vision: z.string() }),
  /** USD limit per job. */
  budget: z.number(),
  running: z
    .object({
      id: z.string(),
      stage: ArtStage,
      characterId: z.string().optional(),
      biomeId: z.string().optional(),
      startedAt: z.string(),
      cost: z.number(),
      activity: z.array(ArtActivityEntry),
    })
    .nullable(),
  /** Recent jobs, newest last. */
  jobs: z.array(ArtJobSummary),
  /** Jobs waiting to start (queued by the chat). */
  queued: z.number().default(0),
  /** USD spent on art in this project. */
  totalCost: z.number(),
});
export type ArtState = z.infer<typeof ArtState>;

export const ArtEvent = z.object({ type: z.literal("art"), art: ArtState });
export type ArtEvent = z.infer<typeof ArtEvent>;

export const ServerEvent = z.discriminatedUnion("type", [ProjectEvent, ChatEvent, ArtEvent]);
export type ServerEvent = z.infer<typeof ServerEvent>;
