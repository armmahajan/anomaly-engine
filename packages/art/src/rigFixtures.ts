import type { Rig } from "@anomaly/core";
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

/** The creature at `width` x `height` (anti-aliased edges), within `cell` (fractions) of the image if given; `mirror` faces it left. */
export function drawCreature(
  width: number,
  height: number,
  options: { cell?: { x: number; y: number; w: number; h: number }; tint?: number; mirror?: boolean; background?: [number, number, number] } = {},
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
          const u = ((px + (sx + 0.5) / SS) / width - cell.x) / cell.w;
          const x = options.mirror ? 1 - u : u;
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

/** A 2x2 concept sheet of the creature (each cell a little redder), facing left like image models often draw. */
export function drawCreatureSheet(size: number, tint = 0): Pixels {
  const sheet = drawCreature(size, size);
  const half = size / 2;
  for (let cell = 0; cell < 4; cell++) {
    const x0 = (cell % 2) * half;
    const y0 = Math.floor(cell / 2) * half;
    const one = drawCreature(size, size, { cell: { x: x0 / size, y: y0 / size, w: 0.5, h: 0.5 }, mirror: true, tint: (tint + cell * 12) % 60 });
    for (let y = y0; y < y0 + half; y++) sheet.data.set(one.data.subarray((y * size + x0) * 4, (y * size + x0 + half) * 4), (y * size + x0) * 4);
  }
  return sheet;
}

/**
 * A small humanoid vector rig (tests): body, head, two two-bone arms (the near one in front, with a
 * hand) and two legs, 44 px tall, facing right.
 */
export function humanoidRig(): Rig {
  const part = (id: string, bone: string, z: number, shape: Rig["parts"][number]["shape"], fill: string) => ({ id, bone, z, shape, fill, ink: 1, glow: false, opacity: 1 });
  const stroke = (points: [number, number][], width: number) => ({ type: "stroke" as const, points, width, widthEnd: width * 0.8, smooth: 1 });
  return {
    bones: [
      { id: "root", parent: null, pivot: [0, 0] },
      { id: "body", parent: "root", pivot: [0, -20] },
      { id: "head", parent: "body", pivot: [0, -32] },
      { id: "arm_far_upper", parent: "body", pivot: [3, -30] },
      { id: "arm_far_lower", parent: "arm_far_upper", pivot: [4, -22] },
      { id: "arm_near_upper", parent: "body", pivot: [-3, -30] },
      { id: "arm_near_lower", parent: "arm_near_upper", pivot: [-2, -22] },
      { id: "leg_back", parent: "body", pivot: [-3, -19] },
      { id: "leg_front", parent: "body", pivot: [3, -19] },
    ],
    parts: [
      part("arm_far_upper", "arm_far_upper", -3, stroke([[3, -30], [4, -22]], 4), "#3a3a48"),
      part("arm_far_lower", "arm_far_lower", -3, stroke([[4, -22], [5, -15]], 3.5), "#3a3a48"),
      part("leg_back", "leg_back", -2, stroke([[-3, -19], [-4, 0]], 5), "#2a2a33"),
      part("leg_front", "leg_front", -1, stroke([[3, -19], [4, 0]], 5), "#2a2a33"),
      part("torso", "body", 0, { type: "blob", points: [[-6, -32], [6, -32], [7, -18], [-7, -18]], smooth: 0.4, sharp: [] }, "#4a5470"),
      part("head", "head", 1, { type: "ellipse", center: [1, -38], rx: 6, ry: 6.5, rotation: 0 }, "#e8d8c0"),
      part("arm_near_upper", "arm_near_upper", 3, stroke([[-3, -30], [-2, -22]], 4), "#5a6480"),
      part("arm_near_lower", "arm_near_lower", 4, stroke([[-2, -22], [-1, -15]], 3.5), "#5a6480"),
      part("hand_near", "arm_near_lower", 5, { type: "ellipse", center: [-1, -14], rx: 2.2, ry: 2.2, rotation: 0 }, "#e8d8c0"),
    ],
  };
}
