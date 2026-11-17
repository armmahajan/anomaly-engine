import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, exampleRig, Rig, rigBounds, type FileRef, type OperationCall, type ProjectSpec } from "@anomaly/core";
import {
  buildRig,
  creaturePlan,
  cutCharacter,
  cutoutRig,
  decodePng,
  drawCreature,
  encodePng,
  FakeRenderer,
  FakeVisionModel,
  FakeImageModel,
  matchScore,
  type ArtActivity,
  type ArtContext,
  type Pixels,
  type VisionRequest,
} from "../src/index.ts";

// Cutout rigs (cutout.ts), the match score (match.ts) and both rig modes through the rig stage.

const SIZE = 256;
const BG = "#d8d6cf";
const SOURCE = "0123456789abcdef0123456789abcdef.png";

function solid(width: number, height: number, rect: { x: number; y: number; w: number; h: number } | null, rgb = [200, 60, 60]): Pixels {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      data.set(on ? [...rgb, 255] : [216, 214, 207, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe("matchScore", () => {
  it("is 1 for identical images, 0 for disjoint ones, in between when shifted", () => {
    const a = solid(64, 64, { x: 10, y: 10, w: 20, h: 20 });
    expect(matchScore(encodePng(a), encodePng(a), BG)).toEqual({ silhouette: 1, color: 1 });
    expect(matchScore(a, solid(64, 64, { x: 40, y: 40, w: 20, h: 20 }), BG)).toEqual({ silhouette: 0, color: 0 });
    const shifted = matchScore(a, solid(64, 64, { x: 15, y: 10, w: 20, h: 20 }), BG);
    expect(shifted.silhouette).toBeCloseTo(300 / 500, 2);
    expect(shifted.color).toBe(1);
    const recolored = matchScore(a, solid(64, 64, { x: 10, y: 10, w: 20, h: 20 }, [60, 60, 200]), BG);
    expect(recolored.silhouette).toBe(1);
    expect(recolored.color).toBeLessThan(0.5);
  });

  it("decodes what it encodes", () => {
    const image = drawCreature(40, 30);
    expect(decodePng(encodePng(image))).toEqual(image);
  });
});

describe("cutout", () => {
  const concept = drawCreature(SIZE, SIZE);

  it("cuts the character out of its background", () => {
    const cut = cutCharacter(concept)!;
    expect(cut).not.toBeNull();
    expect(cut.background).toEqual([218, 216, 208]);
    // Feet at the legs' bottom (0.84), head top at 0.3; the cutout holds just the character.
    expect(cut.bounds.maxY).toBeCloseTo(0.84 * SIZE, -1);
    expect(cut.bounds.minY).toBeCloseTo(0.3 * SIZE, -1);
    const alpha = (x: number, y: number) => cut.image.data[((y - cut.offset[1]) * cut.image.width + (x - cut.offset[0])) * 4 + 3]!;
    expect(alpha(Math.round(0.47 * SIZE), Math.round(0.55 * SIZE))).toBe(255); // body
    expect(alpha(cut.offset[0], cut.offset[1])).toBe(0); // the corner is background
    expect(cutCharacter(solid(32, 32, null))).toBeNull();
  });

  it("assigns every opaque pixel to a part and traces each part's polygon around its pixels", () => {
    const cut = cutCharacter(concept)!;
    const plan = creaturePlan(SIZE, SIZE);
    const { rig, warnings, labels } = cutoutRig(cut, plan, SOURCE);
    expect(warnings).toEqual([]);
    expect(Rig.safeParse(rig).success).toBe(true);
    expect(rig.mode).toBe("cutout");
    expect(rig.source).toEqual({ file: SOURCE, scale: 1, anchor: [-cut.offset[0], -cut.offset[1]] });
    expect(rig.parts.map((p) => p.id).sort()).toEqual(["body", "head", "leg_far", "leg_near"]);
    const polygon = (id: string) => rig.parts.find((p) => p.id === id)!.shape as { type: "image"; points: [number, number][] };
    for (const part of rig.parts) {
      expect(part.shape.type).toBe("image");
      expect(polygon(part.id).points.length).toBeLessThanOrEqual(128);
    }
    // Every opaque pixel lies inside its own part's polygon.
    const { width: W, height: H, data } = cut.image;
    let missed = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3]! < 16) continue;
        const part = plan.parts[labels[y * W + x]!]!;
        if (!pointInPolygon(x + 0.5 + cut.offset[0], y + 0.5 + cut.offset[1], polygon(part.id).points)) missed++;
      }
    }
    expect(missed).toBe(0);
    // Pixels go by region: the eye is on the head, the head's pale pixels are not on the body.
    expect(plan.parts[labels[(Math.round(0.38 * SIZE) - cut.offset[1]) * W + Math.round(0.74 * SIZE) - cut.offset[0]]!]!.id).toBe("head");
    // Each leg reaches a few px past its hip into the body (the joint disk), so turning it opens no gap.
    const hip = plan.bones.find((b) => b.id === "leg_near")!.pivot;
    for (const [dx, dy] of [[-6, -4], [6, -4], [0, -6]] as const) expect(pointInPolygon(hip[0] + dx, hip[1] + dy, polygon("leg_near").points)).toBe(true);
  });
});

