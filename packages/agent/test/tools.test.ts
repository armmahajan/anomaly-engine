import { describe, expect, it } from "vitest";
import { ACTION_TYPES, ARCHITECT_OPERATION_NAMES, createDefaultProject, fixtureProject, OPERATION_NAMES, PROGRESSION_OPERATION_NAMES, WIKI_OPERATION_NAMES } from "@anomaly/core";
import { buildSystemPrompt, Draft, executeTool, ART_TOOL_NAMES, NARRATIVE_TOOLS, PIPELINE_ONLY_OPERATIONS, READ_TOOL_NAMES, STUDIO_ONLY_OPERATIONS, summarizeProject, toolDefinitions } from "../src/index.ts";

const definitions = toolDefinitions();
const byName = Object.fromEntries(definitions.map((d) => [d.function.name, d.function]));
const run = (draft: Draft, name: string, args: unknown) => executeTool(draft, name, JSON.stringify(args)) as Record<string, any>;

describe("tool definitions", () => {
  it("expose every core operation except the director's, pipeline-only art ones and the bone editor's, plus the read tools, with valid names", () => {
    const excluded: string[] = [...WIKI_OPERATION_NAMES, ...PROGRESSION_OPERATION_NAMES, ...ARCHITECT_OPERATION_NAMES, ...PIPELINE_ONLY_OPERATIONS, ...STUDIO_ONLY_OPERATIONS];
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
    // 40k before the game-world tools (+7.6k), handlers (+1.7k), props, modals, combat and controls; weapons +11k
    // (setWeaponAttack carries the attack schema once; createWeapon stays small). Keep new domains this lean.
    expect(JSON.stringify(definitions).length).toBeLessThan(72_000);
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
    expect((byName.addRoomSpawn!.parameters as any).properties.y.description).toContain("downward");
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
    expect(executeTool(draft, "addRoomSpawn", "{not json")).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
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
    expect(summary).toContain("room arena, the player starts at (160, 672) with no abilities");
    expect(summary).toContain("windup: telegraph(color #ffd27a, shake false); [0] -> charge when after(seconds 0.6)");
    expect(summary).toContain("charger_1 (640, 672)");
    expect(summary).toContain("Warnings: none");
  });

  it("puts the current project in the system prompt", () => {
    expect(buildSystemPrompt(createDefaultProject())).toContain('Project "Untitled Game" (revision 0)');
  });
});

describe("game-world tools", () => {
  it("edit rooms, read one in full and summarize the world", () => {
    const draft = new Draft(fixtureProject());
    expect(run(draft, "paintTiles", { roomId: "hall", kind: "hazard", cells: [[5, 11]] })).toMatchObject({ ok: true });
    const room = run(draft, "getRoom", { roomId: "hall" });
    expect(room.room.grid.rows[11][5]).toBe("^");
    expect(room.summary).toContain("shaft bottom @30+3 -> cistern/shaft");
    expect(run(draft, "getRoom", { roomId: "nope" }).error.message).toContain("known rooms: entrance, hall");
    const summary = run(draft, "getProjectSummary", {}).summary;
    expect(summary).toContain("starts in entrance at (96, 384)");
    expect(summary).toContain('- sanctum "Sanctum" 30x14 tiles at map (148, 5); doors: west left @9+3 -> bridge/east; enemies: charger_1 charger (832, 384)');
  });
});
