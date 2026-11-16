import type { ChangeResult, OperationCall, ProjectSpec } from "@anomaly/core";
import type { ChatMessage, Usage } from "./messages.ts";
import type { Draft } from "./tools.ts";
import type { AgentProfile } from "./profile.ts";

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: unknown }
  | { type: "committed"; revision: number; operations: number }
  | { type: "error"; message: string };

export type AgentOutcome = "committed" | "no_changes" | "commit_failed" | "step_limit" | "cancelled" | "model_error";

/** One creator message, handled by any backend. Changes are saved with a single `commit` at the end. */
export interface TurnRequest {
  project: ProjectSpec;
  /** Earlier messages of this conversation (no system message). */
  history: ChatMessage[];
  userMessage: string;
  commit: (operations: OperationCall[], baseRevision: number) => Promise<ChangeResult>;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Which agent runs the turn (its instructions and tools). Default: the build assistant. */
  agent?: AgentProfile;
}

export interface AgentTurnResult {
  outcome: AgentOutcome;
  /** Messages to append to the conversation (starts with the user's message). */
  messages: ChatMessage[];
  reply: string;
  /** Project after the turn (unchanged unless committed). */
  project: ProjectSpec;
  operations: OperationCall[];
  usage: Usage;
}

export type TurnRunner = (request: TurnRequest) => Promise<AgentTurnResult>;

export interface TurnState {
  request: TurnRequest;
  draft: Draft;
  messages: ChatMessage[];
  usage: Usage;
  reply: string;
}

export function emitter(request: TurnRequest): (event: AgentEvent) => void {
  return request.onEvent ?? (() => {});
}

/** End the turn without saving anything. */
export function stopTurn(turn: TurnState, outcome: AgentOutcome, message: string): AgentTurnResult {
  emitter(turn.request)({ type: "error", message });
  turn.messages.push({ role: "assistant", content: `(Turn stopped: ${message} No changes were saved.)` });
  return { outcome, messages: turn.messages, reply: turn.reply, project: turn.request.project, operations: [], usage: turn.usage };
}

/** Save the draft's staged calls as one commit, if any. */
export async function finishTurn(turn: TurnState): Promise<AgentTurnResult> {
  const { request, draft, messages, usage, reply } = turn;
  const unchanged = { messages, reply, project: request.project, operations: [], usage };
  if (!draft.changed) return { outcome: "no_changes", ...unchanged };

  const saved = await request.commit(draft.calls, request.project.revision);
  if (!saved.ok) {
    emitter(request)({ type: "error", message: `saving failed: ${saved.error.message}` });
    messages.push({ role: "assistant", content: `(Saving failed: ${saved.error.message}. No changes were saved.)` });
    return { outcome: "commit_failed", ...unchanged };
  }
  emitter(request)({ type: "committed", revision: saved.project.revision, operations: draft.calls.length });
  return { outcome: "committed", messages, reply, project: saved.project, operations: draft.calls, usage };
}
