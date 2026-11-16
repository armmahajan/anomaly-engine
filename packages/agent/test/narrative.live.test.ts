import { describe, expect, it } from "vitest";
import { applyBatch, applyOperation, createDefaultProject, progressionReport, wikiGaps, type ProjectSpec } from "@anomaly/core";
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

  it("designs a finishable progression around the canon places, as drafts", async () => {
    const canon = (id: string, kind: string, title: string, body: string) => ({ name: "createWikiPage", input: { page: { id, kind, title, body, status: "canon" } } });
    const seeded = applyBatch(createDefaultProject(), [
      canon("overview", "overview", "Lamplight", "A flooded kingdom. The player is the last lamplighter, descending to relight the drowned city. Tone: lonely, hopeful."),
      canon("sunken_gate", "place", "The Sunken Gate", "Where the descent begins."),
      canon("drowned_city", "place", "The Drowned City", "Streets under black water; the Charger hunts here."),
      canon("bell_tower", "place", "The Bell Tower", "A half-submerged tower, climbed from inside."),
      canon("the_deep", "place", "The Deep", "The last flame waits at the bottom. The game ends here."),
    ]);
    if (!seeded.ok) throw new Error(seeded.error.message);

    const result = await turn(
      seeded.project,
      "Design the progression: one region per place page, two or three abilities (your choice), the game starts at the gate and ends in the deep. Don't ask, just draft it.",
    );
    expect(result.outcome).toBe("committed");

    const { progression, wiki } = result.project;
    const pageIds = new Set(wiki.pages.map((p) => p.id));
    expect(progression.regions.length).toBeGreaterThanOrEqual(4);
    expect(progression.abilities.length).toBeGreaterThanOrEqual(2);
    expect([...progression.regions, ...progression.abilities, ...progression.connections].every((i) => i.status === "draft")).toBe(true);
    expect(progression.regions.filter((r) => r.wikiPageId && pageIds.has(r.wikiPageId)).length).toBeGreaterThanOrEqual(4);
    const report = progressionReport(result.project);
    expect(report.finishable).toBe(true);
    expect(report.criticalPath.length).toBeGreaterThanOrEqual(1);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    console.log(report.spheres, report.issues.map((i) => i.message), result.reply);
  }, 300_000);
});
