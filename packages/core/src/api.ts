import { z } from "zod";
import { Author } from "./history.ts";
import type { OperationError } from "./operations.ts";
import { ProjectSpec } from "./schema.ts";

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
 *   GET  /api/chat                 -> ChatState
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

export const ChatEvent = z.object({ type: z.literal("chat"), chat: ChatState });
export type ChatEvent = z.infer<typeof ChatEvent>;

export const ServerEvent = z.discriminatedUnion("type", [ProjectEvent, ChatEvent]);
export type ServerEvent = z.infer<typeof ServerEvent>;
