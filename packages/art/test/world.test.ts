import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, worldSceneFor, type BiomeAsset, type FileRef, type OperationCall, type ProjectSpec } from "@anomaly/core";
import {
  FakeImageModel,
  FakeRenderer,
  FakeVisionModel,
  worldComposeStage,
  worldKitStage,
  worldPrompts,
  worldRepaintStage,
  type ArtContext,
} from "../src/index.ts";

function harness() {
  let project: ProjectSpec = createDefaultProject();
  const files = new Map<string, Buffer>();
  const image = new FakeImageModel();
  const vision = new FakeVisionModel();
  let spent = 0;
  const ctx: ArtContext = {
    project: () => project,
    image,
    vision,
    renderer: new FakeRenderer(),
    files: {
      async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
        const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
        files.set(ref, data);
        return ref;
      },
      async get(ref: FileRef) {
        const data = files.get(ref);
        if (!data) throw new Error(`no file ${ref}`);
        return data;
      },
    },
    log: () => {},
    remaining: () => 1,
    spend: (u) => (spent += u.cost),
  };
  const commit = (operations: OperationCall[]) => {
    const result = applyBatch(project, operations);
    if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
    project = result.project;
  };
  const biome = () => project.art.assets.find((a) => a.kind === "biome") as BiomeAsset;
  return { ctx, commit, files, image, vision, biome, project: () => project, spent: () => spent };
}

describe("world stages", () => {
  it("paints a kit for a new biome: four images, two transparent sheets, labelled pieces", async () => {
    const h = harness();
    const kit = await worldKitStage(h.ctx, { theme: "a fungal cathedral", quality: "draft" });
    expect(kit.operations.map((o) => o.name)).toEqual(["createAsset", "setBiomeKit"]);
    h.commit(kit.operations);
    expect(h.image.requests).toHaveLength(4);
    expect(h.image.requests.filter((r) => r.transparent)).toHaveLength(2);
    expect(h.image.requests.every((r) => r.quality === "low")).toBe(true);
    const biome = h.biome();
    expect(biome).toMatchObject({ id: "a_fungal_cathedral", brief: "a fungal cathedral" });
    expect(biome.kit?.pieces.map((p) => p.id)).toEqual(["s0_tall_pillar", "s1_root_curtain", "p0_lantern", "p1_mushrooms"]);
    for (const ref of [biome.kit!.backdrop, biome.kit!.ground, ...biome.kit!.pieces.map((p) => p.file)]) expect(h.files.has(ref)).toBe(true);
  });

  it("final quality spends more on the backdrop and piece sheets only", async () => {
    const h = harness();
    await worldKitStage(h.ctx, { theme: "t", quality: "final" });
    expect(h.image.requests.map((r) => r.quality).sort()).toEqual(["low", "medium", "medium", "medium"]);
  });

  it("composes a room around the arena's platforms, or suggests a layout", async () => {
    const h = harness();
    h.commit((await worldKitStage(h.ctx, { theme: "t" })).operations);
    const room = await worldComposeStage(h.ctx, { biomeId: h.biome().id, dressArena: true });
    expect(h.vision.requests.at(-1)!.content.some((c) => c.type === "text" && c.text.includes("FIXED"))).toBe(true);
    h.commit(room.operations);
    expect(h.project().sandbox.dressing).toEqual({ biome: h.biome().id, room: room.roomId });
    const added = h.biome().rooms[0]!;
    expect(added.layout).toBeNull();
    expect(added.composition.placements.every((p) => p.id?.startsWith("pl_"))).toBe(true);

    const suggested = await worldComposeStage(h.ctx, { biomeId: h.biome().id, newLayout: true, name: "Second hall" });
    h.commit(suggested.operations);
    expect(h.biome().rooms[1]).toMatchObject({ id: "second_hall", name: "Second hall" });
    expect(h.biome().rooms[1]!.layout).toHaveLength(2);
    expect(h.project().sandbox.platforms).not.toEqual(h.biome().rooms[1]!.layout); // only a suggestion

    const scene = worldSceneFor(h.project(), h.biome().id, "second_hall", true);
    expect(scene?.platforms).toEqual(h.biome().rooms[1]!.layout);
    expect(worldSceneFor(h.project(), h.biome().id, "second_hall")?.platforms).toEqual(h.project().sandbox.platforms);
  });

  it("repaints one sheet and keeps piece ids, so rooms still work", async () => {
    const h = harness();
    h.commit((await worldKitStage(h.ctx, { theme: "t" })).operations);
    h.commit((await worldComposeStage(h.ctx, { biomeId: h.biome().id })).operations);
    const before = h.biome().kit!;
    h.commit((await worldRepaintStage(h.ctx, { biomeId: h.biome().id, part: "props", feedback: "more lanterns" })).operations);
    expect(h.image.requests.at(-1)!.prompt).toContain("more lanterns");
    expect(h.biome().kit!.pieces.map((p) => p.id)).toEqual(before.pieces.map((p) => p.id));
    expect(h.biome().kit!.backdrop).toBe(before.backdrop);
  });

  it("keeps the kit prompts free of characters and baked-in light sources in the ground", () => {
    const prompts = worldPrompts("a sunken garden", createDefaultProject().art.direction);
    expect(prompts.ground).toMatch(/no objects, no lanterns/);
    expect(prompts.structures).toMatch(/transparent background/);
    for (const p of Object.values(prompts)) expect(p).toMatch(/No characters/);
  });
});
