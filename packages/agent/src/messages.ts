/**
 * Chat and tool types in the OpenAI-compatible format that OpenRouter (and
 * most providers) accept, so a real model client needs no translation layer.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type AssistantMessage = { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** In USD, when the provider reports it. */
  cost?: number;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  message: AssistantMessage;
  usage?: Usage;
}

/** Anything that can answer a chat request with tools: OpenRouter later, a fake in tests. */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
