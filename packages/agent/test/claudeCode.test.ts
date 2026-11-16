import { describe, expect, it, vi } from "vitest";
import { createDefaultProject, type ChangeResult, type OperationCall } from "@anomaly/core";
import { runClaudeCodeTurn, type ClaudeCodeSdk } from "../src/index.ts";

type Handlers = Record<string, (args: unknown) => Promise<unknown>>;
type Script = (tools: Handlers) => AsyncGenerator<unknown>;

function fakeSdk(script: Script) {
  const seen: { prompt?: string; options?: Record<string, unknown> } = {};
  const sdk = {
    tool: (name: string, _description: string, _shape: unknown, handler: unknown) => ({ name, handler }),
    createSdkMcpServer: ({ tools }: { tools: { name: string; handler: unknown }[] }) => ({ tools }),
    query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
      seen.prompt = prompt;
      seen.options = options;
      const server = (options.mcpServers as Record<string, { tools: { name: string; handler: Handlers[string] }[] }>).game!;
      return script(Object.fromEntries(server.tools.map((t) => [t.name, t.handler])));
    },
  } as unknown as ClaudeCodeSdk;
  return { sdk, seen };
}

const result = (subtype = "success") => ({
  type: "result",
  subtype,
  result: "Moved the Charger.",
  total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
});

function run(script: Script, signal?: AbortSignal) {
  const commits: OperationCall[][] = [];
  const commit = async (operations: OperationCall[], baseRevision: number): Promise<ChangeResult> => {
    commits.push(operations);
    return { ok: true, project: { ...createDefaultProject(), revision: baseRevision + 1 }, canUndo: true };
  };
  const { sdk, seen } = fakeSdk(script);
  const promise = runClaudeCodeTurn({
    sdk,
    project: createDefaultProject(),
    history: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!" },
    ],
    userMessage: "move the charger",
    commit,
    signal,
  });
  return { promise, commits, seen };
}

describe("runClaudeCodeTurn", () => {
  it("runs only game tools on the local login and saves staged calls as one commit", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "should-not-be-used");
    const { promise, commits, seen } = run(async function* (tools) {
      expect(await tools.moveSpawn!({ spawnId: "charger_1", x: 700 })).toMatchObject({ isError: false });
      expect(await tools.moveSpawn!({ spawnId: "nope", x: 1 })).toMatchObject({ isError: true });
      yield result();
    });
    const turn = await promise;
    vi.unstubAllEnvs();

    expect(turn).toMatchObject({ outcome: "committed", reply: "Moved the Charger." });
    expect(turn.usage).toEqual({ promptTokens: 150, completionTokens: 20, cost: 0.01 });
    expect(commits).toEqual([[{ name: "moveSpawn", input: { spawnId: "charger_1", x: 700 } }]]);
    expect(seen.prompt).toContain("Creator: hi\n\nYou: Hello!");
    expect(seen.options).toMatchObject({ tools: [], permissionMode: "dontAsk", settingSources: [], strictMcpConfig: true });
    expect((seen.options!.allowedTools as string[]).every((t) => t.startsWith("mcp__game__"))).toBe(true);
    expect((seen.options!.env as Record<string, string>).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("saves nothing when the turn limit is hit or the turn is cancelled", async () => {
    const limited = run(async function* (tools) {
      await tools.moveSpawn!({ spawnId: "charger_1", x: 700 });
      yield result("error_max_turns");
    });
    expect((await limited.promise).outcome).toBe("step_limit");
    expect(limited.commits).toEqual([]);

    const controller = new AbortController();
    const cancelled = run(async function* (tools) {
      await tools.moveSpawn!({ spawnId: "charger_1", x: 700 });
      controller.abort();
      throw new Error("aborted");
    }, controller.signal);
    expect((await cancelled.promise).outcome).toBe("cancelled");
    expect(cancelled.commits).toEqual([]);
  });
});
