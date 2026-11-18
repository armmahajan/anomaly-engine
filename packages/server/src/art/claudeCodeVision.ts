import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type EffortLevel, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { VisionContent, VisionModel, VisionReply, VisionRequest } from "@anomaly/art";

/**
 * The art pipeline's vision model over the local Claude Code login (Claude
 * Agent SDK), so picks, rigs, critiques and clips cost nothing beyond the
 * subscription. Each call is one Claude Code turn with nothing but our system
 * prompt and one user message: no tools, no MCP, no settings, no session file,
 * in an empty temp dir. Images go in as base64 image content blocks of that
 * message (the SDK's streaming input takes Messages API user messages).
 * Earlier turns (`history`, e.g. a JSON repair round) are folded into the same
 * message, since a turn can't be seeded with assistant replies.
 * For personal local use only, like the chat backend.
 */

export const DEFAULT_CLAUDE_VISION_MODEL = "claude-opus-5-5";

export interface ClaudeCodeVisionOptions {
  /** Claude model id, default claude-opus-5-5. */
  model?: string;
  /** Effort (low..max); omitted = the model's default. */
  effort?: EffortLevel;
  /** Injected in tests. */
  query?: typeof query;
  /** Wait before the one retry of a transient failure (ms); default 2000. */
  retryDelayMs?: number;
}

const JSON_ONLY =
  "\n\nReply with exactly one JSON object and nothing else: no prose before or after it, no code fences.";

/** Assistant-message errors worth one more try. */
const TRANSIENT = new Set(["rate_limit", "overloaded", "server_error", "unknown"]);

class TransientError extends Error {}

export class ClaudeCodeVisionModel implements VisionModel {
  readonly id: string;
  readonly model: string;
  private readonly options: ClaudeCodeVisionOptions;
  private cwd: string | undefined;

  constructor(options: ClaudeCodeVisionOptions = {}) {
    this.options = options;
    this.model = options.model ?? DEFAULT_CLAUDE_VISION_MODEL;
    // Shown in the studio's art state and job logs: which model, and that it runs on Claude Code.
    this.id = `claude-code/${this.model}`;
  }

  async complete(request: VisionRequest): Promise<VisionReply> {
    try {
      return await this.once(request);
    } catch (error) {
      if (request.signal?.aborted || !(error instanceof TransientError)) throw unwrap(error, request.signal);
      await sleep(this.options.retryDelayMs ?? 2000, request.signal);
      try {
        return await this.once(request);
      } catch (again) {
        throw unwrap(again, request.signal);
      }
    }
  }

  private async once(request: VisionRequest): Promise<VisionReply> {
    const signal = request.signal;
    if (signal?.aborted) throw abortError(signal);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // the login, not an API key
    // Skips the CLI's update check and telemetry: about a second less per call.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= "1";
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: userBlocks(request) },
      parent_tool_use_id: null,
    };
    async function* prompt(): AsyncIterable<SDKUserMessage> {
      yield message;
    }

    let result: SDKResultMessage | undefined;
    let text = "";
    let apiError: string | undefined;
    try {
      const messages = (this.options.query ?? query)({
        prompt: prompt(),
        options: {
          systemPrompt: request.json ? request.system + JSON_ONLY : request.system,
          model: this.model,
          ...(this.options.effort ? { effort: this.options.effort } : {}),
          tools: [],
          allowedTools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          plugins: [],
          permissionMode: "dontAsk",
          persistSession: false,
          maxTurns: 1,
          cwd: this.workDir(),
          abortController,
          env,
        },
      });
      for await (const m of messages) {
        if (m.type === "assistant") {
          if (m.error) apiError = m.error;
          const blocks = m.message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
          if (blocks.join("").trim()) text = blocks.join("");
        } else if (m.type === "result") {
          result = m;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      throw new TransientError(`Claude Code failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) throw abortError(signal);

    const where = `vision model ${this.id}`;
    if (apiError) {
      const detail = `${where} failed (${apiError})${result?.subtype === "success" && result.result ? `: ${result.result.slice(0, 200)}` : ""}`;
      throw TRANSIENT.has(apiError) ? new TransientError(detail) : new Error(detail);
    }
    if (!result) throw new TransientError(`${where}: Claude Code ended without a result`);
    if (result.subtype !== "success") {
      const detail = `${where} stopped (${result.subtype}${result.errors?.length ? `: ${result.errors.join("; ").slice(0, 200)}` : ""})`;
      throw result.subtype === "error_during_execution" ? new TransientError(detail) : new Error(detail);
    }
    if (result.is_error) throw new TransientError(`${where} failed: ${result.result.slice(0, 200)}`);
    if (result.result.trim()) text = result.result;
    if (!text.trim()) throw new TransientError(`${where} returned an empty reply`);

    const u = result.usage;
    return {
      text: request.json ? (firstJsonObject(text) ?? text) : text,
      usage: {
        cost: 0, // the subscription pays
        promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        completionTokens: u.output_tokens ?? 0,
      },
      model: this.model,
    };
  }

  /** An empty dir, so nothing project-local (CLAUDE.md, .mcp.json) can load. */
  private workDir(): string {
    this.cwd ??= mkdtempSync(join(tmpdir(), "anomaly-vision-"));
    return this.cwd;
  }
}

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string } };

function sniff(image: Buffer): "image/png" | "image/jpeg" | "image/webp" {
  if (image[0] === 0xff && image[1] === 0xd8) return "image/jpeg";
  if (image.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "image/png";
}

function toBlocks(content: VisionContent[] | string): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((c) =>
    c.type === "text"
      ? { type: "text", text: c.text }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: (c.mediaType as "image/png" | "image/jpeg" | "image/webp" | undefined) ?? sniff(c.image),
            data: c.image.toString("base64"),
          },
        },
  );
}

/** The request as one user message; earlier turns are quoted ahead of the new one. */
export function userBlocks(request: Pick<VisionRequest, "content" | "history">): Block[] {
  const history = request.history ?? [];
  if (history.length === 0) return toBlocks(request.content);
  const blocks: Block[] = [{ type: "text", text: "<earlier_conversation>" }];
  for (const turn of history) {
    blocks.push({ type: "text", text: turn.role === "user" ? "<user>" : "<you>" });
    blocks.push(...toBlocks(turn.content));
    blocks.push({ type: "text", text: turn.role === "user" ? "</user>" : "</you>" });
  }
  blocks.push({ type: "text", text: "</earlier_conversation>\nThe user's new message:" });
  blocks.push(...toBlocks(request.content));
  return blocks;
}

/**
 * The first balanced, parseable JSON object in a reply (skipping prose and
 * fences around it), or null. Strings are respected, so braces inside them
 * don't count.
 */
export function firstJsonObject(text: string): string | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("vision call aborted");
  error.name = "AbortError";
  return error;
}

function unwrap(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return abortError(signal);
  if (error instanceof TransientError) return new Error(error.message);
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}
