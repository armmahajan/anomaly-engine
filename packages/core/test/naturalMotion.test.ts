import { describe, expect, it } from "vitest";
import {
  applyOperation,
  Bone,
  Clip,
  createDefaultProject,
  easeAt,
  Ease,
  exampleClips,
  exampleRig,
  ikProblem,
  lintProject,
  posesFrom,
  ProjectSpec,
  Rig,
  solveIk,
  twoBone,
  type BoneChannels,
  type OperationResult,
  type ProjectSpec as Project,
} from "../src/index.ts";

function ok(result: OperationResult): Project {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

/** A leg rig: root, pelvis, thigh, shin, foot (20 px thigh and shin, the hip 40 px up). */
const legRig = (): Rig =>
  Rig.parse({
    bones: [
      { id: "root", parent: null, pivot: [0, 0] },
      { id: "pelvis", parent: "root", pivot: [0, -40] },
      { id: "thigh", parent: "pelvis", pivot: [0, -40], spring: { stiffness: 0.5 } },
      { id: "shin", parent: "thigh", pivot: [0, -20] },
      { id: "foot", parent: "shin", pivot: [0, 0] },
    ],
    parts: [{ id: "leg", bone: "thigh", z: 0, fill: "#888888", shape: { type: "stroke", points: [[0, -40], [0, 0]], width: 4 } }],
  });

function withLeg(): Project {
  const project = ok(
    applyOperation(createDefaultProject(), "createAsset", { asset: { id: "legs", name: "Legs", kind: "character", brief: "a leg" }, assignTo: "charger" }),
  );
  return ok(applyOperation(project, "setRig", { assetId: "legs", rig: legRig() }));
}

describe("natural motion schema", () => {
  it("adds blendIn, looks and IK to clips with defaults, and springs to bones", () => {
    const clip = Clip.parse({
      duration: 1,
      loop: true,
      tracks: [{ bone: "body", property: "rotate", keys: [[0, 0], [1, 10]], ease: "overshoot" }],
      blendIn: 0.2,
      looks: [{ property: "glow", keys: [[0, 0], [0.5, 1]] }, { part: "eye", property: "tint", color: "#ff0000", keys: [[0, 1]], ease: "bounce" }],
      ik: [{ bone: "shin", tip: "foot", keys: [[0, 4, 0]] }],
    });
    expect(clip.looks![0]!.ease).toBe("smooth");
    expect(clip.looks![0]!.part).toBeUndefined();
    expect(clip.ik![0]!.bend).toBe("cw");
    expect(clip.ik![0]!.ease).toBe("smooth");
    expect(Ease.options).toEqual(["smooth", "linear", "step", "overshoot", "anticipate", "elastic", "bounce"]);
    expect(Bone.parse({ id: "hair", parent: "head", pivot: [0, 0], spring: {} }).spring).toEqual({ stiffness: 0.3, damping: 0.5 });
    expect(Bone.safeParse({ id: "hair", parent: "head", pivot: [0, 0], spring: { stiffness: 0 } }).success).toBe(false);
  });

  it("keeps look values in their ranges, and caps blendIn, looks and IK", () => {
    const look = (property: string, value: number) => Clip.safeParse({ duration: 1, loop: false, looks: [{ property, keys: [[0, value]] }] }).success;
    expect([look("opacity", 1), look("opacity", 1.2), look("brightness", 3.5), look("brightness", 4.5), look("glow", 1), look("tint", 1.1)]).toEqual([true, false, true, false, true, false]);
    expect(Clip.safeParse({ duration: 1, loop: false, blendIn: 1.5 }).success).toBe(false);
    const ik = { bone: "shin", tip: "foot", keys: [[0, 0, 0]] };
    expect(Clip.safeParse({ duration: 1, loop: false, ik: [ik, ik, ik, ik, ik] }).success).toBe(false);
    expect(Clip.safeParse({ duration: 1, loop: false, looks: Array(33).fill({ property: "opacity", keys: [[0, 1]] }) }).success).toBe(false);
    expect(Clip.safeParse({ duration: 1, loop: false, tracks: [{ bone: "a", property: "x", keys: [[0, 1]], ease: "wobbly" }] }).success).toBe(false);
  });

  it("parses old clips, rigs and projects unchanged (no new fields appear)", () => {
    for (const clip of Object.values(exampleClips())) expect(Clip.parse(clip)).toEqual(clip);
    expect(Rig.parse(exampleRig())).toEqual(exampleRig());
    const project = ok(applyOperation(ok(applyOperation(withLeg(), "setRig", { assetId: "legs", rig: exampleRig() })), "setClip", { assetId: "legs", clipId: "idle", clip: exampleClips().idle }));
    const json = JSON.stringify(project);
    expect(JSON.stringify(ProjectSpec.parse(JSON.parse(json)))).toEqual(json);
    expect(json).not.toMatch(/"looks"|"ik"|"blendIn"|"spring"/);
  });
});

describe("eases", () => {
  const curve = (ease: Ease) => Array.from({ length: 201 }, (_, i) => easeAt(ease, i / 200));

  it("start at 0 and end at 1 (step holds 0 until the next key)", () => {
    for (const ease of Ease.options) {
      if (ease === "step") continue;
      expect(easeAt(ease, 0), ease).toBeCloseTo(0, 9);
      expect(easeAt(ease, 1), ease).toBeCloseTo(1, 9);
    }
    expect(curve("step").every((v) => v === 0)).toBe(true);
    expect(easeAt("smooth", 0.5)).toBe(0.5);
    expect(easeAt("linear", 0.3)).toBe(0.3);
  });

  it("overshoot passes 1 then settles; anticipate dips below 0 first; elastic wobbles about 1; bounce stays within 0..1 and lands", () => {
    const over = curve("overshoot");
    expect(Math.max(...over)).toBeGreaterThan(1.05);
    expect(over.at(-1)).toBeCloseTo(1, 9);
    expect(over.indexOf(Math.max(...over))).toBeLessThan(200);
    const back = curve("anticipate");
    expect(Math.min(...back)).toBeLessThan(-0.05);
    expect(back.findIndex((v) => v < 0)).toBeLessThan(back.findIndex((v) => v > 0.5));
    const elastic = curve("elastic");
    expect(Math.max(...elastic)).toBeGreaterThan(1.1);
    expect(elastic.slice(40).filter((v, i, a) => i > 0 && Math.sign(v - 1) !== Math.sign(a[i - 1]! - 1)).length).toBeGreaterThanOrEqual(2);
    const bounce = curve("bounce");
    expect(Math.min(...bounce)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...bounce)).toBeLessThanOrEqual(1 + 1e-9);
    expect(bounce.at(-1)).toBeCloseTo(1, 9);
    // It touches down (reaches 1) before the end, then lifts off again.
    const lands = bounce.findIndex((v) => v > 0.97);
    expect(lands).toBeLessThan(150);
    expect(Math.min(...bounce.slice(lands))).toBeLessThan(0.95);
  });
});

