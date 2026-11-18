import { z } from "zod";
import { Bone, Id, MAX_BONES, MAX_PARTS, Point, Rig, type FileRef, type Part } from "@anomaly/core";
import type { Pixels } from "./match.ts";

/**
 * Cutout rigs, the pixel work: cut the character out of its concept (code, not
 * a model), then turn the model's rough semantic plan (bones, and a rough
 * region per part) into exact "image" parts: every opaque pixel goes to one
 * part, and each part's polygon is traced around its pixels, grown a little
 * across joints so rotating limbs never open gaps.
 *
 * Coordinates are concept pixels ("canvas space", see frame.ts) throughout.
 */

/** Opaque enough to belong to the character. */
const SOLID_ALPHA = 16;
/** Polygons grow this far (px) past their pixels: hides seams, covers anti-aliased edges. */
export const OVERLAP = 2;
const MAX_POINTS = 128;

// --- cutting out ---------------------------------------------------------------

export interface Cutout {
  /** The character alone (RGBA, transparent background), cropped to its pixels plus a margin. */
  image: Pixels;
  /** Concept px of the image's top-left corner. */
  offset: [number, number];
  /** Opaque bounds in concept px (inclusive min, exclusive max). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** The background color that was removed. */
  background: [number, number, number];
}

/** Colors further than this (RGB distance) from the background are the character (adapted to its noise). */
const BG_NEAR_MIN = 8;
const BG_NEAR_MAX = 40;
const MARGIN = 4;

/**
 * Remove a concept's flat background: estimate its color from the border, flood it in from
 * the edges (and drop enclosed pockets of the same color), soften the edge, and keep the
 * character's shapes (specks under 2% of the largest are dropped). Null if nothing remains.
 */
export function cutCharacter(concept: Pixels): Cutout | null {
  const { width: W, height: H, data } = concept;
  const border: number[][] = [];
  for (let x = 0; x < W; x++) border.push(rgbAt(data, x), rgbAt(data, (H - 1) * W + x));
  for (let y = 0; y < H; y++) border.push(rgbAt(data, y * W), rgbAt(data, y * W + W - 1));
  const bg = [0, 1, 2].map((c) => median(border.map((p) => p[c]!))) as [number, number, number];
  const distance = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    distance[i] = data[i * 4 + 3]! < SOLID_ALPHA ? 0 : Math.hypot(data[i * 4]! - bg[0], data[i * 4 + 1]! - bg[1], data[i * 4 + 2]! - bg[2]);
  }

  // How far from its median the background itself strays (noise, a faint gradient) sets the tolerance,
  // so pale parts on a pale background survive a clean one.
  const spread = border.map((p) => Math.hypot(p[0]! - bg[0], p[1]! - bg[1], p[2]! - bg[2])).sort((a, b) => a - b);
  const near = Math.min(BG_NEAR_MAX, Math.max(BG_NEAR_MIN, spread[Math.floor(spread.length * 0.95)]! * 1.5 + 4));

  // Background: near-background pixels connected to the border, plus enclosed pockets of it.
  const background = new Uint8Array(W * H);
  const queue: number[] = [];
  const seed = (i: number) => {
    if (!background[i] && distance[i]! < near) {
      background[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < W; x++) (seed(x), seed((H - 1) * W + x));
  for (let y = 0; y < H; y++) (seed(y * W), seed(y * W + W - 1));
  for (let q = 0; q < queue.length; q++) forNeighbors4(queue[q]!, W, H, seed);
  const pocket = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) pocket[i] = !background[i] && distance[i]! < near * 0.6 ? 1 : 0;
  for (const c of components(pocket, W, H, 4)) if (c.length >= 24) for (const i of c) background[i] = 1;

  const solid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) solid[i] = background[i] ? 0 : 1;
  const parts = components(solid, W, H, 8);
  const largest = Math.max(0, ...parts.map((c) => c.length));
  if (largest < 16) return null;
  solid.fill(0);
  for (const c of parts) if (c.length >= largest * 0.02) for (const i of c) solid[i] = 1;
  if (dropGroundLine(solid, W, H)) {
    // What the ground line held together may now be specks.
    const rest = components(solid, W, H, 8);
    const big = Math.max(0, ...rest.map((c) => c.length));
    for (const c of rest) if (c.length < big * 0.02) for (const i of c) solid[i] = 0;
  }

  let minX = W;
  let minY = H;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < W * H; i++) {
    if (!solid[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 1);
    maxY = Math.max(maxY, y + 1);
  }
  const ox = Math.max(0, minX - MARGIN);
  const oy = Math.max(0, minY - MARGIN);
  const w = Math.min(W, maxX + MARGIN) - ox;
  const h = Math.min(H, maxY + MARGIN) - oy;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y + oy) * W + x + ox;
      if (!solid[i]) continue;
      const o = (y * w + x) * 4;
      // Edge pixels blend into the background: un-mix them (alpha: how far they are from it, next to their neighbours inside).
      let alpha = 1;
      if (hasNeighbor(i, W, H, (j) => !solid[j])) {
        let inner = distance[i]!;
        forNeighbors8(i, W, H, (j) => solid[j] && (inner = Math.max(inner, distance[j]!)));
        alpha = Math.min(1, Math.max(0.2, distance[i]! / Math.max(inner, 1)));
      }
      for (let c = 0; c < 3; c++) out[o + c] = clamp255((data[i * 4 + c]! - (1 - alpha) * bg[c]!) / alpha);
      out[o + 3] = Math.round(alpha * (data[i * 4 + 3]! / 255) * 255);
    }
  }
  return { image: { width: w, height: h, data: out }, offset: [ox, oy], bounds: { minX, minY, maxX, maxY }, background: bg };
}

