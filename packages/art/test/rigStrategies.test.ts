import { describe, expect, it } from "vitest";
import { defaultArtDirection, Rig } from "@anomaly/core";
import {
  assemblePuppet,
  conceptPrompt,
  creaturePlan,
  cutCharacter,
  curveOutline,
  drawCreature,
  fitBounds,
  isolateFigure,
  jointPivots,
  labelParts,
  partAnchors,
  sheetPieces,
  tracedRig,
  type Pixels,
  type PuppetPlan,
} from "../src/index.ts";
import { createDefaultProject } from "@anomaly/core";

// The opt-in rig strategies: the main-figure check, the clean tracer, and puppet assembly (puppet.ts).

const SIZE = 256;
const direction = defaultArtDirection();

function paint(img: Pixels, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([...rgb, 255], (y * img.width + x) * 4);
}

describe("main figure", () => {
  it("paints out neighbours and sparks, keeps bits close to the figure, and flags a figure cut off by the edge", () => {
    const concept = drawCreature(SIZE, SIZE);
    paint(concept, 2, 100, 14, 160, [40, 40, 50]); // a neighbouring figure leaking in at the left edge
    paint(concept, 20, 10, 46, 36, [250, 200, 60]); // a spark, far from the figure
    const figure = isolateFigure(concept)!;
    expect(figure.dropped).toBe(2);
    expect(figure.touchesEdge).toBe(false);
    const cut = cutCharacter(figure.image)!;
    expect(cut.bounds.minX).toBeGreaterThan(40);
    expect(cut.bounds.minY).toBeGreaterThan(36);
    // The figure itself is untouched.
    expect(cutCharacter(concept)!.bounds.maxX).toBe(cut.bounds.maxX);

    // Moved down so its feet run off the bottom: cut off.
    const low = drawCreature(SIZE, SIZE, { cell: { x: 0, y: 0.25, w: 1, h: 1 } });
    expect(isolateFigure(low)!.touchesEdge).toBe(true);
  });

  it("asks for rig-ready concepts only when told", () => {
    const character = createDefaultProject().characters[0]!;
    const plain = conceptPrompt({ character, brief: "a knight", direction, refining: false });
    const ready = conceptPrompt({ character, brief: "a knight", direction, refining: false, rigReady: true });
    expect(plain).not.toContain("neutral standing pose");
    expect(ready).toContain("neutral standing pose");
    expect(ready).toContain("clearly different colours");
  });
});

describe("clean tracer", () => {
  const concept = drawCreature(SIZE, SIZE);
  const plan = creaturePlan(SIZE, SIZE);
  const cut = cutCharacter(concept)!;
  const frame = fitBounds(cut.bounds, { width: 40, height: 40 });

  it("traces the same pieces as smooth curves, keeping the eye", () => {
    const old = tracedRig(cut, plan, direction, { canvasPerGamePx: 1 / frame.scale }).rig;
    const clean = tracedRig(cut, plan, direction, { canvasPerGamePx: 1 / frame.scale, clean: true }).rig;
    expect(Rig.safeParse(clean).success).toBe(true);
    for (const piece of plan.parts) expect(clean.parts.some((p) => p.id === piece.id)).toBe(true);
    // No more shapes than the old tracer, and the eye (a small dark detail on the head) survives.
    expect(clean.parts.length).toBeLessThanOrEqual(old.parts.length + 2);
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(clean.parts.some((p) => p.bone === "head" && /_d\d+$/.test(p.id) && Math.hypot(...rgb(p.fill).map((c, i) => c - [32, 32, 40][i]!)) < 40)).toBe(true);
  });

  it("fits a circle with few points and no corners, and keeps a square's corners sharp", () => {
    const W = 120;
    const disk = new Uint8Array(W * W);
    const square = new Uint8Array(W * W);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        if (Math.hypot(x - 60, y - 60) < 40) disk[y * W + x] = 1;
        if (x >= 20 && x < 100 && y >= 20 && y < 100) square[y * W + x] = 1;
      }
    }
    const circle = curveOutline(disk, W, W)!;
    expect(circle.points.length).toBeLessThanOrEqual(24);
    expect(circle.sharp).toEqual([]);
    for (const [x, y] of circle.points) expect(Math.abs(Math.hypot(x - 60, y - 60) - 40)).toBeLessThan(2);
    const box = curveOutline(square, W, W)!;
    expect(box.sharp.length).toBe(4);
  });
});

