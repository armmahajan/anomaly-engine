import { describe, expect, it } from "vitest";
import { createDefaultProject } from "@anomaly/core";
import { buildSystemPrompt, Draft, executeTool, summarizeProject } from "../src/index.ts";

const run = (draft: Draft, name: string, args: unknown) => executeTool(draft, name, JSON.stringify(args)) as Record<string, any>;

describe("the build assistant and looks", () => {
  it("the prompt lists the look effects and stateEntered, with example compositions", () => {
    const prompt = buildSystemPrompt(createDefaultProject());
    for (const word of ["setLook", "clearLook", "emit", "dissolve", "cameraZoom", "stateEntered", "afterimages", "healthBelow"]) expect(prompt).toContain(word);
    const looks = prompt.slice(prompt.indexOf("- Looks"), prompt.indexOf("\n", prompt.indexOf("- Looks")));
    expect(looks).not.toMatch(/\b(boss|enrage|enraged|phase)\b/i);
  });

  it("gives a state a look with updateBehavior, puts looks on in handlers, and the summary lists a state's look", () => {
    const draft = new Draft(createDefaultProject());
    expect(run(draft, "updateBehavior", { characterId: "charger", stateId: "windup", look: { brightness: 1.8, aura: { color: "#ffd27a" } } })).toMatchObject({ ok: true });
    expect(summarizeProject(draft.current)).toContain("windup: telegraph(color #ffd27a, shake false); [0] -> charge when after(seconds 0.6); look brightness+aura");
    expect(
      run(draft, "addHandler", {
        roomId: "arena",
        spawnId: "charger_1",
        handler: { on: { type: "stateEntered", state: "charge" }, do: [{ type: "setLook", look: { afterimages: { count: 5 } }, seconds: 1 }, { type: "cameraZoom", amount: 1.1 }] },
      }),
    ).toMatchObject({ ok: true });
    expect(run(draft, "updateBehavior", { characterId: "charger", stateId: "windup", look: null })).toMatchObject({ ok: true });
    expect(summarizeProject(draft.current)).not.toContain("look brightness");
  });
});