/** A figure closer than this share of the image's size to its edge is cut off or runs into a neighbouring cell (a figure merely drawn tight sits a few px further in). */
const EDGE_MARGIN = 0.005;
/** Separate bits this close to the figure (share of its height) belong to it (a hand, a held item)... */
const NEAR_FIGURE = 0.03;
/** ...unless they are specks smaller than this share of it. */
const MIN_BIT = 0.002;

export interface FigureCheck {
  /** The concept with everything but the main figure painted over in the background colour. */
  image: Pixels;
  /** The main figure reaches the image's edge: cut off, or running into a neighbouring cell. */
  touchesEdge: boolean;
  /** The smallest gap between the figure and the image's edge, as a share of the image's size. */
  margin: number;
  /** Separate bits dropped: neighbouring figures, sparks, specks. */
  dropped: number;
}

/**
 * Keep only the main figure of a concept cell: its largest shape and the separate bits close to
 * it (a detached hand, a held item); neighbouring figures leaking in, sparks, glows and stray
 * specks are painted over with the background. Also says whether the figure is cut off by the
 * cell's edge. Null when no figure is found.
 */
export function isolateFigure(concept: Pixels): FigureCheck | null {
  const cut = cutCharacter(concept);
  if (!cut) return null;
  const { width: w, height: h } = cut.image;
  const [ox, oy] = cut.offset;
  const { width: W, height: H } = concept;
  const solid = solidMask(cut.image);
  const pieces = components(solid, w, h, 8).sort((a, b) => b.length - a.length);
  const main = pieces[0]!;
  const box = (piece: number[]) => {
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    for (const i of piece) {
      const x = i % w;
      const y = (i - x) / w;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return { x0: x0 + ox, y0: y0 + oy, x1: x1 + ox, y1: y1 + oy };
  };
  const edgeGap = (b: ReturnType<typeof box>) => Math.min(b.x0, b.y0, W - 1 - b.x1, H - 1 - b.y1);
  const mainBox = box(main);
  const mask = new Uint8Array(w * h);
  for (const i of main) mask[i] = 1;
  const near = dilate(mask, w, h, Math.max(3, NEAR_FIGURE * (mainBox.y1 - mainBox.y0 + 1)));
  const image: Pixels = { width: W, height: H, data: concept.data.slice() };
  const drop = new Uint8Array(w * h);
  let dropped = 0;
  for (const piece of pieces.slice(1)) {
    const keep = piece.length >= MIN_BIT * main.length && piece.some((i) => near[i]) && edgeGap(box(piece)) > 1;
    if (keep) continue;
    dropped++;
    for (const i of piece) drop[i] = 1;
  }
  if (dropped > 0) {
    // Their soft edges too.
    const wide = dilate(drop, w, h, 2);
    for (let i = 0; i < w * h; i++) {
      if (!wide[i] || mask[i]) continue;
      const x = (i % w) + ox;
      const y = Math.floor(i / w) + oy;
      image.data.set([...cut.background, 255], (y * W + x) * 4);
    }
  }
  const gap = edgeGap(mainBox);
  return { image, touchesEdge: gap < EDGE_MARGIN * Math.min(W, H), margin: Math.max(0, gap) / Math.min(W, H), dropped };
}

/** Ground lines are at most this share of the character's height thick... */
const GROUND_THICKNESS = 0.045;
/** ...and their stretches between the feet cover at least this share of its width. */
const GROUND_SPAN = 0.2;

/**
 * Drop a drawn ground line or shadow under the feet (concept art often has one): thin
 * horizontal strokes at the very bottom, made of pixels whose solid column run is short (feet and
 * legs above them run tall, so they stay, with the bit of line right under them), together
 * covering a good part of the character's width. Rigs would otherwise carry scraps of it on
 * their feet. True when something was dropped.
 */
export function dropGroundLine(solid: Uint8Array, W: number, H: number): boolean {
  let minY = H;
  let maxY = -1;
  let minX = W;
  let maxX = -1;
  for (let i = 0; i < W * H; i++) {
    if (!solid[i]) continue;
    const y = Math.floor(i / W);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minX = Math.min(minX, i % W);
    maxX = Math.max(maxX, i % W);
  }
  if (maxY < 0) return false;
  const thick = Math.max(3, Math.round(GROUND_THICKNESS * (maxY - minY + 1)));
  const short = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let y = maxY;
    while (y >= minY) {
      if (!solid[y * W + x]) {
        y--;
        continue;
      }
      let top = y;
      while (top - 1 >= minY && solid[(top - 1) * W + x]) top--;
      // A short run whose bottom is in the bottom band.
      if (y - top + 1 <= thick && y >= maxY - 2 * thick) for (let r = top; r <= y; r++) short[r * W + x] = 1;
      y = top - 1;
    }
  }
  // Stretches of line: short pieces at least as wide as the line is thick, lying in the bottom band.
  const stretches: number[][] = [];
  let span = 0;
  for (const piece of components(short, W, H, 8)) {
    let x0 = W;
    let x1 = -1;
    let y0 = H;
    for (const i of piece) {
      x0 = Math.min(x0, i % W);
      x1 = Math.max(x1, i % W);
      y0 = Math.min(y0, Math.floor(i / W));
    }
    if (x1 - x0 + 1 < thick || y0 < maxY - 2 * thick) continue;
    stretches.push(piece);
    span += x1 - x0 + 1;
  }
  if (span < GROUND_SPAN * (maxX - minX + 1)) return false;
  for (const piece of stretches) for (const i of piece) solid[i] = 0;
  return true;
}

