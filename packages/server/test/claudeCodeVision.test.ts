import { describe, expect, it } from "vitest";
import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeVisionModel, firstJsonObject, userBlocks } from "../src/art/claudeCodeVision.ts";
import { artOptionsFromEnv, visionBackendFromEnv } from "../src/art/config.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

type Step = { text?: string; error?: string; throws?: string; subtype?: string; hang?: boolean };

/** A stand-in for the SDK's query: records each call, plays one scripted step per call. */
function fakeQuery(steps: Step[]) {
  const calls: { message: SDKUserMessage; options: Record<string, unknown> }[] = [];
  const fn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
    const step = steps[calls.length] ?? { text: "ok" };
    async function* run() {
      let message: SDKUserMessage | undefined;
      for await (const m of params.prompt) message = m;
      calls.push({ message: message!, options: params.options });
      if (step.hang) {
        const abort = params.options.abortController as AbortController;
        await new Promise((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("aborted by host"))));
      }
      if (step.throws) throw new Error(step.throws);
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: step.text ?? "" }] },
        ...(step.error ? { error: step.error } : {}),
      };
      yield {
        type: "result",
        subtype: step.subtype ?? "success",
        is_error: !!step.error,
        result: step.text ?? "",
        errors: [],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 },
        total_cost_usd: 0.42,
      };
    }
    return run();
  }) as unknown as typeof query;
  return { fn, calls };
}

const model = (steps: Step[]) => {
  const fake = fakeQuery(steps);
  return { vision: new ClaudeCodeVisionModel({ query: fake.fn, retryDelayMs: 1 }), calls: fake.calls };
};

