import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, type ChangeResult, type OperationCall } from "@anomaly/core";
import { runClaudeCodeTurn } from "../src/index.ts";

// Uses the machine's Claude Code login. Run with: ANOMALY_LIVE_CLAUDE=1 npx vitest run claudeCode.live
describe.skipIf(!process.env.ANOMALY_LIVE_CLAUDE)("runClaudeCodeTurn (live)", () => {
  it("tunes a behavior from a plain-language request", { timeout: 120_000 }, async () => {
    const project = createDefaultProject();
    let saved: OperationCall[] = [];
    const commit = async (operations: OperationCall[]): Promise<ChangeResult> => {
      saved = operations;
      const r = applyBatch(project, operations);
      return r.ok ? { ok: true, project: r.project, canUndo: true } : r;
    };
    const turn = await runClaudeCodeTurn({
      project,
      history: [],
      userMessage: "Make the Charger's wind-up last 1.2 seconds.",
      commit,
    });
    expect(turn.outcome).toBe("committed");
    const windup = turn.project.characters.find((c) => c.id === "charger");
    expect(windup && "behavior" in windup && windup.behavior.states.windup?.transitions[0]?.when).toEqual({
      type: "after",
      seconds: 1.2,
    });
    expect(saved.length).toBeGreaterThan(0);
  });
});
