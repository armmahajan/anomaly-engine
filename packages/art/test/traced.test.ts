import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyBatch, Clip, createDefaultProject, defaultArtDirection, Rig, type FileRef, type OperationCall, type ProjectSpec } from "@anomaly/core";
import {
  animate,
  buildRig,
  channels,
  creaturePlan,
  cutCharacter,
  drawCreature,
  drawnLineWidth,
  encodePng,
  FakeImageModel,
  FakeRenderer,
  FakeVisionModel,
  fitClip,
  fitBounds,
  frameMetrics,
  jointPivots,
  labelParts,
  maskStats,
  motionLimits,
  sheetMetrics,
  solidMask,
  toRigSpace,
  tracedRig,
  type ArtContext,
  type Pixels,
  type VisionRequest,
} from "../src/index.ts";

// Traced rigs (traced.ts), joint-aware pivots (cutout.ts), motion limits (motionLimits.ts) and the animation metric (animMetrics.ts).

const SIZE = 256;
const concept = drawCreature(SIZE, SIZE);
const plan = creaturePlan(SIZE, SIZE);
const direction = defaultArtDirection();

function pointInPolygon(x: number, y: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe("joint-aware pivots", () => {
  it("puts each bone's pivot in the middle of where its pieces meet its parent's", () => {
    const cut = cutCharacter(concept)!;
    // The model's pivots are off their joints.
    const off = { ...plan, bones: plan.bones.map((b) => (b.parent ? { ...b, pivot: [b.pivot[0] + 20, b.pivot[1] - 25] as [number, number] } : b)) };
    const bones = jointPivots(cut, off, labelParts(cut, off));
    const pivot = (id: string) => bones.find((b) => b.id === id)!.pivot;
    expect(pivot("root")).toEqual(off.bones[0]!.pivot); // the root keeps its pivot
    // The near leg (x 0.53-0.59 of the image) meets the body at its region's top, y 0.67.
    expect(pivot("leg_near")[0]).toBeGreaterThan(0.53 * SIZE);
    expect(pivot("leg_near")[0]).toBeLessThan(0.59 * SIZE);
    expect(pivot("leg_near")[1]).toBeCloseTo(0.67 * SIZE, -1);
    // The head (a circle at 0.7, 0.4, radius 0.1) meets the body on its lower left, near the circle's edge.
    const [hx, hy] = pivot("head");
    expect(Math.abs(Math.hypot(hx / SIZE - 0.7, hy / SIZE - 0.4) - 0.1)).toBeLessThan(0.05);
    expect(hx / SIZE).toBeLessThan(0.7);
    // A bone without parts keeps the model's pivot.
    const bare = { ...off, bones: [...off.bones, { id: "tail", parent: "body", pivot: [10, 10] as [number, number] }] };
    expect(jointPivots(cut, bare, labelParts(cut, bare)).find((b) => b.id === "tail")!.pivot).toEqual([10, 10]);
  });
});

describe("ground lines", () => {
  it("drops a thin line drawn under the feet, keeping the feet", () => {
    const withLine = drawCreature(SIZE, SIZE);
    for (let y = Math.round(0.84 * SIZE); y < Math.round(0.84 * SIZE) + 3; y++) {
      for (let x = Math.round(0.2 * SIZE); x < Math.round(0.8 * SIZE); x++) withLine.data.set([30, 30, 36, 255], (y * SIZE + x) * 4);
    }
    const cut = cutCharacter(withLine)!;
    const plain = cutCharacter(concept)!;
    // The line is gone (the cutout is no wider than the creature's body), the feet still reach the line.
    expect(cut.bounds.minX).toBeGreaterThanOrEqual(plain.bounds.minX - 1);
    expect(cut.bounds.maxX).toBeLessThanOrEqual(plain.bounds.maxX + 1);
    expect(cut.bounds.maxY).toBeGreaterThanOrEqual(plain.bounds.maxY);
    expect(cut.bounds.maxY).toBeLessThanOrEqual(plain.bounds.maxY + 3);
  });
});

describe("traced rigs", () => {
  const cut = cutCharacter(concept)!;
  const frame = fitBounds(cut.bounds, { width: 40, height: 40 });
  const built = tracedRig(cut, plan, direction, { canvasPerGamePx: 1 / frame.scale });
  const { rig } = built;
  const part = (id: string) => rig.parts.find((p) => p.id === id)!;
  const points = (id: string) => (part(id).shape as { points: [number, number][] }).points;

  it("redraws every piece as vector shapes: an outline under everything, a base shape, colour regions on top", () => {
    expect(built.warnings).toEqual([]);
    expect(Rig.safeParse(rig).success).toBe(true);
    expect(rig.mode).toBe("traced");
    expect(rig.source).toBeUndefined();
    for (const p of rig.parts) {
      expect(p.shape.type).toBe("blob");
      expect(points(p.id).length).toBeLessThanOrEqual(48);
    }
    const lowest = Math.min(...plan.parts.map((piece) => part(piece.id).z));
    for (const piece of plan.parts) {
      expect(part(piece.id).bone).toBe(piece.bone);
      expect(part(piece.id).ink).toBe(0);
      // Its outline: the same shape in the ink colour, drawn with the art direction's ink, below every piece.
      const ink = part(`${piece.id}_ink`);
      expect(ink.bone).toBe(piece.bone);
      expect(ink.fill).toBe(direction.ink);
      expect(ink.ink).toBeGreaterThan(0);
      expect(ink.z).toBeLessThan(lowest);
      expect(points(`${piece.id}_ink`)).toEqual(points(piece.id));
    }
    // Unique z, in the plan's order: far leg, body, head, near leg.
    expect(new Set(rig.parts.map((p) => p.z)).size).toBe(rig.parts.length);
    const z = (id: string) => part(id).z;
    expect(z("leg_far")).toBeLessThan(z("body"));
    expect(z("body")).toBeLessThan(z("head"));
    expect(z("head")).toBeLessThan(z("leg_near"));
    // Colours come from the drawing: the body's brown, the head's cream, a dark eye on the head.
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const near = (hex: string, want: number[]) => Math.hypot(...rgb(hex).map((c, i) => c - want[i]!)) < 30;
    expect(near(part("body").fill, [107, 79, 58])).toBe(true);
    expect(near(part("head").fill, [232, 224, 200])).toBe(true);
    const eye = rig.parts.find((p) => p.bone === "head" && /_d\d+$/.test(p.id) && near(p.fill, [32, 32, 40]));
    expect(eye?.ink).toBe(0);
    expect(eye && pointInPolygon(0.74 * SIZE, 0.38 * SIZE, points(eye.id))).toBe(true);
  });

  it("continues each piece under the pieces drawn in front of it, so turning a joint shows no hole", () => {
    // The body runs on under the near leg's top (the leg is in front)...
    const hip = built.bones.find((b) => b.id === "leg_near")!.pivot;
    expect(pointInPolygon(0.56 * SIZE, hip[1] + 6, points("body"))).toBe(true);
    // ...and the far leg (behind the body) runs on up under the body.
    expect(pointInPolygon(0.39 * SIZE, 0.67 * SIZE - 4, points("leg_far"))).toBe(true);
    // Not further than that: the body doesn't reach the near leg's foot.
    expect(pointInPolygon(0.56 * SIZE, 0.82 * SIZE, points("body"))).toBe(false);
  });

  it("measures the drawing's outline width", () => {
    // The test creature has no outline; a dark ring 6 px deep reads as about 6.
    expect(drawnLineWidth(cut.image.data, solidMask(cut.image), cut.image.width, cut.image.height)).toBe(0);
    const W = 64;
    const data = new Uint8Array(W * W * 4);
    const solid = new Uint8Array(W * W);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.min(x, y, W - 1 - x, W - 1 - y) - 8; // a 48 px square, 8 px in
        if (d < 0) continue;
        solid[y * W + x] = 1;
        data.set(d < 6 ? [20, 20, 25, 255] : [180, 150, 120, 255], (y * W + x) * 4);
      }
    }
    expect(drawnLineWidth(data, solid, W, W)).toBeGreaterThanOrEqual(5);
    expect(drawnLineWidth(data, solid, W, W)).toBeLessThanOrEqual(8);
  });

  it("limits the joints of rigs cut from a drawing and fits clips to them", () => {
    const gameRig = toRigSpace(rig, frame);
    const limits = motionLimits(gameRig);
    // The root and the body (its parent has no parts) move freely; the legs and head are limited.
    expect(limits.has("root")).toBe(false);
    expect(limits.has("body")).toBe(false);
    for (const id of ["leg_near", "leg_far", "head"]) {
      const l = limits.get(id)!;
      expect(l.rotate).toBeGreaterThanOrEqual(10);
      expect(l.rotate).toBeLessThanOrEqual(40);
      expect(l.move).toBeGreaterThan(0);
    }
    const wild = Clip.parse({
      duration: 1,
      loop: true,
      tracks: [{ bone: "head", property: "rotate", keys: [[0, 0], [0.5, -90], [1, 0]] }],
      motions: [
        { type: "sway", bone: "leg_near", degrees: 80, cycles: 1 },
        { type: "bob", bone: "leg_far", amount: 30, cycles: 1 },
        { type: "sway", bone: "body", degrees: 60, cycles: 1 },
      ],
    });
    const fitted = fitClip(wild, limits);
    const peak = (clip: Clip, bone: string, key: "rotate" | "y") => Math.max(...Array.from({ length: 65 }, (_, i) => Math.abs(channels(clip, bone, i / 64)[key])));
    expect(peak(fitted, "head", "rotate")).toBeCloseTo(limits.get("head")!.rotate, 0);
    expect(peak(fitted, "leg_near", "rotate")).toBeLessThanOrEqual(limits.get("leg_near")!.rotate + 0.01);
    expect(peak(fitted, "leg_far", "y")).toBeLessThanOrEqual(limits.get("leg_far")!.move + 0.01);
    expect(peak(fitted, "body", "rotate")).toBeCloseTo(60, 0); // free
    // The motion keeps its shape: the head still peaks at t = 0.5.
    expect(fitted.tracks[0]!.keys.map((k) => k[0])).toEqual([0, 0.5, 1]);
    // A clip within the limits is unchanged.
    const calm = Clip.parse({ duration: 1, loop: true, motions: [{ type: "sway", bone: "leg_near", degrees: 5, cycles: 1 }] });
    expect(fitClip(calm, limits)).toEqual(calm);
  });
});