/** The cutout placed back in a canvas of the concept's size (transparent around it). */
export function placeCutout(cut: Cutout, size: { width: number; height: number }): Pixels {
  const data = new Uint8Array(size.width * size.height * 4);
  const { image, offset } = cut;
  for (let y = 0; y < image.height; y++) {
    const ty = y + offset[1];
    if (ty < 0 || ty >= size.height) continue;
    for (let x = 0; x < image.width; x++) {
      const tx = x + offset[0];
      if (tx < 0 || tx >= size.width) continue;
      data.set(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4), (ty * size.width + tx) * 4);
    }
  }
  return { width: size.width, height: size.height, data };
}

// --- the model's plan ------------------------------------------------------------

export const CutoutPart = z.object({
  id: Id,
  bone: Id,
  z: z.number().int().min(-100).max(100),
  region: z.array(Point).min(3).max(48).describe("Rough outline of where this part is (concept px)."),
});

/** What the model decides for a cutout rig: the skeleton, and roughly where each part is. */
export const CutoutPlan = z
  .object({
    bones: z.array(Bone).min(1).max(MAX_BONES),
    parts: z.array(CutoutPart).min(1).max(40),
    /** Points (concept px) on small details a traced rig must keep: eyes, ears, hands. */
    features: z.array(Point).max(24).optional(),
    notes: z.string().optional(),
  })
  .superRefine((plan, ctx) => {
    // The same skeleton rules as a rig (one root, known bones, no loops, unique ids).
    const check = Rig.safeParse({
      bones: plan.bones,
      parts: plan.parts.map((p) => ({ id: p.id, bone: p.bone, z: p.z, shape: { type: "blob", points: p.region }, fill: "#000000" })),
    });
    if (!check.success) for (const issue of check.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export type CutoutPlan = z.infer<typeof CutoutPlan>;

/**
 * A plan read back from a cutout rig (each part's region = its polygon) or a traced rig (each
 * piece's base shape; its outlines and colour regions, ids ending _ink and _d<n>, are skipped), for revisions.
 */
export function planFromRig(canvasRig: Rig): CutoutPlan {
  const parts = canvasRig.parts
    .filter((p) => p.shape.type === "image" || (canvasRig.mode === "traced" && p.shape.type === "blob" && !/_(d\d+|ink)$/.test(p.id)))
    .slice(0, 40);
  return {
    bones: canvasRig.bones,
    parts: parts.map((p) => ({ id: p.id, bone: p.bone, z: p.z, region: simplifyTo((p.shape as { points: [number, number][] }).points, 48) })),
  };
}

// --- plan -> rig ------------------------------------------------------------------

/**
 * A canvas-space cutout rig: every opaque pixel of the cutout goes to a part (inside its
 * region, else the nearest region through the character's own pixels), each part's pixels
 * become one polygon (a detached piece becomes another part on the same bone), grown by
 * OVERLAP and by a disk around its bone's pivot where it meets another bone's part.
 */
export function cutoutRig(cut: Cutout, plan: CutoutPlan, file: FileRef): { rig: Rig; warnings: string[]; labels: Int32Array; bones: Bone[] } {
  const { width: W, height: H, data } = cut.image;
  const [ox, oy] = cut.offset;
  const warnings: string[] = [];
  const solid = solidMask(cut.image);
  const local = (p: readonly [number, number]): [number, number] => [p[0] - ox, p[1] - oy];
  const label = labelParts(cut, plan);
  const jointBones = jointPivots(cut, plan, label);
  plan = { ...plan, bones: jointBones };

  // 4. One polygon per connected piece of each part.
  const bones = new Map(plan.bones.map((b) => [b.id, b]));
  const parts: Part[] = [];
  const ids = new Set<string>();
  for (let k = 0; k < plan.parts.length; k++) {
    const spec = plan.parts[k]!;
    const mine = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mine[i] = label[i] === k ? 1 : 0;
    const pieces = components(mine, W, H, 8).sort((a, b) => b.length - a.length);
    if (pieces.length === 0) {
      warnings.push(`part "${spec.id}" covers no pixels (dropped)`);
      continue;
    }
    const bone = bones.get(spec.bone)!;
    pieces.forEach((piece, n) => {
      if (n > 0 && piece.length < 6) return; // specks
      let id = n === 0 ? spec.id : `${spec.id}_${n + 1}`;
      while (ids.has(id)) id = `${id}_x`;
      ids.add(id);
      const region = new Uint8Array(W * H);
      for (const i of piece) region[i] = 1;
      if (bone.parent !== null) addJointDisk(region, piece, local(bone.pivot), label, plan, k, solid, W, H);
      const points = tracePolygon(region, W, H).map(([x, y]) => [x + ox, y + oy] as [number, number]);
      if (points.length < 3) return;
      parts.push({
        id,
        bone: spec.bone,
        z: spec.z,
        shape: { type: "image", points },
        fill: meanColor(data, piece),
        ink: 0,
        glow: false,
        opacity: 1,
      });
    });
  }
  if (parts.length > MAX_PARTS) {
    warnings.push(`too many pieces (${parts.length}); kept the first ${MAX_PARTS}`);
    parts.length = MAX_PARTS;
  }
  const rig = Rig.parse({
    mode: "cutout",
    source: { file, scale: 1, anchor: [-ox, -oy] },
    bones: plan.bones,
    parts,
  });
  return { rig, warnings, labels: label, bones: jointBones };
}

/** Opaque enough to belong to the character (1) or not (0). */
export function solidMask(image: Pixels): Uint8Array {
  const solid = new Uint8Array(image.width * image.height);
  for (let i = 0; i < solid.length; i++) solid[i] = image.data[i * 4 + 3]! >= SOLID_ALPHA ? 1 : 0;
  return solid;
}

/**
 * Which plan part each of the cutout's pixels belongs to (-1 = background): inside a region
 * (the smallest region wins where they overlap), else the nearest region through the
 * character's own pixels; stray bits cut off by another region join the part they touch most.
 */
export function labelParts(cut: Cutout, plan: CutoutPlan): Int32Array {
  const { width: W, height: H } = cut.image;
  const [ox, oy] = cut.offset;
  const solid = solidMask(cut.image);
  const regions = plan.parts.map((p) => p.region.map(([x, y]) => [x - ox, y - oy] as [number, number]));

  // 1. Pixels inside a region (the smallest region wins where they overlap).
  const label = new Int32Array(W * H).fill(-1);
  const areas = regions.map((r) => Math.abs(polygonArea(r)));
  const order = regions.map((_, k) => k).sort((a, b) => areas[b]! - areas[a]!);
  for (const k of order) {
    const r = regions[k]!;
    const xs = r.map((p) => p[0]);
    const ys = r.map((p) => p[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(H, Math.ceil(Math.max(...ys))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(W, Math.ceil(Math.max(...xs))); x++) {
        if (solid[y * W + x] && pointInPolygon(x + 0.5, y + 0.5, r)) label[y * W + x] = k;
      }
    }
  }
  // 2. The rest: grow labels through the character's pixels; pieces no region touches go to the nearest region.
  growLabels(label, solid, W, H);
  const centers = regions.map(centroid);
  for (let i = 0; i < W * H; i++) {
    if (!solid[i] || label[i] !== -1) continue;
    const x = (i % W) + 0.5;
    const y = Math.floor(i / W) + 0.5;
    let best = 0;
    centers.forEach((c, k) => {
      if (Math.hypot(c[0] - x, c[1] - y) < Math.hypot(centers[best]![0] - x, centers[best]![1] - y)) best = k;
    });
    label[i] = best;
  }
  // 3. Stray bits of a part (cut off by another region) join the part they touch most.
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let k = 0; k < regions.length; k++) {
      const mine = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) mine[i] = label[i] === k ? 1 : 0;
      const pieces = components(mine, W, H, 8).sort((a, b) => b.length - a.length);
      for (const piece of pieces.slice(1)) {
        const touching = new Map<number, number>();
        for (const i of piece) forNeighbors8(i, W, H, (j) => label[j]! >= 0 && label[j] !== k && touching.set(label[j]!, (touching.get(label[j]!) ?? 0) + 1));
        const to = [...touching].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (to === undefined) continue;
        for (const i of piece) label[i] = to;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return label;
}

/** Fewer touching pixel pairs than this is not a joint. */
const MIN_CONTACT = 3;

/**
 * Joint-aware pivots: each bone (but the root) turns about the middle of the contact between
 * its parts' pixels and its parent's (else the nearest ancestor's it touches), where the two
 * pieces actually meet, so a turning piece stays on its seam. Bones with no parts, or whose
 * parts touch no ancestor's, keep the model's pivot. Canvas px, like the plan.
 */
export function jointPivots(cut: Cutout, plan: CutoutPlan, label: Int32Array): Bone[] {
  const { width: W, height: H } = cut.image;
  const [ox, oy] = cut.offset;
  const boneOf = plan.parts.map((p) => p.bone);
  const parent = new Map(plan.bones.map((b) => [b.id, b.parent]));
  // Contact sums per (bone, other bone): x, y, count of the midpoints between touching pixels (4-neighbours).
  const contact = new Map<string, [number, number, number]>();
  const add = (a: string, b: string, x: number, y: number) => {
    const key = `${a}\u0000${b}`;
    const c = contact.get(key) ?? [0, 0, 0];
    c[0] += x;
    c[1] += y;
    c[2]++;
    contact.set(key, c);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = label[y * W + x]!;
      if (k < 0) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (x + dx >= W || y + dy >= H) continue;
        const j = label[(y + dy) * W + x + dx]!;
        if (j < 0 || boneOf[j] === boneOf[k]) continue;
        const mx = x + 0.5 + dx / 2 + ox;
        const my = y + 0.5 + dy / 2 + oy;
        add(boneOf[k]!, boneOf[j]!, mx, my);
        add(boneOf[j]!, boneOf[k]!, mx, my);
      }
    }
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return plan.bones.map((bone) => {
    for (let up = bone.parent; up !== null && up !== undefined; up = parent.get(up) ?? null) {
      const c = contact.get(`${bone.id}\u0000${up}`);
      if (c && c[2] >= MIN_CONTACT) return { ...bone, pivot: [round(c[0] / c[2]), round(c[1] / c[2])] as [number, number] };
    }
    return bone;
  });
}

/** How the pixels were split, for the critic: each part tinted its own hue, pivots as white squares. Canvas size. */
export function partsView(cut: Cutout, labels: Int32Array, plan: CutoutPlan, size: { width: number; height: number }): Pixels {
  const { width: W, height: H, data } = cut.image;
  const out = new Uint8Array(size.width * size.height * 4);
  for (let i = 0; i < size.width * size.height; i++) out.set([216, 214, 207, 255], i * 4);
  const hue = (k: number) => {
    const h = ((k * 0.618034) % 1) * 6;
    const f = h - Math.floor(h);
    return [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][Math.floor(h) % 6]!.map((c) => c * 255);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = labels[y * W + x]!;
      const tx = x + cut.offset[0];
      const ty = y + cut.offset[1];
      if (k < 0 || tx >= size.width || ty >= size.height) continue;
      const tint = hue(k);
      const o = (ty * size.width + tx) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = clamp255(data[(y * W + x) * 4 + c]! * 0.45 + tint[c]! * 0.55);
    }
  }
  for (const bone of plan.bones) {
    const [px, py] = bone.pivot.map(Math.round) as [number, number];
    for (let y = py - 3; y <= py + 3; y++) {
      for (let x = px - 3; x <= px + 3; x++) {
        if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue;
        const edge = Math.abs(x - px) === 3 || Math.abs(y - py) === 3;
        out.set(edge ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * size.width + x) * 4);
      }
    }
  }
  return { width: size.width, height: size.height, data: out };
}

/**
 * Where a part meets a part on another bone, add the disk around its pivot that covers that
 * seam: the disk turns with the part and covers itself, so no gap opens at the joint.
 */
function addJointDisk(
  region: Uint8Array,
  piece: number[],
  pivot: [number, number],
  label: Int32Array,
  plan: CutoutPlan,
  k: number,
  solid: Uint8Array,
  W: number,
  H: number,
): void {
  const bone = plan.parts[k]!.bone;
  let seam = 0;
  let minX = W;
  let minY = H;
  let maxX = 0;
  let maxY = 0;
  for (const i of piece) {
    const x = i % W;
    const y = (i - x) / W;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + 1);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + 1);
    let touches = false;
    forNeighbors8(i, W, H, (j) => {
      if (label[j]! >= 0 && plan.parts[label[j]!]!.bone !== bone) touches = true;
    });
    if (touches) seam = Math.max(seam, Math.hypot(x + 0.5 - pivot[0], y + 0.5 - pivot[1]));
  }
  if (seam === 0) return;
  // A pivot far from the seam would drag a large disk of its neighbour along: keep it limb-sized.
  const radius = Math.min(seam + OVERLAP, Math.max(4, 0.75 * Math.min(maxX - minX, maxY - minY)));
  const r = Math.ceil(radius);
  for (let y = Math.max(0, Math.floor(pivot[1]) - r); y <= Math.min(H - 1, Math.floor(pivot[1]) + r); y++) {
    for (let x = Math.max(0, Math.floor(pivot[0]) - r); x <= Math.min(W - 1, Math.floor(pivot[0]) + r); x++) {
      if (solid[y * W + x] && Math.hypot(x + 0.5 - pivot[0], y + 0.5 - pivot[1]) <= radius) region[y * W + x] = 1;
    }
  }
}