describe("puppet assembly", () => {
  // The creature as the design, and a "parts sheet": its head and near leg drawn apart (moved).
  const concept = drawCreature(SIZE, SIZE);
  const base = creaturePlan(SIZE, SIZE);
  const plan: PuppetPlan = {
    bones: base.bones,
    parts: base.parts.map((p) => ({ ...p, piece: p.id.replace(/_/g, " "), ...(p.id === "leg_far" ? { twin: "leg_near" } : {}) })),
  };
  const cut = cutCharacter(concept)!;
  const labels = labelParts(cut, plan);
  const bones = jointPivots(cut, plan, labels);
  const frame = fitBounds(cut.bounds, { width: 40, height: 40 });
  const conceptRig = tracedRig(cut, { ...plan, bones }, direction, { canvasPerGamePx: 1 / frame.scale, clean: true }).rig;

  it("finds two anchors per part on the design", () => {
    const anchors = partAnchors(plan, bones, labels, cut);
    const leg = anchors.get("leg_near")!;
    expect(leg[0].at).toEqual(bones.find((b) => b.id === "leg_near")!.pivot);
    expect(leg[1].label).toContain("far tip");
    expect(leg[1].at[1]).toBeGreaterThan(leg[0].at[1]); // the foot is below the hip
  });

  it("puts sheet pieces back on the design's joints, and falls back to the design for parts with no piece", () => {
    // A sheet holding the near leg alone, shifted 60 px right and 20 px up of where it is on the design.
    const sheet: Pixels = { width: SIZE, height: SIZE, data: new Uint8Array(SIZE * SIZE * 4) };
    for (let i = 0; i < SIZE * SIZE; i++) sheet.data.set([216, 214, 207, 255], i * 4);
    const [ox, oy] = cut.offset;
    const legIndex = plan.parts.findIndex((p) => p.id === "leg_near");
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== legIndex) continue;
      const x = (i % cut.image.width) + ox + 60;
      const y = Math.floor(i / cut.image.width) + oy - 20;
      if (x < SIZE && y >= 0) sheet.data.set(concept.data.subarray(((y + 20) * SIZE + x - 60) * 4, ((y + 20) * SIZE + x - 60) * 4 + 4), (y * SIZE + x) * 4);
    }
    const pieces = sheetPieces(sheet)!;
    expect(pieces.pieces.length).toBe(1);
    const anchors = partAnchors(plan, bones, labels, cut);
    const [a, b] = anchors.get("leg_near")!;
    const built = assemblePuppet({
      plan,
      bones,
      anchors,
      sheet: pieces,
      matches: [{ id: "leg_near", piece: 1, a: [a.at[0] + 60, a.at[1] - 20], b: [b.at[0] + 60, b.at[1] - 20], flip: false }],
      conceptRig,
      direction,
      canvasPerGamePx: 1 / frame.scale,
    });
    expect(Rig.safeParse(built.rig).success).toBe(true);
    expect(built.fallback.sort()).toEqual(["body", "head"]);
    // The near leg lands back where it is on the design (within a few px), and its far twin reuses it, darker.
    const leg = built.rig.parts.find((p) => p.id === "leg_near")!;
    const ys = (leg.shape as { points: [number, number][] }).points.map((p) => p[1]);
    const legBox = conceptRig.parts.find((p) => p.id === "leg_near")!;
    const wantYs = (legBox.shape as { points: [number, number][] }).points.map((p) => p[1]);
    expect(Math.abs(Math.max(...ys) - Math.max(...wantYs))).toBeLessThan(6);
    const far = built.rig.parts.find((p) => p.id === "leg_far")!;
    expect(far.bone).toBe("leg_far");
    expect(far.fill).not.toBe(leg.fill);
  });
});
