import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, gridPlatforms, worldSceneFor, type BiomeAsset, type FileRef, type OperationCall, type ProjectSpec } from "@anomaly/core";
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
    expect(biome.kit?.pieces.map((p) => p.id)).toEqual(["s0_tall_pillar", "s1_root_curtain", "s2_fallen_beam", "p0_lantern", "p1_mushrooms"]);
    expect(biome.kit?.pieces.find((p) => p.id === "s2_fallen_beam")?.kind).toBe("span");
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
    const room = await worldComposeStage(h.ctx, { biomeId: h.biome().id, dressRoom: "arena" });
    const asked = (c: { type: string; text?: string }, words: string) => c.type === "text" && Boolean(c.text?.includes(words));
    const compose = h.vision.requests.find((r) => r.content.some((c) => asked(c, "Compose one room")))!;
    expect(compose.content.some((c) => asked(c, "FIXED"))).toBe(true);
    h.commit(room.operations);
    expect(h.project().world.rooms[0]!.dressing).toEqual({ biome: h.biome().id, room: room.roomId });
    const added = h.biome().rooms[0]!;
    expect(added.layout).toBeNull();
    expect(added.composition.placements.every((p) => p.id?.startsWith("pl_"))).toBe(true);

    const arenaGrid = h.project().world.rooms[0]!.grid;
    const suggested = await worldComposeStage(h.ctx, { biomeId: h.biome().id, newLayout: true, name: "Second hall" });
    h.commit(suggested.operations);
    expect(h.biome().rooms[1]).toMatchObject({ id: "second_hall", name: "Second hall" });
    expect(h.biome().rooms[1]!.layout).toHaveLength(2);
    expect(h.project().world.rooms[0]!.grid).toEqual(arenaGrid); // only a suggestion

    const scene = worldSceneFor(h.project(), h.biome().id, "second_hall", true);
    expect(scene?.terrain?.grid).not.toEqual(arenaGrid); // the preview draws the suggested layout on the grid
    expect(worldSceneFor(h.project(), h.biome().id, "second_hall")?.platforms).toEqual(gridPlatforms(arenaGrid)); // breakable ones keep their own look
  });

  it("looks at the composed room and applies the reviewer's fixes, snapped onto surfaces", async () => {
    const h = harness();
    h.commit((await worldKitStage(h.ctx, { theme: "t" })).operations);
    const room = await worldComposeStage(h.ctx, { biomeId: h.biome().id });
    expect(room.summary).toContain("reviewed 6/10, 1 fix");
    const renderer = h.ctx.renderer as FakeRenderer;
    // One labelled render for the review, one clean render of the result.
    expect(renderer.worldRenders.map((r) => r.labels)).toEqual([true, false]);
    const review = h.vision.requests.at(-1)!;
    expect(review.content[0]!.type).toBe("image");
    expect(review.content.some((c) => c.type === "text" && c.text.includes("pl_3: Lantern (light), play"))).toBe(true);
    h.commit(room.operations);
    const placements = h.biome().rooms[0]!.composition.placements;
    const lantern = placements.find((p) => p.id === "pl_3")!;
    expect(lantern.x).toBe(650); // the reviewer's move
    const floor = gridPlatforms(h.project().world.rooms[0]!.grid).filter((p) => p.x <= 650 && 650 <= p.x + p.width).map((p) => p.y);
    expect(floor).toContain(lantern.y); // resting on a surface there
    expect(placements.find((p) => p.layer === "front")!.y).toBeLessThanOrEqual(0); // the hanging curtain starts at the top
  });

  it("keeps a room as composed when the review is skipped or scores it well", async () => {
    const h = harness();
    h.commit((await worldKitStage(h.ctx, { theme: "t" })).operations);
    const skipped = await worldComposeStage({ ...h.ctx, roomRounds: 0 }, { biomeId: h.biome().id });
    expect(skipped.summary).not.toContain("reviewed");
    const good = new FakeVisionModel();
    const ctx = { ...h.ctx, vision: good };
    const realComplete = good.complete.bind(good);
    good.complete = async (request) => {
      const text = request.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (text.includes("finished game room")) return { text: JSON.stringify({ score: 9, issues: [], fixes: [{ id: "pl_1", remove: true }] }), usage: { cost: 0.001, promptTokens: 1, completionTokens: 1 }, model: good.id };
      return realComplete(request);
    };
    const kept = await worldComposeStage(ctx, { biomeId: h.biome().id });
    expect(kept.summary).toContain("reviewed 9/10)");
    h.commit(kept.operations);
    expect(h.biome().rooms.at(-1)!.composition.placements.some((p) => p.id === "pl_1")).toBe(true);
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

  it("recomposes an existing room in place", async () => {
    const h = harness();
    h.commit((await worldKitStage(h.ctx, { theme: "t" })).operations);
    h.commit((await worldComposeStage(h.ctx, { biomeId: h.biome().id, newLayout: true })).operations);
    const room = h.biome().rooms[0]!;
    const again = await worldComposeStage(h.ctx, { biomeId: h.biome().id, roomId: room.id });
    expect(again.operations[0]!.name).toBe("setRoomComposition");
    h.commit(again.operations);
    expect(h.biome().rooms).toHaveLength(1);
    expect(h.biome().rooms[0]).toMatchObject({ id: room.id, name: room.name, layout: room.layout });
  });

  it("keeps the kit prompts free of characters and baked-in light sources in the ground", () => {
    const prompts = worldPrompts("a sunken garden", createDefaultProject().art.direction);
    expect(prompts.ground).toMatch(/no objects, no lanterns/);
    expect(prompts.structures).toMatch(/transparent background/);
    for (const p of Object.values(prompts)) expect(p).toMatch(/No characters/);
  });
});