// --- tracing ----------------------------------------------------------------------

/**
 * The outline (pixel corners, local px) of `mask` grown by OVERLAP, simplified to at most
 * MAX_POINTS points; the mask is grown by the simplification tolerance too, so the polygon
 * always covers every pixel. Only the piece holding the most pixels is traced.
 */
export function tracePolygon(mask: Uint8Array, W: number, H: number): [number, number][] {
  // Work in a padded box around the mask.
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (maxX < 0) return [];
  for (let tolerance = 0.75; ; tolerance *= 1.5) {
    const grow = OVERLAP + Math.ceil(tolerance);
    const pad = grow + 1;
    const bw = maxX - minX + 1 + 2 * pad;
    const bh = maxY - minY + 1 + 2 * pad;
    const box = new Uint8Array(bw * bh);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) box[(y - minY + pad) * bw + x - minX + pad] = mask[y * W + x]!;
    const grown = dilate(box, bw, bh, grow);
    const biggest = components(grown, bw, bh, 8).sort((a, b) => b.length - a.length)[0]!;
    const only = new Uint8Array(bw * bh);
    for (const i of biggest) only[i] = 1;
    const outline = traceOutline(only, bw, bh);
    const simple = simplifyClosed(outline, tolerance);
    if (simple.length <= MAX_POINTS || tolerance > 64) {
      return simplifyTo(simple, MAX_POINTS).map(([x, y]) => [x + minX - pad, y + minY - pad]);
    }
  }
}

