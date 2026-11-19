import { describe, expect, it } from "vitest";
import { createDefaultProject, Rig, type Part } from "@anomaly/core";
import { encodePng, FakeImageModel, FakeRenderer, fixNearFar, nearFarPairs, tintBranches, type ArtActivity, type ArtContext, type Pixels, type VisionModel } from "../src/index.ts";

// The near/far check (nearFar.ts): limbs labelled the wrong way round are swapped when the vision
// model, asked twice with the colours swapped, both times says the far-named limb is in front.

const blob = (id: string, bone: string, z: number, x0: number, x1: number, y0: number, y1: number): Part => ({
  id,
  bone,
  z,
  shape: { type: "blob", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], smooth: 0, sharp: [] },
  fill: "#888888",
  ink: 1,
  glow: false,
  opacity: 1,
});

/** Arms on a torso; the arm planned as "near" (x -12..-4) is really behind, the "far" one (4..12) in front. */
const rig = Rig.parse({
  bones: [
    { id: "root", parent: null, pivot: [0, 0] },
    { id: "torso", parent: "root", pivot: [0, -30] },
    { id: "near_upper_arm", parent: "torso", pivot: [-8, -50] },
    { id: "near_lower_arm", parent: "near_upper_arm", pivot: [-8, -35] },
    { id: "far_upper_arm", parent: "torso", pivot: [8, -50] },
    { id: "far_lower_arm", parent: "far_upper_arm", pivot: [8, -35] },
    { id: "near_thigh", parent: "torso", pivot: [-4, -20] },
    { id: "far_thigh", parent: "torso", pivot: [4, -20] },
  ],
  parts: [
    blob("torso", "torso", 4, -10, 10, -55, -20),
    blob("near_upper_arm", "near_upper_arm", 7, -12, -4, -52, -35),
    blob("near_lower_arm", "near_lower_arm", 8, -12, -4, -35, -22),
    blob("far_upper_arm", "far_upper_arm", 1, 4, 12, -52, -35),
    blob("far_lower_arm", "far_lower_arm", 1, 4, 12, -35, -22),
    blob("near_thigh", "near_thigh", 6, -8, -1, -20, 0),
    blob("far_thigh", "far_thigh", 2, 1, 8, -20, 0),
  ],
});
// The design: 100 x 100, opaque grey; rig (0, 0) sits at design (50, 90), 1 rig px = 1 design px.
const frame = { scale: 1, anchor: [50, 90] as [number, number] };
const design: Pixels = { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4).fill(128) };

/** A vision model that answers the near/far question from a script, in order. */
function scripted(answers: string[]): VisionModel & { asked: number } {
  const model = {
    id: "script",
    asked: 0,
    async complete() {
      const near = answers[model.asked++] ?? "unsure";
      return { text: JSON.stringify({ near }), usage: { cost: 0 }, model: "script" };
    },
  };
  return model as unknown as VisionModel & { asked: number };
}

function context(vision: VisionModel, log: ArtActivity[]): ArtContext {
  return {
    project: () => createDefaultProject(),
    image: new FakeImageModel(),
    vision,
    renderer: new FakeRenderer({ pixels: true }),
    files: { put: async () => { throw new Error("no files here"); }, get: async () => { throw new Error("no files here"); } },
    log: (a) => log.push(a),
    remaining: () => 1,
    spend: () => {},
  };
}

describe("near/far check", () => {
  it("finds the near/far pairs at the top of their branches", () => {
    expect(nearFarPairs(rig)).toEqual([
      ["near_upper_arm", "far_upper_arm"],
      ["near_thigh", "far_thigh"],
    ]);
  });

  it("tints the two branches only where they stick out past the body", () => {
    const tinted = tintBranches(design, rig, frame, "near_upper_arm", "far_upper_arm", [
      [255, 140, 0],
      [0, 200, 255],
    ]);
    const at = (x: number, y: number) => Array.from(tinted.data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 3));
    const grey = [128, 128, 128];
    expect(at(50 - 11, 90 - 40)).not.toEqual(grey); // the near-named upper arm, past the torso's edge
    expect(at(50 - 11, 90 - 25)).not.toEqual(grey); // its forearm comes along
    expect(at(50 + 11, 90 - 40)).not.toEqual(at(50 - 11, 90 - 40)); // the other branch, the other colour
    expect(at(50 - 8, 90 - 40)).toEqual(grey); // where an arm lies on the torso: the design's own drawing
    expect(at(50, 90 - 50)).toEqual(grey); // the torso
    expect(at(50 - 4, 90 - 10)).toEqual(grey); // a thigh
  });

  it("swaps a pair only when both answers say the far-named limb is in front", async () => {
    const png = encodePng(design);
    const log: ArtActivity[] = [];
    // First ask: near-named is orange, so "cyan" means the far-named one is in front; second ask the colours flip.
    const vision = scripted(["cyan", "orange", "unsure", "unsure"]);
    const { rig: fixed, swapped } = await fixNearFar(context(vision, log), { rig, frame, design: png, name: "Hero" });
    expect(vision.asked).toBe(4); // two pairs, asked twice each
    expect(swapped).toEqual([["near_upper_arm", "far_upper_arm"]]);
    const part = (id: string) => fixed.parts.find((p) => p.id === id)!;
    // The arm drawn at x 4..12 is the near one now, drawn in front; nothing moved.
    expect(part("near_upper_arm").shape).toEqual(rig.parts.find((p) => p.id === "far_upper_arm")!.shape);
    expect(part("near_upper_arm").z).toBe(7);
    expect(part("far_lower_arm").z).toBe(1);
    expect(fixed.bones.find((b) => b.id === "near_lower_arm")!.pivot).toEqual([8, -35]);
    expect(part("near_thigh")).toEqual(rig.parts.find((p) => p.id === "near_thigh"));
    expect(log.some((a) => a.text.includes("labelled the wrong way round"))).toBe(true);
  });

  it("keeps the labels when the answers disagree, are unsure or say they are right", async () => {
    const png = encodePng(design);
    for (const answers of [
      ["cyan", "cyan"], // the same colour twice: a colour bias, not an answer
      ["orange", "cyan"], // as named
      ["unsure", "orange"],
    ]) {
      const { rig: kept, swapped } = await fixNearFar(context(scripted([...answers, "unsure", "unsure"]), []), { rig, frame, design: png, name: "Hero" });
      expect(swapped).toEqual([]);
      expect(kept).toEqual(rig);
    }
  });
});
