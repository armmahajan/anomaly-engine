import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, fixtureReferenceProject, lintProgressionWorld, ProjectSpec } from "@anomaly/core";
import { callTools, Draft, executeTool, FakeModel, runAgentTurn, say, summarizeProject, toolCall, type AgentEvent, type ModelRequest } from "../src/index.ts";

const run = (draft: Draft, name: string, args: unknown) => executeTool(draft, name, JSON.stringify(args)) as Record<string, any>;

/** The reference game's documents (and cast) over an untouched default world. */
function documentsOnly(): ProjectSpec {
  const reference = fixtureReferenceProject();
  return ProjectSpec.parse({ ...createDefaultProject(), wiki: reference.wiki, progression: reference.progression, characters: reference.characters, world: { ...createDefaultProject().world, rooms: createDefaultProject().world.rooms.map((r) => ({ ...r, spawns: [] })) } });
}

/** JSON results of the tool calls in a request, by tool name. */
const results = (request: ModelRequest) => {
  const names = new Map(request.messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => [c.id, c.function.name] as const) : [])));
  return Object.fromEntries(request.messages.flatMap((m) => (m.role === "tool" ? [[names.get(m.tool_call_id)!, JSON.parse(m.content)]] : [])));
};

describe("the build assistant reads the design", () => {
  it("summarizes regions, their rooms and pickups, abilities, gates and cast", () => {
    const summary = summarizeProject(fixtureReferenceProject());
    expect(summary).toContain("Design (the director's documents; getProgression, getWikiPage): start undercroft, ending summit; 7 wiki page(s).");
    expect(summary).toContain('- region undercroft "The Undercroft" [wiki undercroft]: rooms entrance, hall (planned 2); gives hatch_key (entrance/key)');
    expect(summary).toContain('- region spire "The Spire" [wiki spire]: rooms cistern, spikes, bridge, sanctum (planned 4); gives double_jump (sanctum/guardian_1); boss guardian; enemies crawler');
    expect(summary).toContain('- region summit "The Summit" [wiki summit]: rooms summit (planned 1)');
    expect(summary).toContain('- ability double_jump "Double jump" (double_jump) in spire (boss)');
    expect(summary).toContain("- gate down_the_hatch: undercroft -> spire needs hatch_key");
    expect(summary).toContain("- gate up_to_summit: spire <-> summit needs double_jump");
    expect(summary).toContain("Cast: player [wiki wanderer], crawler [wiki crawler], guardian [wiki guardian]");
    expect(summarizeProject(createDefaultProject())).not.toContain("Design");
  });

  it("reads wiki pages and the progression", () => {
    const draft = new Draft(fixtureReferenceProject());
    expect(run(draft, "getWikiPage", { pageId: "guardian" })).toMatchObject({ ok: true, page: { title: "The Iron Guardian" }, character: { id: "guardian", kind: "enemy" } });
    expect(run(draft, "getWikiPage", { pageId: "spire" }).describes).toEqual(["spire"]);
    expect(run(draft, "getWikiPage", { pageId: "nope" }).error.message).toContain("known pages: overview, undercroft");
    const progression = run(draft, "getProgression", {});
    expect(progression).toMatchObject({ ok: true, start: "undercroft", ending: "summit", finishable: true, criticalPath: ["hatch_key", "double_jump"], issues: [], worldWarnings: [] });
    expect(progression.regions.find((r: any) => r.id === "spire").worldRooms).toEqual(["cistern", "spikes", "bridge", "sanctum"]);
    expect(progression.abilities.find((a: any) => a.id === "double_jump").givenAt).toEqual(["sanctum/guardian_1"]);
  });

  it("reads a weapon in full: every attack's numbers, and who starts with or wields it", () => {
    const base = fixtureReferenceProject();
    const blade = { id: "blade", name: "Blade", attacks: [{ id: "cut", name: "Cut", shape: { type: "arc", radius: 60 }, damage: 3 }] };
    const draft = new Draft(ProjectSpec.parse({ ...base, weapons: { ...base.weapons, list: [blade], loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: "blade" }], cycle: false } } }));
    expect(run(draft, "getWeapon", { weaponId: "blade" })).toMatchObject({ ok: true, weapon: { id: "blade", attacks: [{ id: "cut", damage: 3, shape: { type: "arc", radius: 60 } }] }, startsIn: ["main"] });
    expect(run(draft, "getWeapon", { weaponId: "nope" }).error.message).toContain("known weapons: blade");
    expect(summarizeProject(draft.current)).toContain("Weapons (getWeapon reads one in full): blade (cut)");
  });

  it("queues character art without a brief when the wiki describes the character", () => {
    const draft = new Draft(fixtureReferenceProject(), true);
    expect(run(draft, "generateCharacterArt", { characterId: "guardian" })).toMatchObject({ ok: true });
    expect(draft.jobs).toEqual([{ stage: "auto", characterId: "guardian" }]);
    expect(run(new Draft(createDefaultProject(), true), "generateCharacterArt", { characterId: "charger" }).error.message).toContain("give a brief");
  });

  it("builds a region from the documents in a scripted turn", async () => {
    let project = documentsOnly();
    const events: AgentEvent[] = [];
    const model = new FakeModel([
      callTools(toolCall("getProgression", {}), toolCall("getWikiPage", { pageId: "spire" })),
      (request) => {
        // Build what the documents say: the region's rooms, named from its wiki page, and its ability.
        const { getProgression: progression, getWikiPage: wiki } = results(request);
        const region = progression.regions.find((r: any) => r.wikiPageId === wiki.page.id);
        const ability = progression.abilities.find((a: any) => a.obtainedIn?.regionId === region.id);
        const rooms = ["cistern", "sanctum"];
        return callTools(
          ...rooms.map((id, i) => toolCall("createWorldRoom", { id, name: `${wiki.page.title} ${id}`, cols: 30, rows: 14, at: { x: 40 + 30 * i, y: 0 }, regionId: region.id })),
          toolCall("setDoor", { roomId: "cistern", door: { id: "east", side: "right", offset: 9, size: 3 } }),
          toolCall("setDoor", { roomId: "sanctum", door: { id: "west", side: "left", offset: 9, size: 3 } }),
          toolCall("connectDoors", { from: { roomId: "cistern", doorId: "east" }, to: { roomId: "sanctum", doorId: "west" } }),
          toolCall("addProp", { roomId: "sanctum", id: "relic", x: 600, y: 380, width: 24, height: 24, color: "#e8c547", visible: { type: "not", of: { type: "ability", ability: ability.mechanic } } }),
          toolCall("addHandler", { roomId: "sanctum", propId: "relic", handler: { on: { type: "touch" }, do: [{ type: "grantAbility", ability: ability.mechanic }] } }),
        );
      },
      say("Built The Spire: a cistern and the sanctum, with the double jump on an altar in the sanctum."),
    ]);
    const result = await runAgentTurn({
      model,
      project,
      history: [],
      userMessage: "Build the Spire from the wiki.",
      commit: async (operations) => {
        const applied = applyBatch(project, operations);
        if (!applied.ok) return applied;
        project = applied.project;
        return { ok: true, project, canUndo: true };
      },
      onEvent: (e) => events.push(e),
    });
    expect(result.outcome).toBe("committed");
    expect(events.filter((e) => e.type === "tool_result").every((e) => !(e as { isError?: boolean }).isError)).toBe(true);
    expect(project.world.rooms.filter((r) => r.regionId === "spire").map((r) => r.name)).toEqual(["The Spire cistern", "The Spire sanctum"]);
    expect(project.world.rooms.find((r) => r.id === "sanctum")!.props[0]!.handlers[0]!.do).toEqual([{ type: "grantAbility", ability: "double_jump" }]);
    // The spire is done; the lint now points at the regions still to build.
    const warnings = lintProgressionWorld(project);
    expect(warnings.filter((w) => /spire|Spire|double_jump/.test(w.message))).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(["region_without_rooms", "region_without_rooms"]);
  });
});