/** Outer boundary of a mask as pixel-corner vertices (clockwise, y down), corners only. */
export function traceOutline(mask: Uint8Array, W: number, H: number): [number, number][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  let start = -1;
  for (let i = 0; i < W * H && start < 0; i++) if (mask[i]) start = i;
  if (start < 0) return [];
  const sx = start % W;
  const sy = (start - sx) / W;
  // Walk the pixel edges with the shape on the right: right, down, left, up.
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const rightPixel = (x: number, y: number, d: number) => (d === 0 ? at(x, y) : d === 1 ? at(x - 1, y) : d === 2 ? at(x - 1, y - 1) : at(x, y - 1));
  const leftPixel = (x: number, y: number, d: number) => (d === 0 ? at(x, y - 1) : d === 1 ? at(x, y) : d === 2 ? at(x - 1, y) : at(x - 1, y - 1));
  const out: [number, number][] = [];
  let x = sx;
  let y = sy;
  let d = 0;
  for (let steps = 0; steps < 4 * W * H + 8; steps++) {
    let next = d;
    for (const turn of [3, 0, 1, 2]) {
      const c = (d + turn) % 4;
      if (rightPixel(x, y, c) && !leftPixel(x, y, c)) {
        next = c;
        break;
      }
    }
    if (next !== d || steps === 0) out.push([x, y]);
    d = next;
    x += DX[d]!;
    y += DY[d]!;
    if (x === sx && y === sy) break;
  }
  return out;
}