describe("two-bone IK", () => {
  const rig = legRig();
  const channels = () => new Map<string, BoneChannels>(rig.bones.map((b) => [b.id, { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 }]));
  const origin = (poses: Map<string, number[]>, id: string) => [poses.get(id)![4]!, poses.get(id)![5]!];

  it("puts the tip on a reachable target with the knee on the bend side, and keeps the tip's angle", () => {
    for (const bend of ["cw", "ccw"] as const) {
      const ch = channels();
      ch.get("pelvis")!.y = 6;
      ch.get("foot")!.rotate = 15;
      solveIk(rig, { ik: [{ bone: "shin", tip: "foot", keys: [[0, 5, -2]], bend, ease: "smooth" }] }, 0, ch);
      const poses = posesFrom(rig, ch);
      const [fx, fy] = origin(poses, "foot");
      expect(Math.hypot(fx! - 5, fy! + 2)).toBeLessThan(1e-6);
      const [hx, hy] = origin(poses, "thigh");
      const [kx, ky] = origin(poses, "shin");
      const side = (kx! - hx!) * (fy! - hy!) - (ky! - hy!) * (fx! - hx!);
      expect(bend === "cw" ? side > 0 : side < 0, bend).toBe(true);
      const foot = poses.get("foot")!;
      expect((Math.atan2(foot[1], foot[0]) * 180) / Math.PI).toBeCloseTo(15, 6);
    }
  });

  it("leaves a limb straight, pointing at a target out of reach", () => {
    const solved = twoBone([0, 0], 20, 20, [0, 100], "cw");
    expect(solved.upper).toBeCloseTo(Math.PI / 2, 9);
    expect(solved.reach[0]).toBeCloseTo(0, 9);
    expect(solved.reach[1]).toBeCloseTo(40, 9);
  });

  it("says which tracks don't fit a rig", () => {
    expect(ikProblem(rig, { bone: "shin", tip: "foot" })).toBe("");
    expect(ikProblem(rig, { bone: "calf", tip: "foot" })).toMatch(/unknown bone "calf"/);
    expect(ikProblem(rig, { bone: "shin", tip: "toe" })).toMatch(/unknown tip bone "toe"/);
    expect(ikProblem(rig, { bone: "thigh", tip: "foot" })).toMatch(/not a child of "thigh"/);
    expect(ikProblem(rig, { bone: "root", tip: "pelvis" })).toMatch(/root/);
  });
});

describe("IK in operations and lint", () => {
  const ikClip = (bone: string, tip: string) => ({ duration: 1, loop: true, ik: [{ bone, tip, keys: [[0, 4, 0]] }] });

  it("setClip refuses IK the rig can't do and accepts IK it can", () => {
    const bad = applyOperation(withLeg(), "setClip", { assetId: "legs", clipId: "walk", clip: ikClip("thigh", "foot") });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toMatch(/ik\[0\]: tip "foot" is not a child of "thigh"/);
    expect(applyOperation(withLeg(), "setClip", { assetId: "legs", clipId: "walk", clip: ikClip("shin", "foot") }).ok).toBe(true);
  });

  it("lints IK that stopped fitting after a rig edit, and removeBone drops IK on the bone", () => {
    let project = ok(applyOperation(withLeg(), "setClip", { assetId: "legs", clipId: "walk", clip: ikClip("shin", "foot") }));
    project = ok(applyOperation(project, "setClip", { assetId: "legs", clipId: "lift", clip: { ...ikClip("shin", "foot"), looks: [{ part: "wing", property: "glow", keys: [[0, 1]] }] } }));
    expect(lintProject(project).filter((w) => w.code.startsWith("clip_")).map((w) => w.code)).toEqual(["clip_unknown_part"]);
    // A rig whose foot hangs off the thigh now: the clip's IK no longer fits.
    const rig = legRig();
    const moved = { ...rig, bones: rig.bones.map((b) => (b.id === "foot" ? { ...b, parent: "thigh" } : b)) };
    const linted = lintProject(ok(applyOperation(project, "setRig", { assetId: "legs", rig: moved })));
    expect(linted.filter((w) => w.code === "clip_bad_ik").map((w) => w.path)).toEqual(["art.assets.0.clips.walk.ik.0", "art.assets.0.clips.lift.ik.0"]);
    const removed = ok(applyOperation(project, "removeBone", { assetId: "legs", bone: "foot" }));
    const asset = removed.art.assets[0]!;
    expect(asset.kind === "character" && asset.clips.walk!.ik).toEqual([]);
  });
});