describe("animation metrics", () => {
  const W = 40;
  const square = (edit?: (x: number, y: number) => boolean | null): Pixels => {
    const data = new Uint8Array(W * W * 4);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        let on = x >= 10 && x < 30 && y >= 10 && y < 30;
        const e = edit?.(x, y);
        if (e !== null && e !== undefined) on = e;
        if (on) data.set([90, 60, 40, 255], (y * W + x) * 4);
      }
    }
    return { width: W, height: W, data };
  };
  const stats = (p: Pixels) => maskStats(new Uint8Array(Array.from({ length: W * W }, (_, i) => (p.data[i * 4 + 3]! >= 128 ? 1 : 0))), W, W);
  const rest = stats(square());

  it("counts holes, seams and debris against the rest pose, ignoring rigid moves", () => {
    expect(frameMetrics(rest, rest)).toEqual({ holes: 0, seams: 0, debris: 0, area: 1 });
    const moved = square((x, y) => x >= 14 && x < 34 && y >= 12 && y < 32);
    expect(frameMetrics(rest, stats(moved))).toEqual({ holes: 0, seams: 0, debris: 0, area: 1 });
    // A 4x4 hole in the middle: 16 px of 400.
    const holed = frameMetrics(rest, stats(square((x, y) => (x >= 18 && x < 22 && y >= 18 && y < 22 ? false : null))));
    expect(holed.holes).toBe(40);
    expect(holed.seams).toBe(0);
    // A 1 px crack from the edge most of the way in: a seam, not a hole.
    const cracked = frameMetrics(rest, stats(square((x, y) => (x === 20 && y >= 10 && y < 26 ? false : null))));
    expect(cracked.holes).toBe(0);
    expect(cracked.seams).toBeGreaterThan(0);
    // A piece flying off.
    const debris = frameMetrics(rest, stats(square((x, y) => (x >= 34 && x < 38 && y >= 2 && y < 6 ? true : null))));
    expect(debris.debris).toBe(40);
  });

  it("reads a sheet: rest pose first, then each clip's frames", () => {
    const sheet: Pixels = { width: W * 3, height: W, data: new Uint8Array(W * 3 * W * 4) };
    const cells = [square(), square(), square((x, y) => (x >= 18 && x < 22 && y >= 18 && y < 22 ? false : null))];
    cells.forEach((cell, n) => {
      for (let y = 0; y < W; y++) sheet.data.set(cell.data.subarray(y * W * 4, (y + 1) * W * 4), (y * W * 3 + n * W) * 4);
    });
    const metrics = sheetMetrics(sheet, { width: W, height: W }, 3, ["idle"], 2);
    expect(metrics.idle!.mean.holes).toBe(20);
    expect(metrics.idle!.worst.holes).toBe(40);
  });
});

