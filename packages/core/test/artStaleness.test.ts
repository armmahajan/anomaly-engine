import { describe, expect, it } from "vitest";
import { applyOperation, artStaleness, createDefaultProject, exampleClips, exampleRig, rigFingerprint, type CharacterAsset, type OperationResult, type ProjectSpec } from "../src/index.ts";

const ok = (r: OperationResult): ProjectSpec => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const asset = (p: ProjectSpec) => p.art.assets.find((a) => a.id === "look") as CharacterAsset;

function built(): ProjectSpec {
  let p = createDefaultProject();
  p = ok(applyOperation(p, "createAsset", { asset: { id: "look", name: "Look", kind: "character", brief: "b" }, assignTo: "charger" }));
  p = ok(applyOperation(p, "addConcept", { assetId: "look", concept: { file: "a1a1a1a1a1a1a1a1.png", prompt: "p", model: "m", cost: 0, at: "2026-01-01T00:00:00Z" } }));
  p = ok(applyOperation(p, "chooseConcept", { assetId: "look", sheet: 0, cell: 1, file: "d1d1d1d1d1d1d1d1.png" }));
  p = ok(applyOperation(p, "setRig", { assetId: "look", rig: exampleRig() }));
  p = ok(applyOperation(p, "setClip", { assetId: "look", clipId: "idle", clip: exampleClips().idle }));
  return p;
}

describe("a character's art steps know what they were built from", () => {
  it("a built character is up to date; the rig records its design, the clips their rig", () => {
    const a = asset(built());
    expect(a.rigFrom).toBe("d1d1d1d1d1d1d1d1.png");
    expect(a.clipsFor).toBe(rigFingerprint(exampleRig()));
    expect(artStaleness(a)).toEqual({ rigStale: false, clipsStale: false });
  });

  it("choosing another design makes the rig out of date until it is rebuilt", () => {
    let p = ok(applyOperation(built(), "chooseConcept", { assetId: "look", sheet: 0, cell: 2, file: "d2d2d2d2d2d2d2d2.png" }));
    expect(artStaleness(asset(p)).rigStale).toBe(true);
    p = ok(applyOperation(p, "setRig", { assetId: "look", rig: exampleRig() }));
    expect(artStaleness(asset(p)).rigStale).toBe(false);
  });

  it("a rig whose bones changed makes the clips out of date until they are rewritten", () => {
    const moved = exampleRig();
    moved.bones[1] = { ...moved.bones[1]!, pivot: [moved.bones[1]!.pivot[0] + 6, moved.bones[1]!.pivot[1]] };
    let p = ok(applyOperation(built(), "setRig", { assetId: "look", rig: moved }));
    expect(artStaleness(asset(p))).toEqual({ rigStale: false, clipsStale: true });
    p = ok(applyOperation(p, "setClip", { assetId: "look", clipId: "idle", clip: exampleClips().idle }));
    expect(artStaleness(asset(p)).clipsStale).toBe(false);
  });

  it("art saved before these were recorded counts as up to date", () => {
    const { rigFrom: _r, clipsFor: _c, ...older } = asset(built());
    expect(artStaleness({ ...older, chosen: { sheet: 0, cell: 3, file: "0f0f0f0f0f0f0f0f.png" } } as CharacterAsset)).toEqual({ rigStale: false, clipsStale: false });
  });
});