// --- the rig stage, both modes -------------------------------------------------------

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

/** Answers the cutout prompts with the creature's plan; everything else as the shared fake. */
class CutoutVision extends FakeVisionModel {
  critiques: { score: number; plan?: unknown }[] = [];
  override async complete(request: VisionRequest) {
    const prompt = request.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const usage = { cost: 0.001, promptTokens: 10, completionTokens: 10 };
    if (prompt.includes("Plan the cutout rig")) return { text: JSON.stringify(creaturePlan(SIZE, SIZE)), usage, model: this.id };
    if (prompt.includes("Review the cutout rig")) {
      this.requests.push(request);
      return { text: JSON.stringify({ issues: [], ...(this.critiques.shift() ?? { score: 9, plan: null }) }), usage, model: this.id };
    }
    return super.complete(request);
  }
}

async function harness(options: { renderer?: FakeRenderer; vision?: FakeVisionModel; rigRounds?: number } = {}) {
  let project: ProjectSpec = createDefaultProject();
  const files = new MemoryFiles();
  const log: ArtActivity[] = [];
  const ctx: ArtContext = {
    project: () => project,
    image: new FakeImageModel(),
    vision: options.vision ?? new CutoutVision(),
    renderer: options.renderer ?? new FakeRenderer(),
    files,
    log: (a) => log.push(a),
    remaining: () => 1,
    spend: () => {},
    rigRounds: options.rigRounds,
  };
  const commit = (operations: OperationCall[]) => {
    const result = applyBatch(project, operations);
    if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
    project = result.project;
  };
  const file = await files.put(encodePng(drawCreature(SIZE, SIZE)), "png");
  commit([
    { name: "createAsset", input: { asset: { id: "look", name: "Look", kind: "character", brief: "a stout beast" }, assignTo: "charger" } },
    { name: "addConcept", input: { assetId: "look", concept: { file, prompt: "p", model: "m", cost: 0, at: "2026-01-01T00:00:00Z" } } },
    { name: "chooseConcept", input: { assetId: "look", sheet: 0, cell: 0, file } },
  ]);
  const asset = () => {
    const a = project.art.assets.find((x) => x.id === "look");
    if (a?.kind !== "character") throw new Error("no asset");
    return a;
  };
  return { ctx, commit, files, log, asset, project: () => project };
}