/** Douglas-Peucker on a closed polygon. */
export function simplifyClosed(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 4) return points;
  // Split at the point furthest from the first, simplify both halves.
  let far = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i]![0] - points[0]![0], points[i]![1] - points[0]![1]) > Math.hypot(points[far]![0] - points[0]![0], points[far]![1] - points[0]![1])) far = i;
  }
  const a = douglasPeucker(points.slice(0, far + 1), tolerance);
  const b = douglasPeucker([...points.slice(far), points[0]!], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function douglasPeucker(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 2) return points;
  const [ax, ay] = points[0]!;
  const [bx, by] = points[points.length - 1]!;
  const length = Math.hypot(bx - ax, by - ay) || 1e-9;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i]!;
    const d = length < 1e-6 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length;
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance) return [points[0]!, points[points.length - 1]!];
  return [...douglasPeucker(points.slice(0, index + 1), tolerance).slice(0, -1), ...douglasPeucker(points.slice(index), tolerance)];
}

/** At most `max` points: drop the points whose removal changes the area least. */
export function simplifyTo(points: [number, number][], max: number): [number, number][] {
  const out = points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as [number, number]);
  while (out.length > max) {
    let best = 0;
    let bestArea = Infinity;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length]!;
      const b = out[i]!;
      const c = out[(i + 1) % out.length]!;
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    out.splice(best, 1);
  }
  return out;
}