// --- through the stages ------------------------------------------------------------

/** Answers the cutout prompts with the creature's plan, and animation prompts with one wild clip. */
class TracedVision extends FakeVisionModel {
  prompts: string[] = [];
  override async complete(request: VisionRequest) {
    const prompt = request.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    this.prompts.push(prompt);
    const usage = { cost: 0, promptTokens: 10, completionTokens: 10 };
    const reply = (value: unknown) => ({ text: JSON.stringify(value), usage, model: this.id });
    const idle = { duration: 1, loop: true, motions: [{ type: "sway", bone: "leg_near", degrees: 85, cycles: 1 }] };
    if (prompt.includes("Plan the cutout rig")) return reply(creaturePlan(SIZE, SIZE));
    if (prompt.includes("Review the cutout rig")) return reply({ score: 9, issues: [], plan: null });
    if (prompt.includes("Write exactly these clips")) return reply({ clips: { idle } });
    if (prompt.includes("Score the animation")) return reply({ score: 9, issues: [], clips: { idle } });
    return super.complete(request);
  }
}

describe("traced rigs through the stages", () => {
  it("builds a traced rig from the design and fits its clips to the joints' limits", async () => {
    let project: ProjectSpec = createDefaultProject();
    const files = new Map<string, Buffer>();
    const vision = new TracedVision();
    const ctx: ArtContext = {
      project: () => project,
      image: new FakeImageModel(),
      vision,
      renderer: new FakeRenderer(),
      files: {
        async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
          const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
          files.set(ref, data);
          return ref;
        },
        async get(ref: FileRef) {
          return files.get(ref)!;
        },
      },
      log: () => {},
      remaining: () => 1,
      spend: () => {},
      rigRounds: 1,
    };
    const commit = (operations: OperationCall[]) => {
      const result = applyBatch(project, operations);
      if (!result.ok) throw new Error(result.error.message);
      project = result.project;
    };
    const file = await ctx.files.put(encodePng(concept), "png");
    commit([
      { name: "createAsset", input: { asset: { id: "look", name: "Look", kind: "character", brief: "a stout beast" }, assignTo: "charger" } },
      { name: "addConcept", input: { assetId: "look", concept: { file, prompt: "p", model: "m", cost: 0, at: "2026-01-01T00:00:00Z" } } },
      { name: "chooseConcept", input: { assetId: "look", sheet: 0, cell: 0, file } },
    ]);
    const asset = () => project.art.assets.find((a) => a.id === "look") as Extract<ProjectSpec["art"]["assets"][number], { kind: "character" }>;
    const built = await buildRig(ctx, { characterId: "charger", rigMode: "traced" });
    commit(built.operations);
    expect(asset().rig?.mode).toBe("traced");
    expect(asset().rig?.parts.every((p) => p.shape.type === "blob")).toBe(true);
    expect(built.plan?.bones.find((b) => b.id === "leg_near")!.pivot[1]).toBeCloseTo(0.67 * SIZE, -1);

    commit((await animate(ctx, { characterId: "charger", slots: ["idle"] })).operations);
    const limit = motionLimits(asset().rig!).get("leg_near")!.rotate;
    expect(asset().clips.idle!.motions[0]).toMatchObject({ type: "sway", bone: "leg_near" });
    expect(Math.abs((asset().clips.idle!.motions[0] as { degrees: number }).degrees)).toBeLessThanOrEqual(limit);
    // The animator is told the limits (vector rigs never are).
    expect(vision.prompts.find((p) => p.includes("Write exactly these clips"))).toContain(`leg_near ±${limit}°`);
  });
});
