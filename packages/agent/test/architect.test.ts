import { describe, expect, it } from "vitest";
import { fixtureReferenceProject } from "@anomaly/core";
import { ARCHITECT_TOOLS, architectAgent, buildArchitectPrompt, callTools, Draft, executeTool, FakeModel, runAgentTurn, say, toolCall } from "../src/index.ts";

const run = (draft: Draft, name: string, args: unknown) => executeTool(draft, name, JSON.stringify(args), ARCHITECT_TOOLS) as Record<string, any>;

describe("the Architect agent", () => {
  it("seeds, reads, checks and edits the plan; pinned rooms are refused; runs are queued", () => {
    const draft = new Draft(fixtureReferenceProject());
    expect(run(draft, "checkPlan", {}).issues).toEqual([{ code: "no-rooms", message: "the plan has no rooms (start from the progression: seedArchitectPlan)" }]);
    expect(run(draft, "seedArchitectPlan", {})).toMatchObject({ ok: true });
    const plan = run(draft, "getArchitectPlan", {}).plan;
    expect(plan.rooms.length).toBeGreaterThan(3);
    expect(plan.issues).toEqual([]);
    expect(run(draft, "checkPlan", {}).issues).toEqual([]);

    const room = plan.rooms[1];
    expect(run(draft, "updateRoomPlan", { roomId: room.id, changes: { cols: 60, terrain: { verticality: 0.8 }, notes: "a long climb" } })).toMatchObject({ ok: true });
    expect(run(draft, "setRoomPinned", { roomId: room.id, pinned: true })).toMatchObject({ ok: true });
    expect(run(draft, "updateRoomPlan", { roomId: room.id, changes: { cols: 30 } }).error.message).toContain("pinned");
    // A plan check catches a missing ending.
    const ending = plan.rooms.find((r: any) => r.contents.some((c: any) => c.kind === "ending"));
    run(draft, "updateRoomPlan", { roomId: ending.id, changes: { contents: [] } });
    expect(run(draft, "checkPlan", {}).issues.map((i: any) => i.code)).toContain("ending");

    expect(run(draft, "runArchitect", { from: "geometry", rooms: [room.id] })).toMatchObject({ ok: true });
    expect(draft.runs).toEqual([{ from: "geometry", rooms: [room.id] }]);
    // The design reads are there too; the build assistant's tools aren't.
    expect(run(draft, "getProgression", {})).toMatchObject({ ok: true, start: "undercroft" });
    expect(run(draft, "createCharacter", {}).error.code).toBe("unknown_tool");
    expect(run(draft, "setStageStatus", {}).error.code).toBe("unknown_tool");
  });

  it("its prompt carries the plan, the creator's notes, pins and issues", () => {
    const project = fixtureReferenceProject();
    expect(buildArchitectPrompt(project)).toContain("Plan issues (checkPlan): the plan has no rooms");
    const draft = new Draft(project);
    run(draft, "seedArchitectPlan", {});
    run(draft, "setArchitectGuidance", { guidance: "lonely and vertical", region: { regionId: "spire", notes: "tall shafts" } });
    run(draft, "setRoomPinned", { roomId: draft.current.architect.rooms[0]!.id, pinned: true });
    const prompt = buildArchitectPrompt(draft.current);
    expect(prompt).toContain("creator's game notes: lonely and vertical");
    expect(prompt).toContain("creator's notes: tall shafts");
    expect(prompt).toContain(`pinned: ${draft.current.architect.rooms[0]!.id}`);
    expect(prompt).toContain("Plan issues: none.");
  });

  it("a turn saves its plan edits as one commit and hands back the queued run", async () => {
    const project = fixtureReferenceProject();
    const committed: unknown[] = [];
    const result = await runAgentTurn({
      project,
      history: [],
      userMessage: "Plan the world and build it.",
      agent: architectAgent,
      model: new FakeModel([callTools(toolCall("seedArchitectPlan", {}), toolCall("checkPlan", {})), callTools(toolCall("runArchitect", {})), say("Planned the world from the progression; building it now.")]),
      commit: async (operations) => {
        committed.push(operations);
        return { ok: true, project: { ...project, revision: project.revision + 1 }, canUndo: true };
      },
    });
    expect(result.outcome).toBe("committed");
    expect(committed).toEqual([[{ name: "seedArchitectPlan", input: {} }]]);
    expect(result.runs).toEqual([{}]);
  });
});
