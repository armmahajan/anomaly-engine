import { describe, expect, it } from "vitest";
import {
  applyBatch,
  applyOperation,
  createDefaultProject,
  exampleClips,
  exampleRig,
  undoLast,
  type CharacterAsset,
  type HistoryEntry,
  type OperationResult,
  type Part,
  type ProjectSpec,
  type Rig,
  rigFingerprint,
} from "../src/index.ts";

function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

/** The default project with the example beetle rig (and its clips) on asset "beetle", plus a grip on the head. */
function beetle(rig: Rig = exampleRig()): ProjectSpec {
  let p = ok(applyOperation(createDefaultProject(), "createAsset", { asset: { id: "beetle", name: "Beetle", kind: "character", brief: "a beetle" }, assignTo: "charger" }));
  p = ok(applyOperation(p, "setRig", { assetId: "beetle", rig }));
  for (const [clipId, clip] of Object.entries(exampleClips())) p = ok(applyOperation(p, "setClip", { assetId: "beetle", clipId, clip }));
  if (!rig.bones.some((b) => b.id === "head")) return p;
  return ok(applyOperation(p, "setGrip", { assetId: "beetle", grip: { id: "hand", bone: "head", at: [20, -16], angle: 0 } }));
}

const asset = (p: ProjectSpec) => p.art.assets.find((a) => a.id === "beetle") as CharacterAsset;
const rigOf = (p: ProjectSpec) => asset(p).rig!;
const bone = (p: ProjectSpec, id: string) => rigOf(p).bones.find((b) => b.id === id)!;
const part = (p: ProjectSpec, id: string) => rigOf(p).parts.find((x) => x.id === id)!;
const points = (x: Part) => (x.shape.type === "ellipse" ? [x.shape.center] : x.shape.points);
const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 1));

