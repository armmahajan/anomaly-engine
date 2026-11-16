import type { ChangeResult, OperationCall, ProjectSpec } from "@anomaly/core";
import type { ChatMessage, ModelClient, Usage } from "./messages.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { Draft, executeTool, toolDefinitions } from "./tools.ts";

/**
 * One agent turn: the creator's message -> model -> tool calls (against a
 * draft) -> ... -> final reply. If the model finishes normally and staged
 * changes, they are saved with ONE commit (a batch: one revision, one undo
 * step). On any abnormal stop (step limit, cancel, model error) nothing is
 * saved. The model never blocks the game: this runs only in edit mode.
 */

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: unknown }
  | { type: "committed"; revision: number; operations: number }
  | { type: "error"; message: string };

export type AgentOutcome =
  | "committed" // finished and saved changes
  | "no_changes" // finished without changing anything (e.g. answered a question)
  | "commit_failed" // finished, but saving was rejected (e.g. stale revision, playtest running)
  | "step_limit"
  | "cancelled"
  | "model_error";

export interface AgentTurnOptions {
  model: ModelClient;
  /** Project at the start of the turn. */
  project: ProjectSpec;
  /** Earlier messages of this conversation (no system message). */
  history: ChatMessage[];
  userMessage: string;
  /** Save the turn's operations atomically, e.g. ProjectStore.applyBatch with author "ai". */
  commit: (operations: OperationCall[], baseRevision: number) => Promise<ChangeResult>;
  /** Max model calls in one turn. */
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentTurnResult {
  outcome: AgentOutcome;
  /** Messages to append to the conversation (starts with the user's message). */
  messages: ChatMessage[];
  /** The model's last text reply, if any. */
  reply: string;
  /** Project after the turn (unchanged unless committed). */
  project: ProjectSpec;
  operations: OperationCall[];
  usage: Usage;
}

export const DEFAULT_MAX_STEPS = 12;

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { model, project, history, userMessage, commit, signal } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const emit = options.onEvent ?? (() => {});
  const draft = new Draft(project);
  const system: ChatMessage = { role: "system", content: buildSystemPrompt(project) };
  const tools = toolDefinitions();
  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let reply = "";

  const stop = (outcome: AgentOutcome, message: string): AgentTurnResult => {
    emit({ type: "error", message });
    // Leave a trace in the conversation so the next turn knows nothing was saved.
    messages.push({ role: "assistant", content: `(Turn stopped: ${message} No changes were saved.)` });
    return { outcome, messages, reply, project, operations: [], usage };
  };

  for (let step = 0; ; step++) {
    if (signal?.aborted) return stop("cancelled", "cancelled by the creator.");
    if (step >= maxSteps) return stop("step_limit", `reached the limit of ${maxSteps} model calls.`);

    let response;
    try {
      response = await model.complete({ messages: [system, ...history, ...messages], tools, signal });
    } catch (error) {
      if (signal?.aborted) return stop("cancelled", "cancelled by the creator.");
      return stop("model_error", `the model request failed (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (response.usage) {
      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
      if (response.usage.cost !== undefined) usage.cost = (usage.cost ?? 0) + response.usage.cost;
    }

    const message = response.message;
    messages.push(message);
    if (message.content) {
      reply = message.content;
      emit({ type: "assistant_text", text: message.content });
    }

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) break; // the model is done

    for (const call of calls) {
      emit({ type: "tool_call", id: call.id, name: call.function.name, arguments: call.function.arguments });
      const result = executeTool(draft, call.function.name, call.function.arguments);
      const ok = (result as { ok?: boolean }).ok === true;
      emit({ type: "tool_result", id: call.id, name: call.function.name, ok, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  if (!draft.changed) return { outcome: "no_changes", messages, reply, project, operations: [], usage };

  const saved = await commit(draft.calls, project.revision);
  if (!saved.ok) {
    emit({ type: "error", message: `saving failed: ${saved.error.message}` });
    messages.push({ role: "assistant", content: `(Saving failed: ${saved.error.message}. No changes were saved.)` });
    return { outcome: "commit_failed", messages, reply, project, operations: [], usage };
  }
  emit({ type: "committed", revision: saved.project.revision, operations: draft.calls.length });
  return { outcome: "committed", messages, reply, project: saved.project, operations: draft.calls, usage };
}
