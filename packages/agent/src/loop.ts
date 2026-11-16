import type { ChatMessage, ModelClient } from "./messages.ts";
import { buildAgent } from "./profile.ts";
import { Draft, executeTool, isOk, toolDefinitions } from "./tools.ts";
import { emitter, finishTurn, stopTurn, type AgentTurnResult, type TurnRequest, type TurnState } from "./turn.ts";

export interface AgentTurnOptions extends TurnRequest {
  model: ModelClient;
  /** Max model calls in one turn. */
  maxSteps?: number;
}

export const DEFAULT_MAX_STEPS = 12;

/** Agent turn over an OpenAI-style chat model: we run the tool loop ourselves. */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { model, project, history, userMessage, signal } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const emit = emitter(options);
  const turn: TurnState = {
    request: options,
    draft: new Draft(project, options.artAvailable),
    messages: [{ role: "user", content: userMessage }],
    usage: { promptTokens: 0, completionTokens: 0 },
    reply: "",
  };
  const agent = options.agent ?? buildAgent;
  const system: ChatMessage = { role: "system", content: agent.systemPrompt(project) };
  const tools = toolDefinitions(agent.tools);

  for (let step = 0; ; step++) {
    if (signal?.aborted) return stopTurn(turn, "cancelled", "cancelled by the creator.");
    if (step >= maxSteps) return stopTurn(turn, "step_limit", `reached the limit of ${maxSteps} model calls.`);

    let response;
    try {
      response = await model.complete({ messages: [system, ...history, ...turn.messages], tools, signal });
    } catch (error) {
      if (signal?.aborted) return stopTurn(turn, "cancelled", "cancelled by the creator.");
      return stopTurn(turn, "model_error", `the model request failed (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (response.usage) {
      turn.usage.promptTokens += response.usage.promptTokens;
      turn.usage.completionTokens += response.usage.completionTokens;
      if (response.usage.cost !== undefined) turn.usage.cost = (turn.usage.cost ?? 0) + response.usage.cost;
    }

    const message = response.message;
    turn.messages.push(message);
    if (message.content) {
      turn.reply = message.content;
      emit({ type: "assistant_text", text: message.content });
    }

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) break;

    for (const call of calls) {
      emit({ type: "tool_call", id: call.id, name: call.function.name, arguments: call.function.arguments });
      const result = executeTool(turn.draft, call.function.name, call.function.arguments, agent.tools);
      emit({ type: "tool_result", id: call.id, name: call.function.name, ok: isOk(result), result });
      turn.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return finishTurn(turn);
}
