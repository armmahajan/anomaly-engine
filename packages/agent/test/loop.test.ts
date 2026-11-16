import { describe, expect, it } from "vitest";
import { createDefaultProject, type ChangeResult, type OperationCall } from "@anomaly/core";
import {
  callTools,
  FakeModel,
  lastToolResult,
  runAgentTurn,
  say,
  toolCall,
  type AgentEvent,
  type AgentTurnOptions,
} from "../src/index.ts";

const lurker = {
  id: "lurker",
  kind: "enemy",
  name: "Lurker",
  color: "#3f7f7f",
  size: { width: 30, height: 30 },
  stats: { knockback: 300 },
  behavior: {
    initial: "idle",
    states: {
      idle: { action: { type: "wait" }, transitions: [{ when: { type: "playerWithin", distance: 220 }, to: "chase" }] },
      chase: { action: { type: "chase", speed: 140 }, transitions: [{ when: { type: "playerBeyond", distance: 360 }, to: "idle" }] },
    },
  },
};

/** A commit function that records what it was asked to save. */
function recordingCommit(result?: ChangeResult) {
  const calls: { operations: OperationCall[]; baseRevision: number }[] = [];
  const commit = async (operations: OperationCall[], baseRevision: number): Promise<ChangeResult> => {
    calls.push({ operations, baseRevision });
    return result ?? { ok: true, project: { ...createDefaultProject(), revision: baseRevision + 1 }, canUndo: true };
  };
  return { calls, commit };
}

function turn(model: FakeModel, extra: Partial<AgentTurnOptions> = {}) {
  const events: AgentEvent[] = [];
  const { calls, commit } = recordingCommit();
  const promise = runAgentTurn({
    model,
    project: createDefaultProject(),
    history: [],
    userMessage: "Add a lurking enemy",
    commit,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { promise, events, commits: calls };
}

describe("runAgentTurn", () => {
  it("runs tools, then saves all staged changes as one commit", async () => {
    const model = new FakeModel([
      callTools(
        toolCall("createCharacter", { character: lurker }),
        toolCall("addSpawn", { characterId: "lurker", x: 1000, y: 660 }),
      ),
      say("Added a Lurker that waits, then chases you within 220px."),
    ]);
    const { promise, events, commits } = turn(model);
    const result = await promise;

    expect(result.outcome).toBe("committed");
    expect(result.reply).toContain("Lurker");
    expect(commits).toEqual([
      {
        baseRevision: 0,
        operations: [
          { name: "createCharacter", input: { character: lurker } },
          { name: "addSpawn", input: { characterId: "lurker", x: 1000, y: 660 } },
        ],
      },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "assistant_text",
      "committed",
    ]);
    expect(result.usage).toEqual({ promptTokens: 200, completionTokens: 40, cost: 0.002 });
    // Conversation to persist: user, assistant(tool calls), 2 tool results, final assistant.
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
  });

  it("sends the system prompt, tools, history and tool results to the model", async () => {
    const model = new FakeModel([callTools(toolCall("getProjectSummary", {})), say("You have three characters.")]);
    const history = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "Hello!" },
    ];
    await turn(model, { history }).promise;

    const [first, second] = model.requests;
    expect(first!.messages[0]).toMatchObject({ role: "system" });
    expect(first!.messages.slice(1).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(first!.tools.length).toBeGreaterThan(10);
    expect(second!.messages.at(-1)).toMatchObject({ role: "tool" });
  });

  it("lets the model recover from a tool error; only successful calls are saved", async () => {
    const model = new FakeModel([
      callTools(toolCall("updateBehavior", { characterId: "charger", stateId: "wind_up", transitions: [{ index: 0, when: { seconds: 1 } }] })),
      (request) => {
        const result = lastToolResult(request) as { ok: boolean; error: { message: string } };
        expect(result.ok).toBe(false);
        expect(result.error.message).toContain("known: patrol, windup, charge, recover");
        return callTools(toolCall("updateBehavior", { characterId: "charger", stateId: "windup", transitions: [{ index: 0, when: { seconds: 1 } }] }));
      },
      say("The Charger now winds up for 1s."),
    ]);
    const { promise, commits } = turn(model);
    expect((await promise).outcome).toBe("committed");
    expect(commits[0]!.operations).toHaveLength(1);
    expect(commits[0]!.operations[0]!.input).toMatchObject({ stateId: "windup" });
  });

  it("does not commit when nothing changed", async () => {
    const model = new FakeModel([callTools(toolCall("listPrimitives", {})), say("You can use patrol, wait, chase…")]);
    const { promise, commits } = turn(model);
    expect((await promise).outcome).toBe("no_changes");
    expect(commits).toEqual([]);
  });

  it("stops at the step limit without saving", async () => {
    const loop = () => callTools(toolCall("moveSpawn", { spawnId: "charger_1", x: 700 }));
    const model = new FakeModel([loop, loop, loop, loop]);
    const { promise, commits, events } = turn(model, { maxSteps: 3 });
    const result = await promise;
    expect(result.outcome).toBe("step_limit");
    expect(commits).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: expect.stringContaining("No changes were saved") });
  });

  it("stops without saving when the model fails or the turn is cancelled", async () => {
    const failing = new FakeModel([callTools(toolCall("moveSpawn", { spawnId: "charger_1", x: 700 })), new Error("503 upstream")]);
    const failed = await turn(failing).promise;
    expect(failed.outcome).toBe("model_error");
    expect(failed.operations).toEqual([]);

    const controller = new AbortController();
    const cancelling = new FakeModel([
      () => {
        controller.abort();
        return callTools(toolCall("moveSpawn", { spawnId: "charger_1", x: 700 }));
      },
      say("never reached"),
    ]);
    const { promise, commits } = turn(cancelling, { signal: controller.signal });
    expect((await promise).outcome).toBe("cancelled");
    expect(commits).toEqual([]);
  });

  it("reports a rejected commit (e.g. a playtest started meanwhile)", async () => {
    const model = new FakeModel([callTools(toolCall("moveSpawn", { spawnId: "charger_1", x: 700 })), say("Moved it.")]);
    const { commit } = recordingCommit({ ok: false, error: { code: "locked", message: "a playtest is running", issues: [] } });
    const result = await runAgentTurn({ model, project: createDefaultProject(), history: [], userMessage: "move it", commit });
    expect(result.outcome).toBe("commit_failed");
    expect(result.project).toEqual(createDefaultProject());
  });

  it("survives malformed tool arguments and unknown tools", async () => {
    const model = new FakeModel([
      callTools(toolCall("addSpawn", "{oops"), toolCall("summonDragon", {})),
      say("Sorry, let me know what to add."),
    ]);
    const result = await turn(model).promise;
    expect(result.outcome).toBe("no_changes");
    const toolMessages = result.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content as string));
    expect(toolMessages.map((m) => m.error.code)).toEqual(["invalid_arguments", "unknown_tool"]);
  });
});
