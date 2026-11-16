import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultArtDirection, WorldScene, type FileRef } from "@anomaly/core";
import { composeRoom, FakeImageModel, FakeRenderer, FakeVisionModel, generateBiome, worldPrompts } from "../src/index.ts";

function harness() {
  const files = new Map<string, Buffer>();
  const image = new FakeImageModel();
  const vision = new FakeVisionModel();
  let spent = 0;
  const ctx = {
    image,
    vision,
    renderer: new FakeRenderer(),
    direction: defaultArtDirection(),
    files: {
      async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
        const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
        files.set(ref, data);
        return ref;
      },
    },
    log: () => {},
    spend: (u: { cost: number }) => (spent += u.cost),
  };
  return { ctx, files, image, vision, spent: () => spent };
}

describe("world generation (prototype)", () => {
  it("paints a four-image kit, labels the pieces and composes a valid room", async () => {
    const h = harness();
    const scene = await generateBiome(h.ctx, { name: "test", theme: "a fungal cathedral" });
    expect(WorldScene.safeParse(scene).success).toBe(true);
    expect(h.image.requests).toHaveLength(4);
    expect(h.image.requests.filter((r) => r.transparent)).toHaveLength(2); // the two piece sheets
    expect(scene.pieces.map((p) => p.id)).toEqual(["s0_tall_pillar", "s1_root_curtain", "p0_lantern", "p1_mushrooms"]);
    expect(scene.pieces.find((p) => p.kind === "light")?.glow).toBe("#ffcc80");
    expect(scene.placements.length).toBeGreaterThan(0);
    for (const ref of [scene.backdrop, scene.ground, ...scene.pieces.map((p) => p.file)]) expect(h.files.has(ref)).toBe(true);
    expect(h.spent()).toBeGreaterThan(0);
  });

  it("composes another room from the same kit with one call", async () => {
    const h = harness();
    const first = await generateBiome(h.ctx, { name: "a", theme: "t" });
    const calls = h.vision.requests.length;
    const second = await composeRoom(h.ctx, { name: "b", theme: "t", width: first.width, height: first.height }, {
      backdrop: first.backdrop,
      ground: first.ground,
      pieces: first.pieces,
      backdropImage: h.files.get(first.backdrop)!,
    });
    expect(h.vision.requests.length).toBe(calls + 1);
    expect(h.image.requests).toHaveLength(4); // no new images
    expect(second.backdrop).toBe(first.backdrop);
  });

  it("keeps the kit prompts free of characters and baked-in light sources in the ground", () => {
    const prompts = worldPrompts("a sunken garden", defaultArtDirection());
    expect(prompts.ground).toMatch(/no objects, no lanterns/);
    expect(prompts.structures).toMatch(/transparent background/);
    for (const p of Object.values(prompts)) expect(p).toMatch(/No characters/);
  });
});
