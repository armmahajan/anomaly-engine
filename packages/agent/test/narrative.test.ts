import { describe, expect, it } from "vitest";
import { applyOperation, createDefaultProject, type ChangeResult, type OperationCall, type ProjectSpec } from "@anomaly/core";
import {
  buildNarrativePrompt,
  claudeToolName,
  Draft,
  executeTool,
  NARRATIVE_TOOLS,
  narrativeAgent,
  runClaudeCodeTurn,
  type ClaudeCodeSdk,
} from "../src/index.ts";

function projectWith(...pages: object[]): ProjectSpec {
  let project = createDefaultProject();
  for (const page of pages) {
    const result = applyOperation(project, "createWikiPage", { page });
    if (!result.ok) throw new Error(result.error.message);
    project = result.project;
  }
  return project;
}

const canonHero = { id: "hero", kind: "character", title: "The Lamplighter", status: "canon", characterId: "player" };
const run = (draft: Draft, name: string, args: unknown) => executeTool(draft, name, JSON.stringify(args), NARRATIVE_TOOLS) as Record<string, any>;

describe("narrative director tools", () => {
  it("everything it writes is a draft, even if it asks for canon", () => {
    const draft = new Draft(projectWith());
    expect(run(draft, "createWikiPage", { page: { id: "drowned_city", kind: "place", title: "The Drowned City", status: "canon" } })).toMatchObject({
      ok: false,
    });
    expect(run(draft, "createWikiPage", { page: { id: "drowned_city", kind: "place", title: "The Drowned City", body: "Below [[hero]]." } })).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([expect.stringContaining("[[hero]]")]),
    });
    expect(draft.current.wiki.pages[0]).toMatchObject({ id: "drowned_city", status: "draft" });
    expect(draft.calls).toEqual([{ name: "createWikiPage", input: { page: expect.objectContaining({ status: "draft" }) } }]);
  });

  it("canon pages change only with the creator's confirmation; its own drafts change freely", () => {
    const draft = new Draft(projectWith(canonHero, { id: "rival", kind: "character", title: "Rival", status: "draft" }));
    expect(run(draft, "updateWikiPage", { pageId: "hero", changes: { title: "x" } })).toMatchObject({ ok: false, error: { code: "canon_protected" } });
    expect(run(draft, "deleteWikiPage", { pageId: "hero" })).toMatchObject({ ok: false, error: { code: "canon_protected" } });
    expect(run(draft, "updateWikiPage", { pageId: "rival", changes: { summary: "Wants the light." } })).toMatchObject({ ok: true });
    expect(run(draft, "deleteWikiPage", { pageId: "rival" })).toMatchObject({ ok: true });

    expect(run(draft, "updateWikiPage", { pageId: "hero", changes: { summary: "Last of the order." }, confirmedByCreator: true })).toMatchObject({ ok: true });
    expect(draft.current.wiki.pages).toEqual([expect.objectContaining({ id: "hero", status: "canon", summary: "Last of the order." })]);
    expect(draft.calls.at(-1)).toEqual({ name: "updateWikiPage", input: { pageId: "hero", changes: { summary: "Last of the order." } } });
  });

  it("can read pages, the outline and the game's cast, but not touch the game", () => {
    const draft = new Draft(projectWith(canonHero, { id: "ember", kind: "lore", title: "Ember", status: "draft", body: "Carried by [[hero]]." }));
    expect(run(draft, "getWikiPage", { pageId: "hero" })).toMatchObject({ ok: true, page: { title: "The Lamplighter" }, linkedFrom: ["ember"] });
    expect(run(draft, "getWikiOutline", {}).outline).toContain('[ember] "Ember" (draft)');
    expect(run(draft, "getProjectSummary", {}).summary).toContain("charger");
    expect(run(draft, "updateBehavior", { characterId: "charger" })).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
    expect(run(draft, "acceptWikiPage", { pageId: "ember" })).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
  });

  it("its instructions carry the overview, every page, the gaps and the cast", () => {
    const prompt = buildNarrativePrompt(
      projectWith({ id: "overview", kind: "overview", title: "Drowned Lamp", status: "canon", body: "A lonely, hopeful descent." }, canonHero),
    );
    expect(prompt).toContain("A lonely, hopeful descent.");
    expect(prompt).toContain('[hero] "The Lamplighter" (canon) · in-game: player');
    expect(prompt).toContain("Crawler (enemy) is in the game but has no wiki page.");
    expect(prompt).toContain('- charger "Charger" (enemy)');
  });
});

describe("narrative director on the Claude Code backend", () => {
  it("runs with its own instructions and only its tools", async () => {
    const seen: Record<string, any> = {};
    const sdk = {
      tool: (name: string, _d: string, _s: unknown, handler: unknown) => ({ name, handler }),
      createSdkMcpServer: ({ tools }: { tools: unknown[] }) => ({ tools }),
      query: ({ options }: { options: Record<string, any> }) => {
        Object.assign(seen, options);
        const tools = Object.fromEntries(options.mcpServers.game.tools.map((t: any) => [t.name, t.handler]));
        return (async function* () {
          await tools.createWikiPage({ page: { id: "overview", kind: "overview", title: "Drowned Lamp" } });
          yield { type: "result", subtype: "success", result: "Drafted the overview.", usage: { input_tokens: 1, output_tokens: 1 } };
        })();
      },
    } as unknown as ClaudeCodeSdk;
    const commits: OperationCall[][] = [];
    const turn = await runClaudeCodeTurn({
      sdk,
      agent: narrativeAgent,
      project: createDefaultProject(),
      history: [],
      userMessage: "a drowned kingdom",
      commit: async (operations, baseRevision): Promise<ChangeResult> => {
        commits.push(operations);
        return { ok: true, project: { ...createDefaultProject(), revision: baseRevision + 1 }, canUndo: true };
      },
    });
    expect(turn.outcome).toBe("committed");
    expect(seen.systemPrompt).toContain("You are the narrative director");
    expect(seen.allowedTools).toEqual(NARRATIVE_TOOLS.specs.map((t) => claudeToolName(t.name)));
    expect(commits).toEqual([[{ name: "createWikiPage", input: { page: expect.objectContaining({ id: "overview", status: "draft" }) } }]]);
  });
});
