import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, type FileRef, type OperationCall, type ProjectSpec } from "@anomaly/core";
import {
  animate,
  buildRig,
  BudgetExceeded,
  chooseConcept,
  FakeImageModel,
  FakeRenderer,
  FakeVisionModel,
  generateConcepts,
  slotsFor,
  solidPng,
  type ArtActivity,
  type ArtContext,
} from "../src/index.ts";

class MemoryFiles {
  readonly files = new Map<string, Buffer>();
  async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
    const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
    this.files.set(ref, data);
    return ref;
  }
  async get(ref: FileRef): Promise<Buffer> {
    const data = this.files.get(ref);
    if (!data) throw new Error(`no file ${ref}`);
    return data;
  }
}

function harness(budget = 1) {
  let project: ProjectSpec = createDefaultProject();
  let spent = 0;
  const log: ArtActivity[] = [];
  const vision = new FakeVisionModel();
  const image = new FakeImageModel();
  const renderer = new FakeRenderer();
  const ctx: ArtContext = {
    project: () => project,
    image,
    vision,
    renderer,
    files: new MemoryFiles(),
    log: (a) => log.push(a),
    remaining: () => budget - spent,
    spend: (u) => {
      spent += u.cost;
      if (spent > budget) throw new BudgetExceeded(`over budget ($${spent.toFixed(3)})`);
    },
  };
  const commit = (operations: OperationCall[]) => {
    const result = applyBatch(project, operations);
    if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
    project = result.project;
  };
  return { ctx, commit, log, vision, image, renderer, project: () => project, spent: () => spent };
}

describe("art pipeline stages", () => {
  it("runs concepts -> choose -> rig -> animate, each as committable operations", async () => {
    const h = harness();
    const concepts = await generateConcepts(h.ctx, { characterId: "charger", brief: "a horned beetle" });
    expect(concepts.operations.map((o) => o.name)).toEqual(["createAsset", "addConcept"]);
    h.commit(concepts.operations);
    const asset = () => h.project().art.assets[0]!;
    expect(h.project().characters.find((c) => c.id === "charger")?.appearance).toBe("charger_look");
    expect(asset().concepts[0]?.recommended?.cell).toBe(1);
    expect(h.image.requests[0]?.prompt).toContain("a horned beetle");

    h.commit((await chooseConcept(h.ctx, { characterId: "charger" })).operations);
    expect(asset().chosen).toMatchObject({ sheet: 0, cell: 1 });
    expect(h.renderer.crops.map((c) => c.x)).toEqual([0.51]); // the recommended (top-right) cell
    expect(h.log.some((a) => a.text === "mirrored the design to face right")).toBe(true);

    const rig = await buildRig(h.ctx, { characterId: "charger" });
    h.commit(rig.operations);
    const built = asset();
    expect(built.kind === "character" && built.rig?.parts.length).toBe(9);
    expect(built.kind === "character" && built.preview?.score).toBe(8);

    const anim = await animate(h.ctx, { characterId: "charger" });
    h.commit(anim.operations);
    const animated = asset();
    expect(animated.kind === "character" && Object.keys(animated.clips).sort()).toEqual(["attack", "death", "idle", "walk", "windup"]);
    expect(animated.kind === "character" && Object.keys(animated.clipPreviews).length).toBe(5);
    expect(h.spent()).toBeGreaterThan(0);
    expect(h.log.some((a) => a.file)).toBe(true);
  });

  it("needs the earlier stages first, with a clear message", async () => {
    const h = harness();
    await expect(buildRig(h.ctx, { characterId: "charger" })).rejects.toThrow(/no art yet/);
    h.commit((await generateConcepts(h.ctx, { characterId: "charger" })).operations);
    await expect(buildRig(h.ctx, { characterId: "charger" })).rejects.toThrow(/choose a concept/);
    await expect(animate(h.ctx, { characterId: "charger" })).rejects.toThrow(/rig first/);
  });

  it("asks the model to repair an invalid reply once", async () => {
    const h = harness();
    h.commit((await generateConcepts(h.ctx, { characterId: "charger" })).operations);
    h.commit((await chooseConcept(h.ctx, { characterId: "charger", cell: 0 })).operations);
    h.vision.replies.push('{"rig": {"bones": [], "parts": []}}');
    const result = await buildRig(h.ctx, { characterId: "charger" });
    expect(result.operations[0]?.name).toBe("setRig");
    expect(h.log.some((a) => a.text.includes("asking for a fix"))).toBe(true);
  });

  it("refines with the chosen design as a reference image", async () => {
    const h = harness();
    h.commit((await generateConcepts(h.ctx, { characterId: "charger" })).operations);
    h.commit((await chooseConcept(h.ctx, { characterId: "charger", cell: 2 })).operations);
    h.commit((await generateConcepts(h.ctx, { characterId: "charger", feedback: "longer horn", refine: true })).operations);
    expect(h.image.requests[1]?.references).toHaveLength(1);
    expect(h.image.requests[1]?.prompt).toContain("longer horn");
    expect(h.project().art.assets[0]?.concepts).toHaveLength(2);
  });

  it("stops when the budget runs out", async () => {
    const h = harness(0.0015);
    await expect(generateConcepts(h.ctx, { characterId: "charger" })).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it("knows which clips each character needs", () => {
    const project = createDefaultProject();
    project.art.assets.push({
      id: "look",
      name: "Look",
      kind: "character",
      brief: "",
      concepts: [],
      chosen: null,
      rig: null,
      preview: null,
      clips: {},
      clipPreviews: {},
      stateClips: {},
    });
    project.characters = project.characters.map((c) => (c.id === "player" || c.id === "charger" ? { ...c, appearance: "look" } : c));
    expect(slotsFor(project, "look").sort()).toEqual(["attack", "death", "fall", "hurt", "idle", "jump", "run", "walk", "windup"]);
    project.characters = project.characters.map((c) => (c.id === "charger" ? { ...c, movement: "flying" } : c.id === "player" ? { ...c, appearance: undefined } : c));
    expect(slotsFor(project, "look").sort()).toEqual(["attack", "death", "fly", "hurt", "idle", "windup"]);
  });
});
