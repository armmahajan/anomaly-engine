import type { CutoutPlan } from "./cutout.ts";
import type { Pixels } from "./match.ts";

/**
 * A test creature drawn in code (tests and the scripted models): a body, a head with an eye,
 * two legs, on a flat light-grey background like the concept sheets. Everything is in
 * fractions of the image, so it can be drawn at any size; `creaturePlan` is a good cutout
 * plan for it.
 */

type Shape =
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; color: [number, number, number] }
  | { kind: "rect"; x0: number; y0: number; x1: number; y1: number; color: [number, number, number] };

/** Back to front. */
const SHAPES: Shape[] = [
  { kind: "rect", x0: 0.36, y0: 0.6, x1: 0.42, y1: 0.84, color: [58, 46, 38] }, // far leg
  { kind: "rect", x0: 0.53, y0: 0.6, x1: 0.59, y1: 0.84, color: [92, 70, 52] }, // near leg
  { kind: "ellipse", cx: 0.47, cy: 0.55, rx: 0.2, ry: 0.13, color: [107, 79, 58] }, // body
  { kind: "ellipse", cx: 0.7, cy: 0.4, rx: 0.1, ry: 0.1, color: [232, 224, 200] }, // head
  { kind: "ellipse", cx: 0.74, cy: 0.38, rx: 0.022, ry: 0.022, color: [32, 32, 40] }, // eye
];

export const CREATURE_BACKGROUND: [number, number, number] = [218, 216, 208];

const inside = (s: Shape, x: number, y: number) =>
  s.kind === "rect" ? x >= s.x0 && x < s.x1 && y >= s.y0 && y < s.y1 : ((x - s.cx) / s.rx) ** 2 + ((y - s.cy) / s.ry) ** 2 <= 1;

/** The creature at `width` x `height` (anti-aliased edges), within `cell` (fractions) of the image if given. */
export function drawCreature(
  width: number,
  height: number,
  options: { cell?: { x: number; y: number; w: number; h: number }; tint?: number; background?: [number, number, number] } = {},
): Pixels {
  const data = new Uint8Array(width * height * 4);
  const cell = options.cell ?? { x: 0, y: 0, w: 1, h: 1 };
  const bg = options.background ?? CREATURE_BACKGROUND;
  const SS = 3;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / width - cell.x) / cell.w;
          const y = ((py + (sy + 0.5) / SS) / height - cell.y) / cell.h;
          let color = bg;
          for (const s of SHAPES) if (inside(s, x, y)) color = s.color;
          if (color !== bg && options.tint) color = color.map((c, i) => Math.min(255, c + (i === 0 ? options.tint! : 0))) as [number, number, number];
          for (let c = 0; c < 3; c++) sum[c]! += color[c]!;
        }
      }
      const o = (py * width + px) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(sum[c]! / (SS * SS));
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** A good cutout plan for the creature drawn at `width` x `height`. */
export function creaturePlan(width: number, height: number): CutoutPlan {
  const p = (x: number, y: number): [number, number] => [Math.round(x * width * 10) / 10, Math.round(y * height * 10) / 10];
  const box = (x0: number, y0: number, x1: number, y1: number) => [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)];
  return {
    bones: [
      { id: "root", parent: null, pivot: p(0.47, 0.84) },
      { id: "body", parent: "root", pivot: p(0.47, 0.6) },
      { id: "head", parent: "body", pivot: p(0.63, 0.46) },
      { id: "leg_far", parent: "body", pivot: p(0.39, 0.66) },
      { id: "leg_near", parent: "body", pivot: p(0.56, 0.66) },
    ],
    parts: [
      { id: "body", bone: "body", z: 0, region: box(0.25, 0.4, 0.65, 0.67) },
      { id: "head", bone: "head", z: 1, region: box(0.61, 0.27, 0.83, 0.52) },
      { id: "leg_far", bone: "leg_far", z: -1, region: box(0.34, 0.67, 0.44, 0.87) },
      { id: "leg_near", bone: "leg_near", z: 2, region: box(0.51, 0.67, 0.61, 0.87) },
    ],
  };
}
