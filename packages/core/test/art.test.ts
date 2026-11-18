import { describe, expect, it } from "vitest";
import {
  applyBatch,
  applyOperation,
  Clip,
  createDefaultProject,
  exampleClips,
  exampleRig,
  lintProject,
  ProjectSpec,
  Rig,
  rigFiles,
  type OperationResult,
  type ProjectSpec as Project,
} from "../src/index.ts";

const FILE = "0123456789abcdef.png";

function ok(result: OperationResult): Project {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

/** Default project with a "beetle" asset assigned to the charger. */
function withAsset(): Project {
  return ok(
    applyOperation(createDefaultProject(), "createAsset", {
      asset: { id: "beetle", name: "Beetle", kind: "character", brief: "a horned beetle" },
      assignTo: "charger",
    }),
  );
}

const concept = { file: FILE, prompt: "p", model: "m", cost: 0.002, at: "2026-11-16T00:00:00Z" };

describe("art schema", () => {
  it("gives projects saved before art existed the default art section", () => {
    const { art: _art, ...old } = createDefaultProject();
    const parsed = ProjectSpec.parse(old);
    expect(parsed.art.assets).toEqual([]);
    expect(parsed.art.direction.style.length).toBeGreaterThan(20);
  });

  it("accepts the example rig and clips", () => {
    expect(Rig.safeParse(exampleRig()).success).toBe(true);
    for (const clip of Object.values(exampleClips())) expect(Clip.safeParse(clip).success).toBe(true);
  });

  it("rejects rigs with unknown bones, several roots or parent loops", () => {
    const rig = exampleRig();
    const unknownBone = { ...rig, parts: [{ ...rig.parts[0]!, bone: "tail" }] };
    expect(Rig.safeParse(unknownBone).error?.issues[0]?.message).toMatch(/unknown bone "tail"/);
    const twoRoots = { ...rig, bones: [...rig.bones, { id: "extra", parent: null, pivot: [0, 0] }] };
    expect(Rig.safeParse(twoRoots).error?.issues[0]?.message).toMatch(/exactly one root/);
    const loop = {
      ...rig,
      bones: [
        { id: "root", parent: null, pivot: [0, 0] },
        { id: "a", parent: "b", pivot: [0, 0] },
        { id: "b", parent: "a", pivot: [0, 0] },
      ],
      parts: [{ ...rig.parts[0]!, bone: "a" }],
    };
    expect(Rig.safeParse(loop).success).toBe(false);
  });

  it("takes optional part textures and clipped detail parts, and checks them", () => {
    const rig = exampleRig();
    const texture = { file: FILE, rect: [-20, -30, 40, 30], uv: [0, 0, 64, 48] };
    const band = { id: "band", bone: "body", z: 1, shape: { type: "ellipse", center: [0, -10], rx: 30, ry: 4 }, fill: "#ffffff", ink: 0, clipTo: "shell" };
    const textured = Rig.parse({ ...rig, parts: [...rig.parts.map((p) => (p.id === "shell" ? { ...p, texture } : p)), band] });
    expect(textured.parts.find((p) => p.id === "shell")?.texture).toEqual({ ...texture, opacity: 1 });
    expect(textured.parts.at(-1)?.clipTo).toBe("shell");
    expect(rigFiles(textured)).toEqual([FILE]);
    // Existing rigs are unchanged: no texture, no clip.
    expect(Rig.parse(rig).parts.every((p) => p.texture === undefined && p.clipTo === undefined)).toBe(true);

    const issue = (parts: unknown[]) => Rig.safeParse({ ...rig, parts }).error?.issues[0]?.message;
    expect(issue([...rig.parts, { ...band, clipTo: "nothing" }])).toMatch(/unknown part "nothing"/);
    expect(issue([...rig.parts, { ...band, clipTo: "head" }])).toMatch(/same bone/);
    expect(issue([...rig.parts, { ...band, clipTo: "band" }])).toMatch(/clip to itself/);
    expect(issue([...rig.parts, band, { ...band, id: "band2", clipTo: "band" }])).toMatch(/clipped itself/);
    expect(issue(rig.parts.map((p) => (p.id === "shell" ? { ...p, texture: { ...texture, rect: [0, 0, 0, 10] } } : p)))).toBeDefined();
    expect(issue(rig.parts.map((p) => (p.id === "shell" ? { ...p, texture: { ...texture, file: "nope.gif" } } : p)))).toBeDefined();
  });

  it("rejects an appearance that points at no asset", () => {
    const project = createDefaultProject();
    project.characters[1] = { ...project.characters[1]!, appearance: "ghost" };
    expect(ProjectSpec.safeParse(project).success).toBe(false);
  });
});

describe("art operations", () => {
  it("creates an asset and assigns it in one step", () => {
    const project = withAsset();
    expect(project.art.assets[0]).toMatchObject({ id: "beetle", kind: "character", concepts: [], chosen: null, rig: null });
    expect(project.characters.find((c) => c.id === "charger")?.appearance).toBe("beetle");
  });

  it("records concepts and the chosen design", () => {
    let project = ok(applyOperation(withAsset(), "addConcept", { assetId: "beetle", concept }));
    project = ok(applyOperation(project, "chooseConcept", { assetId: "beetle", sheet: 0, cell: 2, file: FILE }));
    expect(project.art.assets[0]?.chosen).toEqual({ sheet: 0, cell: 2, file: FILE });
    const missing = applyOperation(project, "chooseConcept", { assetId: "beetle", sheet: 3, cell: 0, file: FILE });
    expect(missing.ok).toBe(false);
  });

  it("sets a rig, edits one part, and reports bad parts with paths", () => {
    let project = ok(applyOperation(withAsset(), "setRig", { assetId: "beetle", rig: exampleRig() }));
    project = ok(applyOperation(project, "updatePart", { assetId: "beetle", partId: "shell", changes: { fill: "#aa3322" } }));
    const asset = project.art.assets[0]!;
    expect(asset.kind === "character" && asset.rig?.parts.find((p) => p.id === "shell")?.fill).toBe("#aa3322");

    const bad = applyOperation(project, "updatePart", { assetId: "beetle", partId: "shell", changes: { bone: "nope" } });
    expect(bad.ok).toBe(false);
    const unknown = applyOperation(project, "updatePart", { assetId: "beetle", partId: "wing", changes: {} });
    expect(!unknown.ok && unknown.error.message).toMatch(/known: .*shell/);
  });

  it("sets and deletes clips; deleting a clip drops state mappings to it", () => {
    let project = ok(applyOperation(withAsset(), "setRig", { assetId: "beetle", rig: exampleRig() }));
    project = ok(
      applyBatch(project, [
        { name: "setClip", input: { assetId: "beetle", clipId: "walk", clip: exampleClips().walk } },
        { name: "setClip", input: { assetId: "beetle", clipId: "stomp", clip: exampleClips().attack } },
        { name: "setStateClip", input: { assetId: "beetle", stateId: "charge", clipId: "stomp" } },
      ]),
    );
    expect(project.art.assets[0]).toMatchObject({ stateClips: { charge: "stomp" } });
    project = ok(applyOperation(project, "setClip", { assetId: "beetle", clipId: "stomp", clip: null }));
    expect(project.art.assets[0]).toMatchObject({ stateClips: {} });
  });

  it("deleting an asset turns its characters back into boxes", () => {
    const project = ok(applyOperation(withAsset(), "deleteAsset", { assetId: "beetle" }));
    expect(project.art.assets).toEqual([]);
    expect(project.characters.find((c) => c.id === "charger")?.appearance).toBeUndefined();
  });

  it("updates the art direction by merging and validating", () => {
    const project = ok(applyOperation(createDefaultProject(), "setArtDirection", { changes: { inkWidth: 4 } }));
    expect(project.art.direction.inkWidth).toBe(4);
    expect(applyOperation(project, "setArtDirection", { changes: { ink: "black" } }).ok).toBe(false);
  });
});

describe("art lint", () => {
  it("warns about clips animating missing bones, size mismatches and a missing idle", () => {
    let project = ok(applyOperation(withAsset(), "setRig", { assetId: "beetle", rig: exampleRig() }));
    const walk = { ...exampleClips().walk, motions: [{ type: "sway", bone: "tail", degrees: 10, cycles: 1, phase: 0 }] };
    project = ok(applyOperation(project, "setClip", { assetId: "beetle", clipId: "walk", clip: walk }));
    project = ok(applyOperation(project, "updateCharacter", { characterId: "charger", changes: { size: { width: 200 } } }));
    const codes = lintProject(project).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["clip_unknown_bone", "rig_size_mismatch", "clips_without_idle"]));
  });

  it("is quiet for the example rig on the charger", () => {
    let project = ok(applyOperation(withAsset(), "setRig", { assetId: "beetle", rig: exampleRig() }));
    for (const [clipId, clip] of Object.entries(exampleClips())) {
      project = ok(applyOperation(project, "setClip", { assetId: "beetle", clipId, clip }));
    }
    expect(lintProject(project).filter((w) => w.path.startsWith("art"))).toEqual([]);
  });
});