describe("ClaudeCodeVisionModel", () => {
  it("sends text and images as one user message with our system prompt and no tools", async () => {
    const { vision, calls } = model([{ text: "a red square" }]);
    const reply = await vision.complete({
      system: "Describe.",
      content: [{ type: "image", image: PNG }, { type: "text", text: "what is it?" }, { type: "image", image: JPEG }],
    });
    expect(reply).toEqual({ text: "a red square", usage: { cost: 0, promptTokens: 113, completionTokens: 5 }, model: "claude-opus-5-5" });
    expect(vision.id).toBe("claude-code/claude-opus-5-5");
    const { message, options } = calls[0]!;
    expect(message.message.role).toBe("user");
    expect(message.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
      { type: "text", text: "what is it?" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } },
    ]);
    expect(options).toMatchObject({
      systemPrompt: "Describe.",
      model: "claude-opus-5-5",
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
    });
    expect((options.env as Record<string, string>).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("asks for JSON only and returns the first JSON object of the reply", async () => {
    const { vision, calls } = model([{ text: 'Sure! Here it is:\n```json\n{"a": "x}", "b": [1, {"c": 2}]}\n```\nHope that helps {really}.' }]);
    const reply = await vision.complete({ system: "Rig it.", content: [{ type: "text", text: "go" }], json: true });
    expect(JSON.parse(reply.text)).toEqual({ a: "x}", b: [1, { c: 2 }] });
    expect(calls[0]!.options.systemPrompt).toMatch(/^Rig it\.\n\nReply with exactly one JSON object/);
  });

  it("leaves a reply without a JSON object as-is (the stage's repair round handles it)", async () => {
    const { vision } = model([{ text: 'no json here {"broken": ' }]);
    expect((await vision.complete({ system: "s", content: [{ type: "text", text: "go" }], json: true })).text).toBe('no json here {"broken": ');
  });

  it("folds history into the one user message, images included", async () => {
    const { vision, calls } = model([{ text: "{}" }]);
    await vision.complete({
      system: "s",
      history: [
        { role: "user", content: [{ type: "image", image: PNG }, { type: "text", text: "first ask" }] },
        { role: "assistant", content: "bad reply" },
      ],
      content: [{ type: "text", text: "fix it" }],
    });
    const blocks = calls[0]!.message.message.content as { type: string; text?: string }[];
    expect(blocks.map((b) => (b.type === "text" ? b.text : "[image]"))).toEqual([
      "<earlier_conversation>",
      "<user>",
      "[image]",
      "first ask",
      "</user>",
      "<you>",
      "bad reply",
      "</you>",
      "</earlier_conversation>\nThe user's new message:",
      "fix it",
    ]);
  });

  it("retries once on a transient failure, then gives up", async () => {
    const once = model([{ throws: "process exited" }, { text: "fine" }]);
    expect((await once.vision.complete({ system: "s", content: [{ type: "text", text: "go" }] })).text).toBe("fine");
    expect(once.calls).toHaveLength(2);

    const rate = model([{ error: "rate_limit", text: "API Error: 429" }, { error: "overloaded" }, { text: "never" }]);
    await expect(rate.vision.complete({ system: "s", content: [{ type: "text", text: "go" }] })).rejects.toThrow(/overloaded/);
    expect(rate.calls).toHaveLength(2);
  });

  it("does not retry a permanent failure", async () => {
    const auth = model([{ error: "authentication_failed", text: "Not logged in" }, { text: "never" }]);
    await expect(auth.vision.complete({ system: "s", content: [{ type: "text", text: "go" }] })).rejects.toThrow(/authentication_failed/);
    expect(auth.calls).toHaveLength(1);
  });

  it("stops on abort without retrying", async () => {
    const { vision, calls } = model([{ hang: true }, { text: "never" }]);
    const controller = new AbortController();
    const pending = vision.complete({ system: "s", content: [{ type: "text", text: "go" }], signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(1);

    const already = model([{ text: "never" }]);
    await expect(already.vision.complete({ system: "s", content: [{ type: "text", text: "go" }], signal: AbortSignal.abort() })).rejects.toThrow();
    expect(already.calls).toHaveLength(0);
  });

  it("runs calls concurrently", async () => {
    let active = 0;
    let peak = 0;
    const fn = (async function* () {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      yield { type: "result", subtype: "success", is_error: false, result: "x", usage: { input_tokens: 1, output_tokens: 1 } };
    }) as unknown as typeof query;
    const vision = new ClaudeCodeVisionModel({ query: fn });
    await Promise.all(Array.from({ length: 5 }, () => vision.complete({ system: "s", content: [{ type: "text", text: "go" }] })));
    expect(peak).toBe(5);
  });
});

describe("firstJsonObject / userBlocks", () => {
  it("skips braces that don't start valid JSON", () => {
    expect(firstJsonObject('use {x} then {"ok": true}')).toBe('{"ok": true}');
    expect(firstJsonObject('{"s": "a \\" } b"}')).toBe('{"s": "a \\" } b"}');
    expect(firstJsonObject("nothing")).toBeNull();
  });

  it("passes a string history turn as text", () => {
    expect(userBlocks({ content: [{ type: "text", text: "hi" }] })).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("vision backend config", () => {
  it("defaults to Claude Code, unless the chat is fake or the model is an OpenRouter id", () => {
    expect(visionBackendFromEnv({})).toBe("claude-code");
    expect(visionBackendFromEnv({ STUDIO_CHAT_BACKEND: "fake" })).toBe("claude-code");
    // Claude never goes through OpenRouter by default: a Claude id stays on Claude Code; other providers' ids go to OpenRouter.
    expect(visionBackendFromEnv({ STUDIO_ART_VISION_MODEL: "anthropic/claude-haiku-5.5" })).toBe("claude-code");
    expect(visionBackendFromEnv({ STUDIO_ART_VISION_MODEL: "google/gemini-3.1-flash" })).toBe("openrouter");
    expect(visionBackendFromEnv({ STUDIO_ART_VISION_MODEL: "claude-sonnet-5-5" })).toBe("claude-code");
    expect(visionBackendFromEnv({ STUDIO_ART_VISION_BACKEND: "openrouter" })).toBe("openrouter");
    expect(visionBackendFromEnv({ STUDIO_ART_VISION_BACKEND: "claude-code", STUDIO_CHAT_BACKEND: "fake" })).toBe("claude-code");
    expect(visionBackendFromEnv({ STUDIO_ART_VISION_BACKEND: "claude" })).toBeNull();
  });

  it("builds the vision model for each backend", async () => {
    const key = { OPENROUTER_API_KEY: "test" };
    const cc = artOptionsFromEnv({ ...key, STUDIO_ART_VISION_BACKEND: "claude-code", STUDIO_ART_VISION_EFFORT: "low" }, "/nonexistent");
    expect(cc.models?.vision.id).toBe("claude-code/claude-opus-5-5");
    const sonnet = artOptionsFromEnv({ ...key, STUDIO_ART_VISION_MODEL: "claude-sonnet-5-5" }, "/nonexistent");
    expect(sonnet.models?.vision.id).toBe("claude-code/claude-sonnet-5-5");
    // OpenRouter vision runs a non-Claude model (Claude there is refused unless allowed: see below).
    const or = artOptionsFromEnv({ ...key, STUDIO_ART_VISION_BACKEND: "openrouter", STUDIO_ART_VISION_MODEL: "google/gemini-3.1-flash" }, "/nonexistent");
    expect(or.models?.vision.id).toBe("google/gemini-3.1-flash");
    expect(artOptionsFromEnv({ ...key, STUDIO_ART_VISION_BACKEND: "nope" }, "/nonexistent").unavailableReason).toMatch(/VISION_BACKEND/);
    expect(artOptionsFromEnv({}, "/nonexistent").models).toBeNull();
    await Promise.all([cc, sonnet, or].map((o) => o.renderer.close()));
  });
});

describe("Claude on OpenRouter", () => {
  it("is refused unless explicitly allowed: Claude runs on the Claude Code subscription", async () => {
    const { OpenRouterVisionModel } = await import("@anomaly/art");
    expect(() => new OpenRouterVisionModel({ apiKey: "k" }, "anthropic/claude-opus-5.5")).toThrow(/Claude Code subscription/);
    expect(() => new OpenRouterVisionModel({ apiKey: "k", allowClaude: true }, "anthropic/claude-opus-5.5")).not.toThrow();
    expect(() => new OpenRouterVisionModel({ apiKey: "k" }, "google/gemini-3.1-flash")).not.toThrow();
    const refused = artOptionsFromEnv({ OPENROUTER_API_KEY: "k", STUDIO_ART_VISION_BACKEND: "openrouter" }, "/nonexistent");
    expect(refused.models).toBeNull();
    expect(refused.unavailableReason).toMatch(/Claude Code subscription/);
    await refused.renderer.close();
    const allowed = artOptionsFromEnv({ OPENROUTER_API_KEY: "k", STUDIO_ART_VISION_BACKEND: "openrouter", STUDIO_ALLOW_OPENROUTER_CLAUDE: "1" }, "/nonexistent");
    expect(allowed.models?.vision.id).toBe("anthropic/claude-haiku-5.5");
    await allowed.renderer.close();
  });
});
