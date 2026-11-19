import { describe, expect, it } from "vitest";
import { applyOperation, exampleRig, fixtureAnimatedProject, gameArtPlan, ProjectSpec, runtimeImageRefs, type CharacterAsset, type OperationResult } from "../src/index.ts";

function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

/** The fixture with some assets changed. */
function edit(p: ProjectSpec, changes: Record<string, (a: CharacterAsset) => CharacterAsset>): ProjectSpec {
  return ProjectSpec.parse({ ...p, art: { ...p.art, assets: p.art.assets.map((a) => (changes[a.id] && a.kind === "character" ? changes[a.id]!(a) : a)) } });
}

const objectSteps = (p: ProjectSpec) => gameArtPlan(p).filter((s) => s.kind === "object");

describe("the game-art plan draws the objects the game uses", () => {
  it("nothing to do when every object in use is rigged and has every clip it plays", () => {
    expect(objectSteps(fixtureAnimatedProject())).toEqual([]);
  });

  it("an object in use without a rig is drawn and animated; one missing a clip the game plays is animated for just that clip", () => {
    const p = edit(fixtureAnimatedProject(), {
      trap: (a) => ({ ...a, rig: null, clips: {} }),
      lever: (a) => ({ ...a, clips: { idle: a.clips.idle! } }),
      bolt: (a) => ({ ...a, clips: { idle: a.clips.idle!, charge: a.clips.charge! } }),
    });
    const steps = objectSteps(p);
    expect(steps.map((s) => [s.id, s.reason, s.request])).toEqual([
      ["object:lever", "incomplete", { stage: "animate", objectId: "lever", clips: ["pull"] }],
      ["object:trap", "missing", { stage: "auto", objectId: "trap" }],
      ["object:bolt", "incomplete", { stage: "animate", objectId: "bolt", clips: ["fly", "burst"] }],
    ]);
    expect(steps.every((s) => s.estimatedCost > 0)).toBe(true);
    expect(steps.find((s) => s.id === "object:trap")?.description).toBe("draw and animate Trap");
  });

  it("objects nobody uses are left alone", () => {
    const p = ok(applyOperation(fixtureAnimatedProject(), "createObject", { id: "spare", name: "Spare", brief: "a crate nobody placed" }));
    expect(objectSteps(p)).toEqual([]);
    // Once a prop draws with it, it is planned.
    const used = ok(applyOperation(p, "addProp", { roomId: "arena", id: "crate", x: 100, y: 100, width: 40, height: 40, art: { object: "spare", idle: "idle" } }));
    expect(objectSteps(used).map((s) => s.id)).toEqual(["object:spare"]);
  });

  it("the runtime is sent an object's images (a cutout source)", () => {
    const source = `${"a".repeat(32)}.png`;
    const p = edit(fixtureAnimatedProject(), { lever: (a) => ({ ...a, rig: { ...exampleRig(), mode: "cutout", source: { file: source, scale: 0.5, anchor: [10, 20] } } }) });
    expect(runtimeImageRefs(p)).toContain(source);
  });
});
