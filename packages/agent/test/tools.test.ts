import { describe, expect, it } from "vitest";
import { ACTION_TYPES, createDefaultProject, OPERATION_NAMES, PROGRESSION_OPERATION_NAMES, WIKI_OPERATION_NAMES } from "@anomaly/core";
import { buildSystemPrompt, Draft, executeTool, ART_TOOL_NAMES, NARRATIVE_TOOLS, PIPELINE_ONLY_OPERATIONS, READ_TOOL_NAMES, summarizeProject, toolDefinitions } from "../src/index.ts";

const definitions = toolDefinitions();
const byName = Object.fromEntries(definitions.map((d) => [d.function.name, d.function]));
const run = (draft: Draft, name: string, args: unknown) => executeTool(draft, name, JSON.stringify(args)) as Record<string, any>;

describe("tool definitions", () => {
  it("expose every core operation except the director's and pipeline-only art ones, plus the read tools, with valid names", () => {
    const excluded: string[] = [...WIKI_OPERATION_NAMES, ...PROGRESSION_OPERATION_NAMES, ...PIPELINE_ONLY_OPERATIONS];
    const build = OPERATION_NAMES.filter((n) => !excluded.includes(n));
    expect(Object.keys(byName).sort()).toEqual([...build, ...READ_TOOL_NAMES, ...ART_TOOL_NAMES].sort());
    for (const d of [...definitions, ...toolDefinitions(NARRATIVE_TOOLS)]) {
      expect(d.type).toBe("function");
      expect(d.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(d.function.description.length).toBeGreaterThan(10);
      expect(d.function.parameters.type).toBe("object");
      expect(d.function.parameters).not.toHaveProperty("$schema");
    }
  });

  it("are plain JSON a provider can accept", () => {
    expect(JSON.parse(JSON.stringify(definitions))).toEqual(definitions);
    expect(JSON.stringify(definitions).length).toBeLessThan(40_000);
    expect(JSON.stringify(toolDefinitions(NARRATIVE_TOOLS)).length).toBeLessThan(40_000);
  });

  it("carry precise schemas generated from the core types", () => {
    const create = byName.createCharacter!.parameters as any;
    expect(create.properties.character.required).toEqual(expect.arrayContaining(["id", "kind", "behavior", "stats"]));
    expect(create.properties.character.properties.kind.const).toBe("enemy");
    const behavior = (byName.setBehavior!.parameters as any).properties.behavior;
    const actions = behavior.properties.states.additionalProperties.properties.action.oneOf;
    expect(actions.map((a: any) => a.properties.type.const)).toEqual(ACTION_TYPES);
    expect(actions[0].description).toContain("back and forth");
    expect((byName.addSpawn!.parameters as any).properties.y.description).toContain("downward");
  });
});

describe("executeTool", () => {
  it("stages writes on the draft so later calls see them", () => {
    const draft = new Draft(createDefaultProject());
    expect(run(draft, "duplicateCharacter", { characterId: "charger", newId: "fast_charger" })).toMatchObject({ ok: true });
    expect(run(draft, "updateBehavior", { characterId: "fast_charger", stateId: "charge", action: { speed: 800 } })).toMatchObject({
      ok: true,
    });
    expect(draft.calls.map((c) => c.name)).toEqual(["duplicateCharacter", "updateBehavior"]);
    expect(draft.base).toEqual(createDefaultProject()); // base untouched
  });

  it("reports warnings after a write", () => {
    const draft = new Draft(createDefaultProject());
    const result = run(draft, "duplicateCharacter", { characterId: "crawler", newId: "crawler_b" });
    expect(result.warnings).toEqual([expect.stringContaining('"crawler_b" has no spawn')]);
  });

  it("returns readable errors with hints, without staging anything", () => {
    const draft = new Draft(createDefaultProject());
    const result = run(draft, "updateBehavior", { characterId: "charger", stateId: "lunge", action: { speed: 1 } });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(result.error.message).toContain("known: patrol, windup, charge, recover");
    expect(draft.changed).toBe(false);
  });

  it("handles unknown tools and malformed arguments", () => {
    const draft = new Draft(createDefaultProject());
    expect(executeTool(draft, "launchMissiles", "{}")).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
    expect(executeTool(draft, "addSpawn", "{not json")).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(executeTool(draft, "getProjectSummary", "")).toMatchObject({ ok: true });
  });

  it("read tools describe the draft, not the base", () => {
    const draft = new Draft(createDefaultProject());
    run(draft, "deleteCharacter", { characterId: "crawler" });
    expect(run(draft, "getProjectSummary", {}).summary).not.toContain("crawler");
    expect(run(draft, "getCharacter", { characterId: "charger" })).toMatchObject({
      ok: true,
      character: { id: "charger" },
      spawns: [{ id: "charger_1" }],
    });
    expect(run(draft, "getCharacter", { characterId: "crawler" })).toMatchObject({ ok: false });
    expect(run(draft, "listPrimitives", {}).actions.oneOf).toHaveLength(ACTION_TYPES.length);
  });
});

describe("summaries and prompt", () => {
  it("summarize the project readably", () => {
    const summary = summarizeProject(createDefaultProject());
    expect(summary).toContain("Arena: 1600x720 px");
    expect(summary).toContain("The player stands on y = 660");
    expect(summary).toContain("windup: telegraph(color #ffd27a, shake false); [0] -> charge when after(seconds 0.6)");
    expect(summary).toContain("charger_1 (640, 660)");
    expect(summary).toContain("Warnings: none");
  });

  it("puts the current project in the system prompt", () => {
    expect(buildSystemPrompt(createDefaultProject())).toContain('Project "Untitled Game" (revision 0)');
  });
});
