import { z } from "zod";
import { Author } from "./history.ts";
import type { OperationError } from "./operations.ts";
import { ProjectSpec } from "./schema.ts";
import { FileRef } from "./art/asset.ts";
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

/** The studio's AI agents, each with its own chat: build assistant (arena) and narrative director (wiki). */
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
export const ArtStage = z.enum(["concepts", "choose", "rig", "animate", "auto"]);
export type ArtStage = z.infer<typeof ArtStage>;

export const ArtJobRequest = z.strictObject({
  stage: ArtStage,
  characterId: Id,
  brief: z.string().trim().max(2000).optional(),
  feedback: z.string().trim().max(1000).optional(),
  /** concepts: variations on the chosen design (it is sent as a reference image). */
  refine: z.boolean().optional(),
  sheet: z.number().int().min(0).optional(),
  cell: z.number().int().min(0).max(3).optional(),
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
  characterId: z.string(),
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
      characterId: z.string(),
      startedAt: z.string(),
      cost: z.number(),
      activity: z.array(ArtActivityEntry),
    })
    .nullable(),
  /** Recent jobs, newest last. */
  jobs: z.array(ArtJobSummary),
  /** USD spent on art in this project. */
  totalCost: z.number(),
});
export type ArtState = z.infer<typeof ArtState>;

export const ArtEvent = z.object({ type: z.literal("art"), art: ArtState });
export type ArtEvent = z.infer<typeof ArtEvent>;

export const ServerEvent = z.discriminatedUnion("type", [ProjectEvent, ChatEvent, ArtEvent]);
export type ServerEvent = z.infer<typeof ServerEvent>;