describe("bone editor operations", () => {
  it("moveBonePivot with carry moves the bone's drawing and everything under it by the same offset", () => {
    const before = beetle();
    const after = ok(applyOperation(before, "moveBonePivot", { assetId: "beetle", bone: "head", pivot: [15, -20] }));
    expect(bone(after, "head").pivot).toEqual([15, -20]);
    expect(bone(after, "horn").pivot).toEqual([23, -26]); // child bone: +3, -2
    // The head's parts and the horn's keep their place relative to their bones.
    for (const id of ["head", "eye", "horn"]) points(part(after, id)).forEach((q, i) => close(q, [points(part(before, id))[i]![0] + 3, points(part(before, id))[i]![1] - 2]));
    expect(rigOf(after).grips![0]!.at).toEqual([23, -18]); // the grip on the head too
    // Bones and parts elsewhere stay.
    expect(bone(after, "body")).toEqual(bone(before, "body"));
    expect(part(after, "shell")).toEqual(part(before, "shell"));
  });

  it("moveBonePivot without carry only re-centres the rotation point", () => {
    const before = beetle();
    const after = ok(applyOperation(before, "moveBonePivot", { assetId: "beetle", bone: "head", pivot: [15, -20], carry: false }));
    expect(bone(after, "head").pivot).toEqual([15, -20]);
    expect(bone(after, "horn")).toEqual(bone(before, "horn"));
    expect(rigOf(after).parts).toEqual(rigOf(before).parts);
    expect(rigOf(after).grips).toEqual(rigOf(before).grips);
  });

  it("rotateBoneRest turns the bone's drawing and descendants about its pivot (clockwise, y down)", () => {
    const before = beetle();
    const after = ok(applyOperation(before, "rotateBoneRest", { assetId: "beetle", bone: "head", degrees: 90 }));
    const [px, py] = bone(before, "head").pivot; // [12, -18]
    const turn = ([x, y]: readonly number[]) => [px - (y! - py), py + (x! - px)];
    expect(bone(after, "head").pivot).toEqual([px, py]);
    close(bone(after, "horn").pivot, turn(bone(before, "horn").pivot));
    points(part(after, "head")).forEach((q, i) => close(q, turn(points(part(before, "head"))[i]!)));
    const eye = part(after, "eye").shape;
    expect(eye.type === "ellipse" && eye.rotation).toBe(90);
    const grip = rigOf(after).grips![0]!;
    close(grip.at, turn([20, -16]));
    expect(grip.angle).toBe(90);
    expect(part(after, "shell")).toEqual(part(before, "shell"));
    // A full turn back restores it (to rounding).
    const back = ok(applyOperation(after, "rotateBoneRest", { assetId: "beetle", bone: "head", degrees: -90 }));
    points(part(back, "horn")).forEach((q, i) => close(q, points(part(before, "horn"))[i]!));
  });

  it("rotateBoneRest without carry re-aims the bone: only the joints under it swing round, the drawing and grips stay", () => {
    const before = beetle();
    const after = ok(applyOperation(before, "rotateBoneRest", { assetId: "beetle", bone: "head", degrees: 90, carry: false }));
    const [px, py] = bone(before, "head").pivot;
    const turn = ([x, y]: readonly number[]) => [px - (y! - py), py + (x! - px)];
    expect(bone(after, "head").pivot).toEqual([px, py]);
    close(bone(after, "horn").pivot, turn(bone(before, "horn").pivot));
    expect(bone(after, "body")).toEqual(bone(before, "body"));
    expect(rigOf(after).parts).toEqual(rigOf(before).parts);
    expect(rigOf(after).grips).toEqual(rigOf(before).grips);
  });

  it("scaleBone scales the bone's own parts about its pivot and moves child bones along the line to them", () => {
    const before = beetle();
    const after = ok(applyOperation(before, "scaleBone", { assetId: "beetle", bone: "head", factor: 2 }));
    const [px, py] = bone(before, "head").pivot;
    const scaled = ([x, y]: readonly number[]) => [px + (x! - px) * 2, py + (y! - py) * 2];
    points(part(after, "head")).forEach((q, i) => close(q, scaled(points(part(before, "head"))[i]!)));
    const eye = part(after, "eye").shape;
    const eye0 = part(before, "eye").shape;
    if (eye.type !== "ellipse" || eye0.type !== "ellipse") throw new Error("eye is an ellipse");
    expect([eye.rx, eye.ry]).toEqual([eye0.rx * 2, eye0.ry * 2]);
    // The horn bone moves away by the same factor; its drawing moves rigidly with it (not scaled).
    const horn0 = bone(before, "horn").pivot;
    const horn1 = bone(after, "horn").pivot;
    close(horn1, scaled(horn0));
    const dx = horn1[0] - horn0[0];
    const dy = horn1[1] - horn0[1];
    points(part(after, "horn")).forEach((q, i) => close(q, [points(part(before, "horn"))[i]![0] + dx, points(part(before, "horn"))[i]![1] + dy]));
    expect(rigOf(after).grips![0]!.at).toEqual(scaled([20, -16]));
    // Strokes get thicker with their bone.
    const legs = ok(applyOperation(before, "scaleBone", { assetId: "beetle", bone: "leg_front", factor: 0.5 }));
    const leg = part(legs, "leg_front").shape;
    expect(leg.type === "stroke" && [leg.width, leg.widthEnd]).toEqual([1.75, 0.75]);
  });

  it("reassignPart moves a part to another bone without moving its shape; its clipped details follow; a bend to the new bone goes", () => {
    const rig = exampleRig();
    rig.parts.push({ id: "shine", bone: "head", z: 5, shape: { type: "ellipse", center: [16, -22], rx: 2, ry: 1, rotation: 0 }, fill: "#ffffff", ink: 0, glow: false, opacity: 1, clipTo: "head", bendTo: "horn" });
    rig.parts.find((x) => x.id === "head")!.bendTo = "horn";
    const before = beetle(rig);
    const after = ok(applyOperation(before, "reassignPart", { assetId: "beetle", part: "head", bone: "horn" }));
    expect(part(after, "head").bone).toBe("horn");
    expect(part(after, "head").bendTo).toBeUndefined();
    expect(part(after, "head").shape).toEqual(part(before, "head").shape);
    expect(part(after, "shine")).toMatchObject({ bone: "horn", clipTo: "head" });
    // A clipped detail moved on its own leaves its clip.
    const detail = ok(applyOperation(before, "reassignPart", { assetId: "beetle", part: "shine", bone: "body" }));
    expect(part(detail, "shine").bone).toBe("body");
    expect(part(detail, "shine").clipTo).toBeUndefined();
    expect(applyOperation(before, "reassignPart", { assetId: "beetle", part: "head", bone: "nope" }).ok).toBe(false);
    expect(applyOperation(before, "reassignPart", { assetId: "beetle", part: "nope", bone: "body" }).ok).toBe(false);
  });

  it("addBone adds a bone under a parent; ids stay unique and parents must exist", () => {
    const before = beetle();
    const after = ok(applyOperation(before, "addBone", { assetId: "beetle", bone: { id: "jaw", parent: "head", pivot: [20, -12] } }));
    expect(bone(after, "jaw")).toEqual({ id: "jaw", parent: "head", pivot: [20, -12] });
    expect(applyOperation(after, "addBone", { assetId: "beetle", bone: { id: "jaw", parent: "head", pivot: [0, 0] } }).ok).toBe(false);
    expect(applyOperation(after, "addBone", { assetId: "beetle", bone: { id: "tail", parent: "nope", pivot: [0, 0] } }).ok).toBe(false);
    let full = after;
    for (let i = rigOf(full).bones.length; i < 24; i++) full = ok(applyOperation(full, "addBone", { assetId: "beetle", bone: { id: `b${i}`, parent: "root", pivot: [0, 0] } }));
    expect(applyOperation(full, "addBone", { assetId: "beetle", bone: { id: "one_more", parent: "root", pivot: [0, 0] } }).ok).toBe(false);
  });

  it("removeBone hands its parts, child bones and grips to its parent and drops its tracks from the clips", () => {
    let before = beetle();
    const clip = { duration: 1, loop: true, tracks: [{ bone: "head", property: "rotate", keys: [[0, 0], [1, 10]] }, { bone: "body", property: "y", keys: [[0, 0]] }], motions: [{ type: "sway", bone: "head", degrees: 5 }] };
    before = ok(applyOperation(before, "setClip", { assetId: "beetle", clipId: "nod", clip }));
    const after = ok(applyOperation(before, "removeBone", { assetId: "beetle", bone: "head" }));
    expect(rigOf(after).bones.some((b) => b.id === "head")).toBe(false);
    expect(bone(after, "horn").parent).toBe("body");
    expect(part(after, "head").bone).toBe("body");
    expect(part(after, "eye").bone).toBe("body");
    expect(rigOf(after).grips![0]!.bone).toBe("body");
    const nod = asset(after).clips.nod!;
    expect(nod.tracks.map((t) => t.bone)).toEqual(["body"]);
    expect(nod.motions).toEqual([]);
    for (const c of Object.values(asset(after).clips)) expect([...c.tracks, ...c.motions].some((t) => t.bone === "head")).toBe(false);
    expect(applyOperation(before, "removeBone", { assetId: "beetle", bone: "root" }).ok).toBe(false);
    expect(applyOperation(before, "removeBone", { assetId: "beetle", bone: "nope" }).ok).toBe(false);
  });

  it("removeBone turns a bend toward the removed bone into a bend toward its parent (or none)", () => {
    const rig = exampleRig();
    rig.parts.find((x) => x.id === "shell")!.bendTo = "head";
    rig.parts.find((x) => x.id === "head")!.bendTo = "horn";
    const after = ok(applyOperation(beetle(rig), "removeBone", { assetId: "beetle", bone: "head" }));
    expect(part(after, "shell").bendTo).toBeUndefined(); // body -> body is no bend
    expect(part(after, "head")).toMatchObject({ bone: "body", bendTo: "horn" });
  });

  it("setGrip adds or replaces a grip on a known bone; removeGrip removes one", () => {
    const before = beetle();
    let p = ok(applyOperation(before, "setGrip", { assetId: "beetle", grip: { id: "hand", bone: "leg_front", at: [14, -2], angle: 45 } }));
    expect(rigOf(p).grips).toEqual([{ id: "hand", bone: "leg_front", at: [14, -2], angle: 45 }]);
    p = ok(applyOperation(p, "setGrip", { assetId: "beetle", grip: { id: "back", bone: "body", at: [-10, -20] } }));
    expect(rigOf(p).grips!.map((g) => g.id)).toEqual(["hand", "back"]);
    expect(applyOperation(p, "setGrip", { assetId: "beetle", grip: { id: "x", bone: "nope", at: [0, 0] } }).ok).toBe(false);
    p = ok(applyOperation(p, "removeGrip", { assetId: "beetle", gripId: "hand" }));
    p = ok(applyOperation(p, "removeGrip", { assetId: "beetle", gripId: "back" }));
    expect(rigOf(p).grips).toBeUndefined();
    expect(applyOperation(p, "removeGrip", { assetId: "beetle", gripId: "back" }).ok).toBe(false);
  });

  it("refuses to carry, rotate or scale cutout image parts, but moves their pivots", () => {
    const rig: Rig = {
      mode: "cutout",
      source: { file: "0123456789abcdef.png", scale: 1, anchor: [50, 100] },
      bones: [
        { id: "root", parent: null, pivot: [0, 0] },
        { id: "arm", parent: "root", pivot: [5, -30] },
      ],
      parts: [
        { id: "body", bone: "root", z: 0, shape: { type: "image", points: [[-10, 0], [-10, -40], [10, -40], [10, 0]] }, fill: "#888888", ink: 1, glow: false, opacity: 1 },
        { id: "arm", bone: "arm", z: 1, shape: { type: "image", points: [[5, -32], [20, -32], [20, -28], [5, -28]] }, fill: "#888888", ink: 1, glow: false, opacity: 1 },
      ],
    };
    const p = beetle(rig);
    expect(applyOperation(p, "moveBonePivot", { assetId: "beetle", bone: "arm", pivot: [6, -31] }).ok).toBe(false);
    expect(applyOperation(p, "rotateBoneRest", { assetId: "beetle", bone: "arm", degrees: 10 }).ok).toBe(false);
    expect(applyOperation(p, "scaleBone", { assetId: "beetle", bone: "arm", factor: 1.2 }).ok).toBe(false);
    expect(bone(ok(applyOperation(p, "moveBonePivot", { assetId: "beetle", bone: "arm", pivot: [6, -31], carry: false })), "arm").pivot).toEqual([6, -31]);
  });

  it("moves textures with their parts and refuses edits that leave rig space", () => {
    const rig = exampleRig();
    rig.parts.find((x) => x.id === "shell")!.texture = { file: "0123456789abcdef.png", rect: [-22, -34, 36, 26], uv: [0, 0, 36, 26], opacity: 1 };
    const p = beetle(rig);
    const moved = ok(applyOperation(p, "moveBonePivot", { assetId: "beetle", bone: "body", pivot: [10, -14] }));
    expect(part(moved, "shell").texture!.rect).toEqual([-12, -34, 36, 26]);
    const scaled = ok(applyOperation(p, "scaleBone", { assetId: "beetle", bone: "body", factor: 2 }));
    expect(part(scaled, "shell").texture!.rect.slice(2)).toEqual([72, 52]);
    expect(applyOperation(p, "moveBonePivot", { assetId: "beetle", bone: "root", pivot: [990, 0] }).ok).toBe(false);
    expect(applyOperation(p, "moveBonePivot", { assetId: "nope", bone: "root", pivot: [0, 0] }).ok).toBe(false);
  });

  it("each edit is one undo step; a batch of them is one too", () => {
    const before = beetle();
    const history: HistoryEntry[] = [];
    const after = ok(applyOperation(before, "rotateBoneRest", { assetId: "beetle", bone: "head", degrees: 30 }));
    history.push({ revision: after.revision, at: "now", author: "user", change: { kind: "operation", name: "rotateBoneRest", input: {} }, before });
    const undone = undoLast(after, history);
    if (!undone.ok) throw new Error("undo failed");
    expect(asset(undone.project)).toEqual(asset(before));
    const batch = ok(applyBatch(before, [
      { name: "addBone", input: { assetId: "beetle", bone: { id: "jaw", parent: "head", pivot: [20, -12] } } },
      { name: "reassignPart", input: { assetId: "beetle", part: "eye", bone: "jaw" } },
    ]));
    expect(batch.revision).toBe(before.revision + 1);
    expect(part(batch, "eye").bone).toBe("jaw");
  });
});

