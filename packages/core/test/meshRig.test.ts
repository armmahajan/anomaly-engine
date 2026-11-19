import { describe, expect, it } from "vitest";
import { applyOperation, createDefaultProject, exampleRig, Rig, type CharacterAsset, type OperationResult, type Part, type ProjectSpec } from "../src/index.ts";

// Layered rigs (rig round 6): a part can be a painted layer on a triangle mesh, its texture px per
// vertex, optionally bending toward a second bone with a weight per vertex.

const texture = { file: `${"a".repeat(40)}.png`, rect: [-20, -40, 40, 40], uv: [0, 0, 64, 64] } as const;

/** A 2x2-quad mesh over the beetle's body: 4 outline points, one centre vertex, 4 triangles. */
function meshPart(extra: Partial<Part> = {}, shape: Record<string, unknown> = {}): unknown {
  return {
    id: "layer_body",
    bone: "body",
    z: 5,
    fill: "#888888",
    texture,
    shape: {
      type: "mesh",
      points: [[-20, -40], [20, -40], [20, 0], [-20, 0]],
      inner: [[0, -20]],
      triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
      uv: [[0, 0], [64, 0], [64, 64], [0, 64], [32, 32]],
      ...shape,
    },
    ...extra,
  };
}

function rigWith(part: unknown) {
  const base = exampleRig();
  return { ...base, mode: "layered", parts: [...base.parts, part] };
}
const issues = (rig: unknown) => {
  const r = Rig.safeParse(rig);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

describe("mesh parts", () => {
  it("a layered rig with a textured mesh part is valid", () => {
    expect(issues(rigWith(meshPart()))).toEqual([]);
    const second = exampleRig().bones.find((b) => b.parent !== null)!.id;
    expect(issues(rigWith(meshPart({ bendTo: second }, { weights: [0, 0, 1, 1, 0.5] })))).toEqual([]);
  });

  it("refuses a mesh without a texture, bad triangles, uv or weights of the wrong length, and weights without bendTo", () => {
    const { texture: _t, ...bare } = meshPart() as Record<string, unknown>;
    expect(issues(rigWith(bare)).join(" ")).toMatch(/needs a texture/);
    expect(issues(rigWith(meshPart({}, { triangles: [0, 1, 4, 1] }))).join(" ")).toMatch(/not a multiple of 3/);
    expect(issues(rigWith(meshPart({}, { triangles: [0, 1, 9] }))).join(" ")).toMatch(/index 9 is past the last vertex \(4\)/);
    expect(issues(rigWith(meshPart({}, { uv: [[0, 0]] }))).join(" ")).toMatch(/1 uv points for 5 vertices/);
    expect(issues(rigWith(meshPart({}, { weights: [0, 1] }))).join(" ")).toMatch(/2 weights for 5 vertices/);
    expect(issues(rigWith(meshPart({}, { weights: [0, 0, 0, 0, 0] }))).join(" ")).toMatch(/weights need a bendTo bone/);
  });

  it("the bone editor moves a mesh with its bone and keeps its texture coordinates", () => {
    let p = ok(applyOperation(createDefaultProject(), "createAsset", { asset: { id: "beetle", name: "Beetle", kind: "character", brief: "a beetle" }, assignTo: "charger" }));
    p = ok(applyOperation(p, "setRig", { assetId: "beetle", rig: rigWith(meshPart()) }));
    p = ok(applyOperation(p, "moveBonePivot", { assetId: "beetle", bone: "body", pivot: [10, -10], carry: true }));
    const moved = (p.art.assets.find((a) => a.id === "beetle") as CharacterAsset).rig!.parts.find((x) => x.id === "layer_body")!;
    if (moved.shape.type !== "mesh") throw new Error("not a mesh");
    const before = (meshPart() as { shape: { points: number[][]; uv: number[][] } }).shape;
    expect(moved.shape.points).not.toEqual(before.points);
    expect(moved.shape.uv).toEqual(before.uv);
    expect(moved.shape.triangles).toEqual([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]);
  });
});
