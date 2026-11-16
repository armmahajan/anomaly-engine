import type { AssistantMessage, ModelClient, ModelRequest, ModelResponse, ToolCall } from "./messages.ts";

/**
 * Deterministic stand-in for a real model: replays a script of replies.
 * A step can be a fixed message or a function of the request (to react to
 * tool results). Records every request for assertions. No network, no cost.
 */

export type FakeStep = AssistantMessage | ((request: ModelRequest) => AssistantMessage) | Error;

let nextId = 1;

export function toolCall(name: string, args: unknown, id = `call_${nextId++}`): ToolCall {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

/** An assistant message that calls tools (optionally with some text). */
export function callTools(...calls: ToolCall[]): AssistantMessage {
  return { role: "assistant", content: null, tool_calls: calls };
}

/** A final assistant message with no tool calls. */
export function say(text: string): AssistantMessage {
  return { role: "assistant", content: text };
}

export class FakeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[]) {
    this.steps = [...steps];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { signal, ...rest } = request;
    this.requests.push(structuredClone(rest));
    if (signal?.aborted) throw new Error("aborted");
    const step = this.steps.shift();
    if (step === undefined) throw new Error("FakeModel script exhausted");
    if (step instanceof Error) throw step;
    const message = typeof step === "function" ? step(request) : step;
    return { message, usage: { promptTokens: 100, completionTokens: 20, cost: 0.001 } };
  }

  get remainingSteps(): number {
    return this.steps.length;
  }
}

/** Parse the JSON content of the last tool result in a request (for reactive fake steps). */
export function lastToolResult(request: ModelRequest): { ok: boolean; [key: string]: unknown } {
  const last = [...request.messages].reverse().find((m) => m.role === "tool");
  if (!last || last.role !== "tool") throw new Error("no tool result in request");
  return JSON.parse(last.content);
}
