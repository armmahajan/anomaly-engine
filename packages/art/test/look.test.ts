import { describe, expect, it } from "vitest";
import { exampleRig, MAX_PARTS, Rig } from "@anomaly/core";
import { bakePart, decodePng, explode, packAtlas, registerMasks, toCanvasSpace, toRigSpace, withDetails, withTextures, type PartBake } from "../src/index.ts";

// The look of a vector rig (dress.ts, texture.ts): detail shapes, baked textures, the atlas, lining images up, pulling pieces apart.

function rect(W: number, H: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
}

describe("detail shapes", () => {
  it("go on their part's bone, right above it and under what is in front, clipped to it", () => {
    const rig = exampleRig();
    const { rig: dressed, kept } = withDetails(rig, [
      { id: "band", on: "shell", shape: { type: "ellipse", center: [0, -10], rx: 30, ry: 4, rotation: 0 }, fill: "#ffffff", opacity: 0.5 },
      { id: "stud", on: "head", shape: { type: "ellipse", center: [14, -22], rx: 1, ry: 1, rotation: 0 }, fill: "#000000", clip: false },
      { id: "lost", on: "no_such_part", shape: { type: "ellipse", center: [0, 0], rx: 1, ry: 1, rotation: 0 }, fill: "#000000" },
    ]);
    expect(kept.map((d) => d.id)).toEqual(["band", "stud"]);
    const z = (id: string) => dressed.parts.find((p) => p.id === id)!.z;
    const band = dressed.parts.find((p) => p.id === "band")!;
    expect(band).toMatchObject({ bone: "body", clipTo: "shell", ink: 0, opacity: 0.5 });
    expect(dressed.parts.find((p) => p.id === "stud")!.clipTo).toBeUndefined();
    // Draw order: shell < band < shell_seam (the next part up), and the base parts keep their order.
    expect(z("shell")).toBeLessThan(z("band"));
    expect(z("band")).toBeLessThan(z("shell_seam"));
    const order = (r: Rig) => [...r.parts].sort((a, b) => a.z - b.z).map((p) => p.id).filter((id) => rig.parts.some((q) => q.id === id));
    expect(order(dressed)).toEqual(order(rig));
    // The base parts' geometry is untouched.
    for (const p of rig.parts) expect(dressed.parts.find((q) => q.id === p.id)!.shape).toEqual(p.shape);
  });

  it("never take the rig past the part limit", () => {
    const rig = exampleRig();
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `d${i}`, on: "shell", shape: { type: "ellipse" as const, center: [0, -10] as [number, number], rx: 2, ry: 2, rotation: 0 }, fill: "#ffffff" }));
    const { rig: dressed } = withDetails(rig, many);
    expect(dressed.parts.length).toBe(MAX_PARTS);
  });
});

describe("baked textures", () => {
  it("take the source inside the shape, fill small holes from their neighbours and leave big ones bare", () => {
    const size = { width: 40, height: 40 };
    const mask = rect(40, 40, 5, 5, 35, 35);
    // The source has a red left half; the right half is unknown, except a thin strip.
    const bake = bakePart(0, mask, size, (x) => (x < 20 || (x > 30 && x < 32) ? [200, 10, 10] : null), { margin: 2, reach: 3 })!;
    expect(bake.box).toEqual({ x: 3, y: 3, width: 34, height: 34 });
    const alpha = (x: number, y: number) => bake.image.data[((y - 3) * 34 + (x - 3)) * 4 + 3];
    expect(alpha(10, 20)).toBe(255); // known
    expect(alpha(22, 20)).toBe(255); // a hole next to known pixels
    expect(alpha(26, 20)).toBe(0); // too far from anything known: the flat fill shows
    expect(bake.coverage).toBeGreaterThan(0.45);
    expect(bake.coverage).toBeLessThan(0.6);
  });

  it("pack into one atlas within the size limit, and map onto the rig through the frame", () => {
    const pieces: PartBake[] = [0, 1, 2].map((i) => ({
      part: i,
      box: { x: 10 * i, y: 0, width: 300, height: 200 },
      image: { width: 300, height: 200, data: new Uint8Array(300 * 200 * 4).fill(255) },
      coverage: 1,
    }));
    const atlas = packAtlas(pieces, 512);
    expect(atlas.image.width).toBeLessThanOrEqual(512);
    expect(atlas.image.height).toBeLessThanOrEqual(512);
    expect(atlas.scale).toBeLessThan(1);
    expect(decodePng(atlas.png).width).toBe(atlas.image.width);
    // Regions don't overlap.
    const r = atlas.regions.map((x) => x.uv);
    for (let i = 0; i < r.length; i++)
      for (let j = i + 1; j < r.length; j++) {
        const [a, b] = [r[i]!, r[j]!];
        expect(a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1]).toBe(true);
      }
    const rig = exampleRig();
    const frame = { scale: 0.1, anchor: [256, 400] as [number, number] };
    const textured = withTextures(rig, atlas, pieces, "0123456789abcdef.png", frame, 0.6);
    expect(Rig.safeParse(textured).success).toBe(true);
    const t = textured.parts[1]!.texture!;
    expect(t.rect).toEqual([(10 - 256) * 0.1, -400 * 0.1, 30, 20]);
    expect(t.opacity).toBe(0.6);
    // The rectangle moves with the rig between canvas and rig space.
    expect(toRigSpace(toCanvasSpace(textured, frame), frame).parts[1]!.texture!.rect).toEqual(t.rect);
  });
});

describe("lining up and pulling apart", () => {
  it("finds the scale and shift that lay one shape over another", () => {
    const W = 120;
    const a = rect(W, W, 30, 20, 60, 90);
    // b: the same shape 1.2x larger, moved.
    const b = rect(W, W, 40, 12, 76, 96);
    const { t, iou } = registerMasks(a, W, W, b, W, W);
    expect(iou).toBeGreaterThan(0.9);
    expect(t.s).toBeCloseTo(1.2, 1);
  });

  it("pulls overlapping pieces apart until none touch", () => {
    const W = 100;
    const masks = [rect(W, W, 30, 30, 70, 70), rect(W, W, 40, 35, 60, 80), rect(W, W, 10, 10, 20, 20)];
    const off = explode(masks, W, W, 6);
    const placed = masks.map((m, i) => ({ m, dx: off[i]![0], dy: off[i]![1] }));
    // Shifted masks overlap nowhere.
    const grid = new Map<string, number>();
    let overlaps = 0;
    placed.forEach(({ m, dx, dy }) => {
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue;
        const key = `${(i % W) + dx},${Math.floor(i / W) + dy}`;
        if (grid.has(key)) overlaps++;
        grid.set(key, 1);
      }
    });
    expect(overlaps).toBe(0);
    expect(off[2]).toEqual([0, 0]); // a piece that touched nothing stays put
  });
});