// --- pixel helpers ------------------------------------------------------------------

function rgbAt(data: Uint8Array, i: number): number[] {
  return [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function forNeighbors4(i: number, W: number, H: number, fn: (j: number) => unknown): void {
  const x = i % W;
  if (x > 0) fn(i - 1);
  if (x < W - 1) fn(i + 1);
  if (i >= W) fn(i - W);
  if (i < W * (H - 1)) fn(i + W);
}

function forNeighbors8(i: number, W: number, H: number, fn: (j: number) => unknown): void {
  const x = i % W;
  const y = (i - x) / W;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H) fn(ny * W + nx);
    }
  }
}

function hasNeighbor(i: number, W: number, H: number, test: (j: number) => boolean): boolean {
  let found = false;
  forNeighbors4(i, W, H, (j) => {
    if (test(j)) found = true;
  });
  return found;
}

/** Connected sets of the mask's pixels. */
export function components(mask: Uint8Array, W: number, H: number, connectivity: 4 | 8): number[][] {
  const seen = new Uint8Array(W * H);
  const out: number[][] = [];
  const each = connectivity === 8 ? forNeighbors8 : forNeighbors4;
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    const piece = [s];
    seen[s] = 1;
    for (let q = 0; q < piece.length; q++) {
      each(piece[q]!, W, H, (j) => {
        if (mask[j] && !seen[j]) {
          seen[j] = 1;
          piece.push(j);
        }
      });
    }
    out.push(piece);
  }
  return out;
}

