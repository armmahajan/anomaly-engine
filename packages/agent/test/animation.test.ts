import { describe, expect, it } from "vitest";
import { createDefaultProject, fixtureAnimatedProject } from "@anomaly/core";
import { buildSystemPrompt, Draft, executeTool, summarizeProject } from "../src/index.ts";

const run = (draft: Draft, name: string, args: unknown) => executeTool(draft, name, JSON.stringify(args)) as Record<string, any>;

describe("the build assistant and animation in play", () => {
  it("makes an object, queues its art by objectId and refuses what isn't an object", () => {
    const draft = new Draft(createDefaultProject(), true);
    expect(run(draft, "createObject", { id: "lever", name: "Lever", brief: "a rusted floor lever with a red knob" })).toMatchObject({ ok: true });
    expect(run(draft, "generateObjectArt", { objectId: "lever" })).toMatchObject({ ok: true });
    expect(run(draft, "generateObjectArt", { objectId: "lever", brief: " taller, brass " })).toMatchObject({ ok: true });
    expect(draft.jobs).toEqual([
      { stage: "auto", objectId: "lever" },
      { stage: "auto", objectId: "lever", brief: "taller, brass" },
    ]);
    expect(run(draft, "generateObjectArt", { objectId: "crawler" }).error.message).toContain('no object "crawler"');
    expect(run(draft, "generateObjectArt", { objectId: "crawler" }).error.message).toContain("objects: lever");
    expect(run(new Draft(draft.current, false), "generateObjectArt", { objectId: "lever" }).error.code).toBe("unavailable");
  });

  it("asks for a brief when the object has none", () => {
    const draft = new Draft(createDefaultProject(), true);
    run(draft, "createObject", { id: "spark", name: "Spark", brief: "" });
    expect(run(draft, "generateObjectArt", { objectId: "spark" }).error.message).toContain("give a brief");
    expect(run(draft, "generateObjectArt", { objectId: "spark", brief: "a crackling spark" })).toMatchObject({ ok: true });
  });

  it("draws a prop with an object and plays its clips from handlers", () => {
    const draft = new Draft(fixtureAnimatedProject());
    expect(
      run(draft, "addProp", {
        roomId: "arena",
        id: "bell",
        x: 600,
        y: 560,
        width: 32,
        height: 32,
        art: { object: "lever", idle: "idle", scale: 1.5 },
        handlers: [{ on: { type: "hit" }, do: [{ type: "playAnimation", clip: "pull", then: "hold" }, { type: "spawnEffect", object: "shockwave", clip: "burst", at: { kind: "self" } }] }],
      }),
    ).toMatchObject({ ok: true });
    expect(run(draft, "setClipMarkers", { assetId: "lever", clipId: "pull", markers: [{ t: 0.3, name: "creak" }, { t: 0.7, name: "click" }] })).toMatchObject({ ok: true });
    const summary = summarizeProject(draft.current);
    expect(summary).toContain("- prop arena/bell (600, 560) 32x32; object lever (idle idle)");
    expect(summary).toContain('on hit do playAnimation(target {"kind":"self"}, clip "pull", then "hold"), spawnEffect(object "shockwave", clip "burst"');
  });

  it("lists objects with their clips, markers and uses, and characters' clips with markers", () => {
    const summary = summarizeProject(fixtureAnimatedProject());
    expect(summary).toContain("Objects (createObject; generateObjectArt draws one; props, spawnEffect and projectile looks use them):");
    expect(summary).toContain('- lever "Lever": clips idle, pull (click@0.7); used by the prop "Lever" in "Arena"');
    expect(summary).toContain('- bolt "Bolt": clips idle, charge, fly, burst; used by the shoot state "fire" of "crawler"');
    expect(summary).toContain('- shockwave "Shockwave": clips idle, burst; used by a spawnEffect');
    expect(summary).toContain('Drawn by art asset "charger_look", clips idle, attack (impact@0.5).');
    expect(summarizeProject(createDefaultProject())).toContain("Objects: none (createObject makes one");
  });

  it("tells the model how objects, effects, markers and projectile looks work, without roles", () => {
    const prompt = buildSystemPrompt(createDefaultProject());
    for (const words of ["createObject", "generateObjectArt", "art {object, idle, scale}", "playAnimation", "spawnEffect", "setClipMarkers", "marker event", "appear fire or windup", "art {object, charge, fly, burst}"]) {
      expect(prompt).toContain(words);
    }
    expect(prompt).toContain("nothing has a fixed role");
  });
});