describe("rig stage modes", () => {
  it("builds a vector and a cutout rig from the same concept", async () => {
    const h = await harness();
    h.commit((await buildRig(h.ctx, { characterId: "charger" })).operations);
    expect(h.asset().rig?.mode).toBeUndefined();
    expect(h.asset().rig?.parts.every((p) => p.shape.type !== "image")).toBe(true);

    h.commit((await buildRig(h.ctx, { characterId: "charger", rigMode: "cutout" })).operations);
    const rig = h.asset().rig!;
    expect(Rig.safeParse(rig).success).toBe(true);
    expect(rig.mode).toBe("cutout");
    expect(rig.parts.every((p) => p.shape.type === "image")).toBe(true);
    // The source is the character on transparency, scaled to the game size with the feet at the origin.
    const source = decodePng(await h.files.get(rig.source!.file));
    expect(source.data[3]).toBe(0);
    const charger = h.project().characters.find((c) => c.id === "charger")!;
    const b = rigBounds(rig);
    expect(b.maxY).toBeGreaterThan(0);
    expect(b.maxY).toBeLessThan(2); // only the overlap hangs below the feet
    expect(b.maxY - b.minY).toBeLessThan(charger.size.height * 1.4);
    const frame = h.asset().preview!.frame!;
    const feet = (0.84 * SIZE - frame.anchor[1]) * frame.scale;
    expect(feet).toBeCloseTo(0, 0);
    expect(h.asset().preview?.frame).toBeDefined();
  });

  it("takes the art direction's rig mode by default", async () => {
    const h = await harness();
    h.project().art.direction.rigMode = "cutout"; // (setArtDirection has no rigMode yet)
    h.commit((await buildRig(h.ctx, { characterId: "charger" })).operations);
    expect(h.asset().rig?.mode).toBe("cutout");
  });

  it("revises a cutout rig's plan with the critic, keeping the attempt that looks most like the design", async () => {
    const vision = new CutoutVision();
    const plan = creaturePlan(SIZE, SIZE);
    // The critic moves the near leg's pivot (round 2), then moves it back; the third render (scripted) lost the design.
    const moved = { ...plan, bones: plan.bones.map((b) => (b.id === "leg_near" ? { ...b, pivot: [b.pivot[0], b.pivot[1] - 6] } : b)) };
    vision.critiques = [{ score: 5, plan: moved }, { score: 6, plan }, { score: 9, plan: null }];
    const concept = drawCreature(SIZE, SIZE);
    const h = await harness({ vision, rigRounds: 3, renderer: new ScriptedRenderer([concept, concept, solid(SIZE, SIZE, null)]) });
    h.commit((await buildRig(h.ctx, { characterId: "charger", rigMode: "cutout" })).operations);
    expect(vision.requests.filter((r) => r.content.some((c) => c.type === "text" && c.text.includes("Review the cutout rig")))).toHaveLength(3);
    const leg = h.asset().rig!.bones.find((b) => b.id === "leg_near")!;
    expect(h.asset().preview?.score).toBe(6); // not the 9: that attempt no longer looked like the design
    expect(h.asset().preview?.match?.silhouette).toBeGreaterThan(0.95);
    const frame = h.asset().preview!.frame!;
    expect(leg.pivot[1]).toBeCloseTo((moved.bones.find((b) => b.id === "leg_near")!.pivot[1]! - frame.anchor[1]) * frame.scale, 0);
  });
});

/** Renders scripted pictures in turn (a rig-agnostic stand-in for the runtime). */
class ScriptedRenderer extends FakeRenderer {
  private readonly pictures: Pixels[];
  constructor(pictures: Pixels[]) {
    super();
    this.pictures = pictures;
  }
  override async renderRig(request: { cellWidth: number; cellHeight: number; columns: number; frames: unknown[]; fit?: boolean }) {
    if (request.fit === false) {
      const picture = this.pictures.shift();
      if (picture) return { png: encodePng(picture), warnings: [] };
    }
    return super.renderRig(request);
  }
}

describe("vector critique loop", () => {
  it("keeps the attempt with the best measured match, whatever the critic scored, and stores it", async () => {
    const concept = drawCreature(SIZE, SIZE);
    const blank = solid(SIZE, SIZE, null);
    const half = drawCreature(SIZE, SIZE, { cell: { x: 0.2, y: 0, w: 1, h: 1 } });
    // Round 1 draws the creature exactly, round 2 shifted, round 3 nothing; the critic likes them in reverse.
    const renderer = new ScriptedRenderer([concept, half, blank]);
    const vision = new FakeVisionModel();
    const rigs = [exampleRig(), { ...exampleRig(), parts: exampleRig().parts.slice(0, 5) }, { ...exampleRig(), parts: exampleRig().parts.slice(0, 3) }];
    vision.replies.push(
      JSON.stringify({ rig: rigs[0] }),
      JSON.stringify({ score: 3, issues: ["meh"], rig: rigs[1] }),
      JSON.stringify({ score: 6, issues: [], rig: rigs[2] }),
      JSON.stringify({ score: 7, issues: [], rig: rigs[2] }),
    );
    const h = await harness({ renderer, vision, rigRounds: 3 });
    h.commit((await buildRig(h.ctx, { characterId: "charger" })).operations);
    const preview = h.asset().preview!;
    expect(h.asset().rig?.parts.length).toBe(rigs[0]!.parts.length);
    expect(preview.score).toBe(3);
    expect(preview.match?.silhouette).toBeGreaterThan(0.95);
    expect(preview.match?.color).toBeGreaterThan(0.95);
    expect(h.log.some((a) => /render 2 \(match \d+% shape/.test(a.text))).toBe(true);
  });
});