/** Breadth-first: unlabelled solid pixels take the label of the nearest labelled one (through solid pixels). */
function growLabels(label: Int32Array, solid: Uint8Array, W: number, H: number): void {
  const queue: number[] = [];
  for (let i = 0; i < W * H; i++) if (label[i]! >= 0) queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    forNeighbors8(i, W, H, (j) => {
      if (solid[j] && label[j] === -1) {
        label[j] = label[i]!;
        queue.push(j);
      }
    });
  }
}

/** The mask grown by `radius` px (chamfer distance). */
export function dilate(mask: Uint8Array, W: number, H: number, radius: number): Uint8Array {
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? 0 : INF;
  const D = 1;
  const DD = Math.SQRT2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x > 0) d[i] = Math.min(d[i]!, d[i - 1]! + D);
      if (y > 0) {
        d[i] = Math.min(d[i]!, d[i - W]! + D);
        if (x > 0) d[i] = Math.min(d[i]!, d[i - W - 1]! + DD);
        if (x < W - 1) d[i] = Math.min(d[i]!, d[i - W + 1]! + DD);
      }
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (x < W - 1) d[i] = Math.min(d[i]!, d[i + 1]! + D);
      if (y < H - 1) {
        d[i] = Math.min(d[i]!, d[i + W]! + D);
        if (x < W - 1) d[i] = Math.min(d[i]!, d[i + W + 1]! + DD);
        if (x > 0) d[i] = Math.min(d[i]!, d[i + W - 1]! + DD);
      }
    }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = d[i]! <= radius ? 1 : 0;
  return out;
}

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonArea(polygon: [number, number][]): number {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) area += (polygon[j]![0] + polygon[i]![0]) * (polygon[j]![1] - polygon[i]![1]);
  return area / 2;
}

function centroid(polygon: [number, number][]): [number, number] {
  const n = polygon.length;
  return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n];
}

function meanColor(data: Uint8Array, pixels: number[]): string {
  const sum = [0, 0, 0];
  for (const i of pixels) for (let c = 0; c < 3; c++) sum[c]! += data[i * 4 + c]!;
  return `#${sum.map((s) => clamp255(s / Math.max(1, pixels.length)).toString(16).padStart(2, "0")).join("")}`;
}
