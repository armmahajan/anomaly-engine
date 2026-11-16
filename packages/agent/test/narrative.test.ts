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

describe("director progression tools", () => {
  const region = (id: string, extra = {}) => ({ region: { id, name: id, ...extra } });

  it("drafts a structure and reads back its spheres, critical path and issues", () => {
    const draft = new Draft(projectWith());
    expect(run(draft, "createRegion", region("gate", { wikiPageId: "sunken_gate" }))).toMatchObject({
      ok: true,
      warnings: ['gate links to the wiki page "sunken_gate", which doesn\'t exist. Fine if you create that page later this turn.'],
    });
    run(draft, "createRegion", region("city", { enemies: ["crawler"], boss: "charger" }));
    run(draft, "createRegion", region("deep"));
    expect(run(draft, "createAbility", { ability: { id: "dash", name: "Dash", mechanic: "dash", obtainedIn: { regionId: "city", source: "boss" } } })).toMatchObject({ ok: true });
    run(draft, "createConnection", { connection: { id: "gate_city", from: "gate", to: "city" } });
    run(draft, "createConnection", { connection: { id: "city_deep", from: "city", to: "deep", requires: ["dash"], oneWay: true } });
    expect(run(draft, "createConnection", { connection: { id: "bad", from: "city", to: "moon" } })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('unknown region "moon"') },
    });
    run(draft, "setProgressionEnds", { start: "gate", ending: "deep" });

    expect([...draft.current.progression.regions, ...draft.current.progression.abilities].every((i) => i.status === "draft")).toBe(true);
    const summary = run(draft, "getProgression", {}).progression as string;
    expect(summary).toContain("- [city_deep] city -> (one-way) deep · needs dash (draft)");
    expect(summary).toContain("Spheres: 0: gate, city (+dash) | 1: deep");
    expect(summary).toContain("Finishable: yes. Critical path: dash.");
    expect(summary).toContain('WARNING missing_wiki_page: gate links to the wiki page "sunken_gate"');
    expect(buildNarrativePrompt(draft.current)).toContain("- [dash] \"Dash\" (draft) · dash · in city (boss, open) · collected in sphere 0");
  });

  it("protects canon items and ends unless the creator asked", () => {
    let project = projectWith();
    for (const [name, input] of [
      ["createRegion", { region: { id: "gate", name: "Gate", status: "canon" } }],
      ["createRegion", { region: { id: "city", name: "City", status: "draft" } }],
      ["setProgressionEnds", { start: "gate" }],
    ] as const) {
      const result = applyOperation(project, name, input);
      if (!result.ok) throw new Error(result.error.message);
      project = result.project;
    }
    const draft = new Draft(project);
    const protectedError = { ok: false, error: { code: "canon_protected" } };
    expect(run(draft, "updateRegion", { regionId: "gate", changes: { rooms: 3 } })).toMatchObject(protectedError);
    expect(run(draft, "deleteProgressionItem", { id: "gate" })).toMatchObject(protectedError);
    expect(run(draft, "setProgressionEnds", { start: "city" })).toMatchObject(protectedError);
    expect(run(draft, "setProgressionEnds", { start: "gate", ending: "city" })).toMatchObject({ ok: true });
    expect(run(draft, "updateRegion", { regionId: "city", changes: { rooms: 3 } })).toMatchObject({ ok: true });
    expect(run(draft, "updateRegion", { regionId: "gate", changes: { rooms: 3 }, confirmedByCreator: true })).toMatchObject({ ok: true });
    expect(draft.current.progression.regions.map((r) => [r.id, r.rooms, r.status])).toEqual([
      ["gate", 3, "canon"],
      ["city", 3, "draft"],
    ]);
    expect(run(draft, "acceptProgressionItem", { id: "city" })).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
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
    expect(seen.systemPrompt).toContain("You are the director");
    expect(seen.allowedTools).toEqual(NARRATIVE_TOOLS.specs.map((t) => claudeToolName(t.name)));
    expect(commits).toEqual([[{ name: "createWikiPage", input: { page: expect.objectContaining({ id: "overview", status: "draft" }) } }]]);
  });
});