describe("swapBones: two limbs labelled the wrong way round", () => {
  const blob = (id: string, bone: string, z: number, x: number): Part => ({
    id,
    bone,
    z,
    shape: { type: "blob", points: [[x, -40], [x + 6, -40], [x + 6, -20], [x, -20]], smooth: 0, sharp: [] },
    fill: "#888888",
    ink: 1,
    glow: false,
    opacity: 1,
  });
  // The arm drawn in front (x 10) was planned as the far one, the one behind (x -10) as the near one.
  const mislabelled: Rig = {
    bones: [
      { id: "root", parent: null, pivot: [0, 0] },
      { id: "torso", parent: "root", pivot: [0, -30] },
      { id: "near_upper", parent: "torso", pivot: [-10, -40] },
      { id: "near_lower", parent: "near_upper", pivot: [-10, -30] },
      { id: "far_upper", parent: "torso", pivot: [10, -40] },
      { id: "far_lower", parent: "far_upper", pivot: [10, -30] },
    ],
    parts: [
      blob("torso", "torso", 4, -5),
      blob("near_upper", "near_upper", 7, -10),
      blob("near_lower", "near_lower", 8, -10),
      blob("far_upper", "far_upper", 1, 10),
      { ...blob("far_lower", "far_lower", 2, 10), bendTo: "far_upper" },
    ],
  };
  const swing = { duration: 1, loop: true, tracks: [{ bone: "near_upper", property: "rotate", keys: [[0, 0], [0.5, 30], [1, 0]] }] };

  it("trades the chains' names and draw order; nothing moves; the clips stay current and drive the limb now named for them", () => {
    let p = ok(applyOperation(createDefaultProject(), "createAsset", { asset: { id: "hero", name: "Hero", kind: "character", brief: "a hero" }, assignTo: "player" }));
    p = ok(applyOperation(p, "setRig", { assetId: "hero", rig: mislabelled }));
    p = ok(applyOperation(p, "setClip", { assetId: "hero", clipId: "walk", clip: swing }));
    const heroOf = (q: ProjectSpec) => q.art.assets.find((a) => a.id === "hero") as CharacterAsset;
    const after = ok(applyOperation(p, "swapBones", { assetId: "hero", a: "near_upper", b: "far_upper" }));
    const rig = heroOf(after).rig!;
    const pivot = (id: string) => rig.bones.find((b) => b.id === id)!.pivot;
    expect(pivot("near_upper")).toEqual([10, -40]);
    expect(pivot("near_lower")).toEqual([10, -30]);
    expect(pivot("far_upper")).toEqual([-10, -40]);
    expect(rig.bones.find((b) => b.id === "near_lower")!.parent).toBe("near_upper");
    const at = (id: string) => rig.parts.find((x) => x.id === id)!;
    // Each part keeps its drawing; the one in front is now the near one, drawn in front.
    expect(at("near_upper").shape).toEqual(mislabelled.parts[3]!.shape);
    expect([at("near_upper").bone, at("near_upper").z]).toEqual(["near_upper", 7]);
    expect([at("near_lower").bone, at("near_lower").z, at("near_lower").bendTo]).toEqual(["near_lower", 8, "near_upper"]);
    expect([at("far_upper").bone, at("far_upper").z]).toEqual(["far_upper", 1]);
    expect(at("far_upper").shape).toEqual(mislabelled.parts[1]!.shape);
    expect(at("torso")).toEqual(mislabelled.parts[0]);
    expect(heroOf(after).clipsFor).toBe(rigFingerprint(rig));
    expect(heroOf(after).clips.walk!.tracks[0]!.bone).toBe("near_upper");
    // Swapping back restores the rig exactly.
    const back = ok(applyOperation(after, "swapBones", { assetId: "hero", a: "near_upper", b: "far_upper" }));
    expect(heroOf(back).rig).toEqual(heroOf(p).rig);
  });

  it("refuses the same bone or two bones on one chain", () => {
    let p = ok(applyOperation(createDefaultProject(), "createAsset", { asset: { id: "hero", name: "Hero", kind: "character", brief: "a hero" }, assignTo: "player" }));
    p = ok(applyOperation(p, "setRig", { assetId: "hero", rig: mislabelled }));
    expect(applyOperation(p, "swapBones", { assetId: "hero", a: "near_upper", b: "near_upper" })).toMatchObject({ ok: false });
    const chain = applyOperation(p, "swapBones", { assetId: "hero", a: "near_upper", b: "near_lower" });
    expect(chain.ok ? "" : chain.error.message).toMatch(/same chain/);
  });
});
