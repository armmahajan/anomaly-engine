import { createSdkMcpServer, query, tool, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ChatMessage } from "./messages.ts";
import { buildAgent } from "./profile.ts";
import { Draft, executeTool, isOk, toolSchemas } from "./tools.ts";
import { emitter, finishTurn, stopTurn, type AgentTurnResult, type TurnRequest, type TurnState } from "./turn.ts";

/**
 * Agent turn over the local Claude Code login (Claude Agent SDK). The SDK runs
 * the tool loop; it can only call our game tools, which stage into a Draft.
 * For personal local use only: anything other people use needs an API key.
 */

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
const SERVER = "game";

export interface ClaudeCodeSdk {
  query: typeof query;
  tool: typeof tool;
  createSdkMcpServer: typeof createSdkMcpServer;
}

export interface ClaudeCodeTurnOptions extends TurnRequest {
  model?: string;
  maxTurns?: number;
  sdk?: ClaudeCodeSdk;
}

export const claudeToolName = (name: string) => `mcp__${SERVER}__${name}`;

export async function runClaudeCodeTurn(options: ClaudeCodeTurnOptions): Promise<AgentTurnResult> {
  const sdk = options.sdk ?? { query, tool, createSdkMcpServer };
  const emit = emitter(options);
  const turn: TurnState = {
    request: options,
    draft: new Draft(options.project, options.artAvailable),
    messages: [{ role: "user", content: options.userMessage }],
    usage: { promptTokens: 0, completionTokens: 0 },
    reply: "",
  };

  const agent = options.agent ?? buildAgent;
  const schemas = toolSchemas(agent.tools);
  let callCount = 0;
  const tools = schemas.map((t) =>
    sdk.tool(
      t.name,
      t.description,
      t.schema instanceof z.ZodObject ? t.schema.shape : {},
      async (args) => {
        const id = `call_${++callCount}`;
        const text = JSON.stringify(args);
        emit({ type: "tool_call", id, name: t.name, arguments: text });
        const result = executeTool(turn.draft, t.name, text, agent.tools);
        emit({ type: "tool_result", id, name: t.name, ok: isOk(result), result });
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !isOk(result) };
      },
      { alwaysLoad: true },
    ),
  );

  const abortController = new AbortController();
  options.signal?.addEventListener("abort", () => abortController.abort(), { once: true });
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  let result: SDKResultMessage | undefined;
  try {
    const messages = sdk.query({
      prompt: renderPrompt(options.history, options.userMessage),
      options: {
        systemPrompt: agent.systemPrompt(options.project),
        model: options.model ?? DEFAULT_CLAUDE_MODEL,
        mcpServers: { [SERVER]: sdk.createSdkMcpServer({ name: SERVER, version: "1.0.0", tools }) },
        tools: [],
        allowedTools: schemas.map((t) => claudeToolName(t.name)),
        permissionMode: "dontAsk",
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: options.maxTurns ?? 12,
        abortController,
        env,
      },
    });
    for await (const message of messages) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            turn.reply = block.text;
            emit({ type: "assistant_text", text: block.text });
          }
        }
      } else if (message.type === "result") {
        result = message;
      }
    }
  } catch (error) {
    if (!options.signal?.aborted) {
      return stopTurn(turn, "model_error", `Claude Code failed (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  if (result) {
    const u = result.usage;
    turn.usage = {
      promptTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      completionTokens: u.output_tokens,
      cost: result.total_cost_usd,
    };
  }
  if (options.signal?.aborted) return stopTurn(turn, "cancelled", "cancelled by the creator.");
  if (!result) return stopTurn(turn, "model_error", "Claude Code ended without a result.");
  if (result.subtype === "error_max_turns") return stopTurn(turn, "step_limit", "reached the turn limit.");
  if (result.subtype !== "success") return stopTurn(turn, "model_error", `Claude Code stopped (${result.subtype}).`);

  if (result.result.trim()) turn.reply = result.result;
  turn.messages.push({ role: "assistant", content: turn.reply });
  return finishTurn(turn);
}

function renderPrompt(history: ChatMessage[], userMessage: string): string {
  const earlier = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => `${m.role === "user" ? "Creator" : "You"}: ${m.content}`);
  if (earlier.length === 0) return userMessage;
  return `Conversation so far:\n${earlier.join("\n\n")}\n\nCreator's new message:\n${userMessage}`;
}
