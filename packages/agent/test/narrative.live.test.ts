import { describe, expect, it } from "vitest";
import { applyBatch, applyOperation, createDefaultProject, wikiGaps, type ProjectSpec } from "@anomaly/core";
import { narrativeAgent, runClaudeCodeTurn } from "../src/index.ts";

// Real narrative director turns on the local Claude Code login. Opt in:
//   ANOMALY_LIVE_CLAUDE=1 npx vitest run packages/agent/test/narrative.live.test.ts
const live = process.env.ANOMALY_LIVE_CLAUDE === "1";

async function turn(project: ProjectSpec, userMessage: string) {
  return runClaudeCodeTurn({
    agent: narrativeAgent,
    project,
    history: [],
    userMessage,
    commit: async (operations, baseRevision) => {
      const result = applyBatch(project, operations);
      return result.ok ? { ...result, canUndo: true } : result;
    },
  });
}

describe.skipIf(!live)("narrative director (live)", () => {
  it("drafts a linked skeleton around the creator's canon, without touching it", async () => {
    const created = applyOperation(createDefaultProject(), "createWikiPage", {
      page: {
        id: "overview",
        kind: "overview",
        title: "Lamplight",
        status: "canon",
        body: "A flooded kingdom. The player is the last lamplighter, descending to relight the drowned city. Tone: lonely, hopeful.",
      },
    });
    if (!created.ok) throw new Error(created.error.message);

    const result = await turn(created.project, "Fill in the skeleton: the player character, a few key characters and places, and the main story beats.");
    expect(result.outcome).toBe("committed");

    const pages = result.project.wiki.pages;
    expect(pages.find((p) => p.id === "overview")).toEqual(created.project.wiki.pages[0]);
    const drafted = pages.filter((p) => p.id !== "overview");
    expect(drafted.length).toBeGreaterThanOrEqual(4);
    expect(drafted.every((p) => p.status === "draft")).toBe(true);
    expect(new Set(drafted.map((p) => p.kind)).size).toBeGreaterThanOrEqual(2);
    expect(pages.some((p) => p.characterId === "player")).toBe(true);
    expect(wikiGaps(result.project).filter((g) => g.code === "broken_link")).toEqual([]);
  }, 240_000);
});
