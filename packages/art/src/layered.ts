import { Rig, MAX_PARTS, type Bone, type CharacterAsset, type FileRef, type Part } from "@anomaly/core";
import { components, isolateFigure, jointPivots, labelParts, tracePolygon, type Cutout, type CutoutPlan } from "./cutout.ts";
import { decodePng, encodePng, type Pixels } from "./match.ts";
import { cleanPolygon, convexHull, densify, isSimple, outlineDistance, pointInPolygon, polygonArea, triangulate, untangle, type Vec } from "./mesh.ts";
import { layerPaintPrompt, isRigReadySheet } from "./prompts.ts";
import { sheetCell, StageError, type ArtContext } from "./stages.ts";
import { applySim, explode, figureMask, packAtlas, refinePiece, registerMasks, resizePremultiplied, sample, type Atlas, type PartBake, type Similarity } from "./texture.ts";
import { distanceTo } from "./traced.ts";

/**
 * Layered rigs (rig mode "layered", rig round 6): the proven 2D route (Spine, Live2D, Animated
 * Drawings). The design is split into part layers at its own full resolution (the concept sheet's
 * cell, not the 512 px pick), the stretches each part hides behind the parts in front are painted
 * in (one image edit per character: the layers pulled apart, the hidden stretches marked, the
 * paint mapped back per layer; the visible pixels stay the design's own), and each layer is drawn
 * on a triangle mesh that bends between its bone and its parent's, so joints bend instead of
 * hinging.
 *
 * Spaces: "native" px are the full-resolution design's (a Cutout of it: cut-local px plus the
 * cut's offset); "canvas" px are the 512 px design the plan, critique and match work in
 * (canvas = native / k). Mesh vertices are canvas px (the rig, mapped to rig space by the
 * stage's frame); uv are atlas px (the layers at native resolution, packed).
 */

/** The most an atlas can be a side: mesh uv are rig Points (|v| <= 1000). */
export const LAYER_ATLAS_MAX = 1000;
/** Hidden pixels a layer may take: within this share of the figure's height of its own pixels. */
const REACH = 0.25;
/** A design pixel this opaque is inside the figure (hidden pixels never touch the soft outer edge). */
const INTERIOR_ALPHA = 250;
/** Interior points per mesh, roughly (before the denser points near joints). */
const GRID_POINTS = 140;
const MAX_INNER = 256;
const MAX_OUTLINE = 128;
const MAX_TRIANGLES = 768;
const MAGENTA: [number, number, number] = [255, 0, 255];
const BACKGROUND: [number, number, number] = [216, 214, 207];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const r2 = (n: number) => Math.round(n * 100) / 100;

// --- the design at its own resolution ----------------------------------------------------------

/** Luminance on a coarse grid (transparent pixels as mid grey), for comparing two framings of one picture. */
function coarseLuminance(img: Pixels, n = 48): Float32Array {
  const small = resizePremultiplied(img, n, n);
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const a = small.data[i * 4 + 3]! / 255;
    out[i] = (0.2126 * small.data[i * 4]! + 0.7152 * small.data[i * 4 + 1]! + 0.0722 * small.data[i * 4 + 2]!) * a + 128 * (1 - a);
  }
  return out;
}

function correlation(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) (ma += a[i]!), (mb += b[i]!);
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i]! - ma) * (b[i]! - mb);
    aa += (a[i]! - ma) ** 2;
    bb += (b[i]! - mb) ** 2;
  }
  return aa <= 1e-9 || bb <= 1e-9 ? 0 : ab / Math.sqrt(aa * bb);
}

export function mirrored(img: Pixels): Pixels {
  const { width: W, height: H } = img;
  const data = new Uint8Array(img.data.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * W + (W - 1 - x)) * 4);
  return { width: W, height: H, data };
}

export interface NativeDesign {
  /** The design at the sheet's own resolution (facing right, like the chosen design). */
  image: Pixels;
  /** Native px per canvas (chosen design) px; 1 when the design is used as it is. */
  k: number;
  note: string;
}

/** Below this the sheet's cell and the chosen design are not the same picture (use the chosen one). */
const SAME_PICTURE = 0.75;

/**
 * The chosen design at the concept sheet's own resolution: its sheet cell cropped without the
 * 512 px cap, mirrored when the chosen design was (it faces right), and only its main figure when
 * the sheet was drawn rig-ready (like the choose stage does). Falls back to the chosen design
 * itself when the sheet is no bigger or the crop isn't the same picture.
 */
export async function nativeDesign(ctx: Pick<ArtContext, "files" | "renderer">, asset: CharacterAsset, design: Pixels): Promise<NativeDesign> {
  const same = (note: string): NativeDesign => ({ image: design, k: 1, note });
  const chosen = asset.chosen;
  const sheet = chosen ? asset.concepts[chosen.sheet] : undefined;
  if (!chosen || !sheet) return same("no concept sheet: the chosen design as it is");
  let native: Pixels;
  try {
    native = decodePng(await ctx.renderer.crop(await ctx.files.get(sheet.file), sheetCell(chosen.cell), 4096));
  } catch (error) {
    return same(`the sheet could not be cropped (${error instanceof Error ? error.message : String(error)})`);
  }
  if (native.width < design.width * 1.1) return same(`the sheet's cell is ${native.width} px: the chosen design as it is`);
  const ref = coarseLuminance(design);
  const plain = correlation(coarseLuminance(native), ref);
  const flipped = correlation(coarseLuminance(mirrored(native)), ref);
  if (Math.max(plain, flipped) < SAME_PICTURE) return same(`the sheet's cell doesn't match the chosen design (${Math.round(Math.max(plain, flipped) * 100)}%)`);
  if (flipped > plain) native = mirrored(native);
  if (isRigReadySheet(sheet.prompt)) native = isolateFigure(native)?.image ?? native;
  const k = native.width / design.width;
  return { image: native, k, note: `the design at ${native.width}x${native.height} px (${k.toFixed(2)}x the chosen design)` };
}

/** A plan (canvas px) scaled to native px. */
export function scalePlan(plan: CutoutPlan, k: number): CutoutPlan {
  const p = (q: readonly [number, number]): [number, number] => [q[0] * k, q[1] * k];
  return {
    ...plan,
    bones: plan.bones.map((b) => ({ ...b, pivot: p(b.pivot) })),
    parts: plan.parts.map((part) => ({ ...part, region: part.region.map(p) })),
    ...(plan.features ? { features: plan.features.map(p) } : {}),
  };
}

// --- layers: which pixels each part shows and may take -----------------------------------------

/** Pixel bookkeeping for a plan on a cutout (cut-local px). */
export interface LayerPlan {
  W: number;
  H: number;
  /** Plan part per pixel (-1: background). */
  label: Int32Array;
  /** Bones with joint-aware pivots (the cut's concept px). */
  bones: Bone[];
  /** Draw order position per plan part (z, then plan order). */
  rank: number[];
  /** Per plan part: the design's pixels it shows. */
  vis: Uint8Array[];
  /** Per plan part: pixels hidden behind parts on other bones in front of it, near enough to take. */
  hidden: Uint8Array[];
  /** Per plan part: hidden pixels it always fills (a ring along its edge and around its joints). */
  must: Uint8Array[];
  /** Overlap ring width (px). */
  ring: number;
  figureHeight: number;
}

/** The bone a part bends toward: its bone's nearest ancestor that moves some part (undefined at the root). */
function bendBone(plan: CutoutPlan, bone: string): string | undefined {
  const parent = new Map(plan.bones.map((b) => [b.id, b.parent]));
  const used = new Set(plan.parts.map((p) => p.bone));
  for (let up = parent.get(bone) ?? null; up !== null; up = parent.get(up) ?? null) if (used.has(up)) return up;
  return undefined;
}

/** Joint pivots that matter to a part (its own bone's, its child bones'), in cut-local px. */
function partJoints(plan: CutoutPlan, bones: Bone[], k: number, offset: [number, number]): [number, number][] {
  const bone = bones.find((b) => b.id === plan.parts[k]!.bone)!;
  const own = bone.parent !== null ? [bone.pivot] : [];
  const kids = bones.filter((b) => b.parent === bone.id).map((b) => b.pivot);
  return [...own, ...kids].map((p) => [p[0] - offset[0], p[1] - offset[1]]);
}

export function planLayers(cut: Cutout, plan: CutoutPlan): LayerPlan {
  const { width: W, height: H, data } = cut.image;
  const label = labelParts(cut, plan);
  const bones = jointPivots(cut, plan, label);
  const n = plan.parts.length;
  const order = plan.parts.map((_, k) => k).sort((a, b) => plan.parts[a]!.z - plan.parts[b]!.z || a - b);
  const rank: number[] = [];
  order.forEach((k, r) => (rank[k] = r));
  const boneOf = plan.parts.map((p) => p.bone);
  const figureHeight = Math.max(1, cut.bounds.maxY - cut.bounds.minY);
  const reach = Math.max(4, Math.round(figureHeight * REACH));
  const ring = Math.max(2, Math.round(figureHeight * 0.006));
  const vis: Uint8Array[] = [];
  const hidden: Uint8Array[] = [];
  const must: Uint8Array[] = [];
  for (let k = 0; k < n; k++) {
    const v = new Uint8Array(W * H);
    let count = 0;
    let [x0, y0, x1, y1] = [W, H, -1, -1];
    for (let i = 0; i < W * H; i++)
      if (label[i] === k) {
        v[i] = 1;
        count++;
        const x = i % W;
        const y = (i - x) / W;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    vis.push(v);
    const h = new Uint8Array(W * H);
    const m = new Uint8Array(W * H);
    hidden.push(h);
    must.push(m);
    if (count === 0) continue;
    const dist = distanceTo(v, W, H);
    const thickness = count / Math.max(1, x1 - x0 + 1, y1 - y0 + 1);
    const jr = Math.max(2 * ring, Math.min(0.12 * figureHeight, 0.75 * thickness));
    const joints = partJoints(plan, bones, k, cut.offset).filter(([px, py]) => {
      const ix = Math.max(0, Math.min(W - 1, Math.floor(px)));
      const iy = Math.max(0, Math.min(H - 1, Math.floor(py)));
      return dist[iy * W + ix]! <= jr;
    });
    for (let i = 0; i < W * H; i++) {
      const l = label[i]!;
      if (l < 0 || boneOf[l] === boneOf[k] || rank[l]! <= rank[k]! || data[i * 4 + 3]! < INTERIOR_ALPHA || dist[i]! > reach) continue;
      h[i] = 1;
      const x = (i % W) + 0.5;
      const y = Math.floor(i / W) + 0.5;
      if (dist[i]! <= ring || joints.some(([px, py]) => Math.hypot(x - px, y - py) <= jr)) m[i] = 1;
    }
  }
  return { W, H, label, bones, rank, vis, hidden, must, ring, figureHeight };
}

/** Paint for a hidden pixel of a part (cut-local px centre), or null where the painting has none. */
export type PaintLookup = (part: number, x: number, y: number) => [number, number, number] | null;

/** One part's finished layer: its pixels (design where it shows, paint or extension where hidden). */
export interface Layer {
  part: number;
  /** Cut-local px of the image's top-left. */
  x: number;
  y: number;
  image: Pixels;
  /** 1 where the pixel is the design's own. */
  visible: Uint8Array;
  /** Hidden pixels filled from the painting / by extending the edge colours. */
  painted: number;
  extended: number;
}

/**
 * A part's layer: the design's own pixels where it shows; hidden pixels the painting covers (when
 * given); the rest of its edge ring and joint disks by the nearest edge colour. Fills that don't
 * connect to the part are dropped.
 */
export function fillLayer(cut: Cutout, lp: LayerPlan, k: number, paint?: PaintLookup): Layer | null {
  const { W, H } = lp;
  const vis = lp.vis[k]!;
  const hidden = lp.hidden[k]!;
  const must = lp.must[k]!;
  let [x0, y0, x1, y1] = [W, H, -1, -1];
  for (let i = 0; i < W * H; i++)
    if (vis[i] || hidden[i]) {
      const x = i % W;
      const y = (i - x) / W;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8Array(w * h * 4);
  const visible = new Uint8Array(w * h);
  const set = new Uint8Array(w * h); // 1 design, 2 painted, 3 extended
  const src = cut.image.data;
  const queue: number[] = [];
  const from = new Int32Array(w * h).fill(-1);
  const dist = new Float32Array(w * h).fill(Infinity);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gi = (y + y0) * W + x + x0;
      const i = y * w + x;
      if (vis[gi]) {
        data.set(src.subarray(gi * 4, gi * 4 + 4), i * 4);
        visible[i] = 1;
        set[i] = 1;
        if (src[gi * 4 + 3]! >= 200) {
          from[i] = i;
          dist[i] = 0;
          queue.push(i);
        }
      } else if (hidden[gi] && paint) {
        const c = paint(k, x + x0 + 0.5, y + y0 + 0.5);
        if (c) {
          data.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], i * 4);
          set[i] = 2;
          from[i] = i;
          dist[i] = 0;
          queue.push(i);
        }
      }
    }
  // Nearest known colour over the hidden pixels (through them), kept where the part must cover.
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (set[j] || !hidden[(ny + y0) * W + nx + x0]) continue;
        const d = dist[i]! + (dx && dy ? Math.SQRT2 : 1);
        if (d < dist[j]!) {
          dist[j] = d;
          from[j] = from[i]!;
          queue.push(j);
        }
      }
  }
  for (let i = 0; i < w * h; i++) {
    if (set[i] || from[i]! < 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (!must[(y + y0) * W + x + x0]) continue;
    data.set(data.subarray(from[i]! * 4, from[i]! * 4 + 3), i * 4);
    data[i * 4 + 3] = 255;
    set[i] = 3;
  }
  // Only fills that connect to the part's own pixels.
  const reached = new Uint8Array(w * h);
  const walk: number[] = [];
  for (let i = 0; i < w * h; i++) if (set[i] === 1) (reached[i] = 1), walk.push(i);
  for (let head = 0; head < walk.length; head++) {
    const i = walk[head]!;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (set[j] && !reached[j]) (reached[j] = 1), walk.push(j);
      }
  }
  let painted = 0;
  let extended = 0;
  for (let i = 0; i < w * h; i++) {
    if (set[i]! > 1 && !reached[i]) data.fill(0, i * 4, i * 4 + 4);
    else if (set[i] === 2) painted++;
    else if (set[i] === 3) extended++;
  }
  return { part: k, x: x0, y: y0, image: { width: w, height: h, data }, visible, painted, extended };
}

// --- meshes ------------------------------------------------------------------------------------

/** A mesh in native (cut-local) px: outline, interior points, triangles, and weights toward its bendTo bone. */
export interface LayerMesh {
  points: Vec[];
  inner: Vec[];
  triangles: number[];
  weights?: number[];
}

/**
 * How a part's vertices weigh toward the bone it bends to: a smooth falloff across the pivot along
 * the part's axis, from all-parent half a blend-width behind it to all-own one and a half in front
 * (leaning into the part, so the seam with the parent stays nearly shut while the part bends).
 */
export interface JointBlend {
  pivot: Vec;
  /** Unit vector from the pivot into the part. */
  axis: Vec;
  /** Half-width of the blend across the pivot (px). */
  r: number;
  /** Past this distance from the pivot (plus r), the part follows its own bone only. */
  reach: number;
}

export function blendWeight(b: JointBlend, v: Vec): number {
  const dx = v[0] - b.pivot[0];
  const dy = v[1] - b.pivot[1];
  const along = dx * b.axis[0] + dy * b.axis[1];
  const w = (1 - smoothstep(-0.5 * b.r, 1.5 * b.r, along)) * (1 - smoothstep(b.reach, b.reach + b.r, Math.hypot(dx, dy)));
  return Math.round(w * 1000) / 1000;
}

/** The blend for a part at its bone's pivot: across about half the part's thickness, never more than a third of its length. */
export function jointBlend(lp: LayerPlan, k: number, pivot: Vec): JointBlend | null {
  const { W, H } = lp;
  const vis = lp.vis[k]!;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < W * H; i++) if (vis[i]) (sx += i % W), (sy += Math.floor(i / W)), n++;
  if (n === 0) return null;
  let ax = sx / n + 0.5 - pivot[0];
  let ay = sy / n + 0.5 - pivot[1];
  const len = Math.hypot(ax, ay);
  if (len < 1e-6) (ax = 0), (ay = 1);
  else (ax /= len), (ay /= len);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < W * H; i++)
    if (vis[i]) {
      const d = (i % W) + 0.5 - pivot[0];
      const e = Math.floor(i / W) + 0.5 - pivot[1];
      const along = d * ax + e * ay;
      lo = Math.min(lo, along);
      hi = Math.max(hi, along);
    }
  const length = Math.max(1, hi - lo);
  const thickness = n / length;
  const r = Math.max(2 * lp.ring, Math.min(0.5 * thickness, 0.3 * length));
  return { pivot, axis: [ax, ay], r, reach: Math.max(thickness, 2 * r) };
}

/** Grid spacing for a mesh of this area (px). */
const spacingFor = (area: number) => Math.max(3, Math.sqrt(area / GRID_POINTS));

/**
 * A mesh over one connected piece of a layer (mask in its own w x h, px): the outline traced
 * around its pixels (grown a little, at most 128 points, made simple), interior points on a
 * staggered grid (twice as dense within reach of the joints), triangulated inside the outline.
 */
export function meshPiece(mask: Uint8Array, w: number, h: number, joints: { at: Vec; radius: number }[]): Omit<LayerMesh, "weights"> {
  let poly = cleanPolygon(tracePolygon(mask, w, h) as Vec[]);
  if (!isSimple(poly)) poly = cleanPolygon(untangle(poly));
  if (!isSimple(poly)) poly = cleanPolygon(convexHull(poly));
  const area = Math.abs(polygonArea(poly));
  let s = spacingFor(area);
  // Outline points about as close as the grid's (closer near the joints), within the 128 a mesh may have.
  for (let f = 1; f < 64; f *= 1.25) {
    const nearJoint = (p: Vec) => joints.some((j) => Math.hypot(p[0] - j.at[0], p[1] - j.at[1]) <= j.radius);
    const dense = densify(poly, (mid) => f * (nearJoint(mid) ? 0.6 * s : 1.2 * s));
    if (dense.length <= MAX_OUTLINE) {
      if (isSimple(dense)) poly = dense;
      break;
    }
  }
  for (let attempt = 0; attempt < 30; attempt++, s *= 1.15) {
    const inner = gridPoints(poly, s, joints);
    if (inner.length > MAX_INNER) continue;
    const mesh = triangulate(poly, inner);
    if (mesh.triangles.length / 3 > MAX_TRIANGLES) continue;
    return mesh;
  }
  return triangulate(poly, []);
}

function gridPoints(poly: Vec[], s: number, joints: { at: Vec; radius: number }[]): Vec[] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of poly) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  const out: Vec[] = [];
  const cell = s * 0.45;
  const buckets = new Map<string, Vec[]>();
  const near = (p: Vec, d: number) => {
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    const reach = Math.ceil(d / cell);
    for (let gy = cy - reach; gy <= cy + reach; gy++)
      for (let gx = cx - reach; gx <= cx + reach; gx++) for (const q of buckets.get(`${gx},${gy}`) ?? []) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < d) return true;
    return false;
  };
  const tryAdd = (p: Vec, spacing: number) => {
    if (!pointInPolygon(p[0], p[1], poly) || outlineDistance(p, poly) < 0.45 * spacing || near(p, 0.45 * spacing)) return;
    const q: Vec = [r2(p[0]), r2(p[1])];
    out.push(q);
    const key = `${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), q]);
  };
  // Denser near the joints first (they win the spacing checks), then the staggered grid.
  for (const j of joints) {
    const f = s / 2;
    for (let y = j.at[1] - j.radius; y <= j.at[1] + j.radius; y += f * 0.866)
      for (let x = j.at[0] - j.radius + ((Math.round((y - j.at[1]) / (f * 0.866)) & 1) * f) / 2; x <= j.at[0] + j.radius; x += f)
        if (Math.hypot(x - j.at[0], y - j.at[1]) <= j.radius) tryAdd([x, y], f);
  }
  let row = 0;
  for (let y = y0 + s / 2; y < y1; y += s * 0.866, row++) for (let x = x0 + s / 2 + ((row & 1) * s) / 2; x < x1; x += s) tryAdd([x, y], s);
  return out;
}

// --- the layered rig ---------------------------------------------------------------------------

export interface LayeredPiece {
  /** Index into the rig's parts. */
  index: number;
  /** Plan part. */
  part: number;
  /** The mesh in native cut-local px. */
  mesh: LayerMesh;
  /** Its texture box (native cut-local px) and atlas region. */
  box: { x: number; y: number; width: number; height: number };
  region: [number, number, number, number];
}

export interface LayeredBuild {
  /** The rig in canvas px for a texture file (the atlas, stored by the caller). */
  rigFor(file: FileRef): Rig;
  atlas: Atlas;
  /** Bones in canvas px (joint-aware pivots). */
  bones: Bone[];
  layers: Layer[];
  pieces: LayeredPiece[];
  lp: LayerPlan;
  warnings: string[];
}

/** Transparent texels next to opaque ones take their colour, alpha staying 0 (so filtering at a layer's edge doesn't darken it). */
function bleed(img: Pixels, passes = 2): void {
  const { width: w, height: h, data } = img;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = data[i * 4 + 3]! > 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const added: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let [r, g, b, n] = [0, 0, 0, 0];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!known[j]) continue;
            r += data[j * 4]!;
            g += data[j * 4 + 1]!;
            b += data[j * 4 + 2]!;
            n++;
          }
        if (n > 0) {
          data.set([Math.round(r / n), Math.round(g / n), Math.round(b / n), 0], i * 4);
          added.push(i);
        }
      }
    for (const i of added) known[i] = 1;
  }
}

function meanVisible(layer: Layer, piece: Uint8Array): string {
  let [r, g, b, n] = [0, 0, 0, 0];
  const d = layer.image.data;
  for (let i = 0; i < layer.visible.length; i++)
    if (layer.visible[i] && piece[i] && d[i * 4 + 3]! >= 128) {
      r += d[i * 4]!;
      g += d[i * 4 + 1]!;
      b += d[i * 4 + 2]!;
      n++;
    }
  if (n === 0) return "#808080";
  return `#${[r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The layered rig for a plan (canvas px) on the full-resolution cutout (`k` native px per canvas
 * px): layers filled (with `paint` where given), one mesh per connected piece of each layer,
 * textures packed into one atlas at native resolution (shrunk only to fit LAYER_ATLAS_MAX).
 */
export function buildLayered(native: Cutout, plan: CutoutPlan, k: number, paint?: PaintLookup): LayeredBuild {
  const warnings: string[] = [];
  const nativePlan = scalePlan(plan, k);
  const lp = planLayers(native, nativePlan);
  const [ox, oy] = native.offset;
  const toCanvas = ([x, y]: Vec): Vec => [r2((x + ox) / k), r2((y + oy) / k)];
  const bones: Bone[] = lp.bones.map((b) => ({ ...b, pivot: [r2(b.pivot[0] / k), r2(b.pivot[1] / k)] }));
  const order = plan.parts.map((_, i) => i).sort((a, b) => lp.rank[a]! - lp.rank[b]!);
  const layers: Layer[] = [];
  const bakes: PartBake[] = [];
  const specs: { part: number; id: string; mesh: LayerMesh; box: LayeredPiece["box"]; fill: string; bendTo?: string }[] = [];
  const ids = new Set<string>();
  for (const k2 of order) {
    const spec = plan.parts[k2]!;
    const layer = fillLayer(native, lp, k2, paint);
    if (!layer) {
      warnings.push(`part "${spec.id}" covers no pixels (dropped)`);
      continue;
    }
    layers.push(layer);
    const { width: w, height: h, data } = layer.image;
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) solid[i] = data[i * 4 + 3]! > 0 ? 1 : 0;
    const pieces = components(solid, w, h, 8)
      .filter((piece) => piece.filter((i) => layer.visible[i]).length >= 6)
      .sort((a, b) => b.length - a.length);
    const bendTo = bendBone(plan, spec.bone);
    const bonePivot = lp.bones.find((b) => b.id === spec.bone)!.pivot;
    const pivot: Vec = [bonePivot[0] - ox, bonePivot[1] - oy];
    const blend = bendTo ? jointBlend(lp, k2, pivot) : null;
    const jointRadius = blend ? blend.reach + blend.r : 0;
    const joints = partJoints(nativePlan, lp.bones, k2, native.offset).map((at) => ({ at: [at[0] - layer.x, at[1] - layer.y] as Vec, radius: Math.max(jointRadius, 6 * lp.ring) }));
    pieces.forEach((piece, n) => {
      const mask = new Uint8Array(w * h);
      for (const i of piece) mask[i] = 1;
      const local = meshPiece(mask, w, h, joints);
      if (local.triangles.length < 3) {
        warnings.push(`a piece of "${spec.id}" could not be meshed (dropped)`);
        return;
      }
      const shift = (p: Vec): Vec => [p[0] + layer.x, p[1] + layer.y];
      const mesh: LayerMesh = { points: local.points.map(shift), inner: local.inner.map(shift), triangles: local.triangles };
      if (blend) mesh.weights = [...mesh.points, ...mesh.inner].map((v) => blendWeight(blend, v));
      // Its texture: the piece's pixels in a box around its outline (cut-local px).
      let [bx0, by0, bx1, by1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of [...mesh.points, ...mesh.inner]) (bx0 = Math.min(bx0, x)), (by0 = Math.min(by0, y)), (bx1 = Math.max(bx1, x)), (by1 = Math.max(by1, y));
      const box = { x: Math.floor(bx0) - 1, y: Math.floor(by0) - 1, width: Math.ceil(bx1) - Math.floor(bx0) + 2, height: Math.ceil(by1) - Math.floor(by0) + 2 };
      const tex = new Uint8Array(box.width * box.height * 4);
      for (let y = 0; y < box.height; y++)
        for (let x = 0; x < box.width; x++) {
          const lx = box.x + x - layer.x;
          const ly = box.y + y - layer.y;
          if (lx < 0 || ly < 0 || lx >= w || ly >= h || !mask[ly * w + lx]) continue;
          tex.set(data.subarray((ly * w + lx) * 4, (ly * w + lx) * 4 + 4), (y * box.width + x) * 4);
        }
      const image = { width: box.width, height: box.height, data: tex };
      bleed(image);
      let id = n === 0 ? spec.id : `${spec.id}_${n + 1}`;
      while (ids.has(id)) id = `${id}_x`;
      ids.add(id);
      bakes.push({ part: specs.length, box, image, coverage: 1 });
      specs.push({ part: k2, id, mesh, box, fill: meanVisible(layer, mask), ...(bendTo ? { bendTo } : {}) });
    });
  }
  if (specs.length > MAX_PARTS) {
    warnings.push(`too many pieces (${specs.length}); kept the ${MAX_PARTS} biggest`);
    const keep = new Set(specs.map((s, i) => [i, s.box.width * s.box.height]).sort((a, b) => b[1]! - a[1]!).slice(0, MAX_PARTS).map(([i]) => i));
    for (let i = specs.length - 1; i >= 0; i--) if (!keep.has(i)) (specs.splice(i, 1), bakes.splice(i, 1));
    bakes.forEach((b, i) => (b.part = i));
  }
  if (specs.length === 0) throw new StageError("the layered rig has no parts (the plan's regions miss the character)");
  const atlas = packAtlas(bakes, LAYER_ATLAS_MAX);
  if (atlas.scale < 1) warnings.push(`the layers were shrunk to ${Math.round(atlas.scale * 100)}% to fit a ${LAYER_ATLAS_MAX} px atlas`);
  const pieces: LayeredPiece[] = specs.map((s, i) => ({ index: i, part: s.part, mesh: s.mesh, box: s.box, region: atlas.regions[i]!.uv }));
  const uvOf = (piece: LayeredPiece, [x, y]: Vec): Vec => {
    const [ax, ay, aw, ah] = piece.region;
    return [r2(ax + ((x - piece.box.x) * aw) / piece.box.width), r2(ay + ((y - piece.box.y) * ah) / piece.box.height)];
  };
  const rigFor = (file: FileRef): Rig => {
    const parts: Part[] = specs.map((s, i) => {
      const piece = pieces[i]!;
      const points = s.mesh.points.map(toCanvas);
      const inner = s.mesh.inner.map(toCanvas);
      const all = [...points, ...inner];
      const xs = all.map((p) => p[0]);
      const ys = all.map((p) => p[1]);
      const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
      return {
        id: s.id,
        bone: plan.parts[s.part]!.bone,
        ...(s.bendTo ? { bendTo: s.bendTo } : {}),
        z: plan.parts[s.part]!.z,
        shape: {
          type: "mesh",
          points,
          inner,
          triangles: s.mesh.triangles,
          uv: [...s.mesh.points, ...s.mesh.inner].map((v) => uvOf(piece, v)),
          ...(s.mesh.weights ? { weights: s.mesh.weights } : {}),
        },
        fill: s.fill,
        ink: 0,
        glow: false,
        opacity: 1,
        // The whole atlas, so a vertex's uv is atlas px however a renderer reads it.
        texture: { file, rect: [minX, minY, Math.max(0.01, r2(Math.max(...xs) - minX)), Math.max(0.01, r2(Math.max(...ys) - minY))], uv: [0, 0, atlas.image.width, atlas.image.height], opacity: 1 },
      };
    });
    return Rig.parse({ mode: "layered", bones, parts });
  };
  return { rigFor, atlas, bones, layers, pieces, lp, warnings };
}

// --- painting in what each part hides ------------------------------------------------------------

export interface PaintResult {
  lookup: PaintLookup;
  /** The layers pulled apart with their hidden stretches marked (sent), and the painting (back, at the sent size). */
  sent: Buffer;
  painted: Buffer;
  /** How well the painting lines up with what was sent (0-1 overlap of the visible pieces). */
  registration: number;
  cost: number;
  model: string;
}

/** The painting lines up worse than this: it is not used. */
const PAINT_MIN_OVERLAP = 0.5;
/** Gap between pulled-apart groups (share of the design's size). */
const LAYOUT_GAP = 0.03;

const isMagenta = (r: number, g: number, b: number) => r > 150 && b > 150 && g < 110 && Math.abs(r - b) < 90;

/** Downsample a mask by an integer factor (a cell is set when any of its pixels is). */
function shrinkAny(mask: Uint8Array, W: number, H: number, f: number): Uint8Array {
  const w = Math.floor(W / f);
  const h = Math.floor(H / f);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h * f; y++) for (let x = 0; x < w * f; x++) if (mask[y * W + x]) out[Math.floor(y / f) * w + Math.floor(x / f)] = 1;
  return out;
}

/** Resample to exactly W x H (area average down, bilinear up). */
export function resample(img: Pixels, W: number, H: number): Pixels {
  if (img.width === W && img.height === H) return img;
  if (img.width >= W && img.height >= H) return resizePremultiplied(img, W, H);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = sample(img, ((x + 0.5) * img.width) / W, ((y + 0.5) * img.height) / H);
      if (c) data.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3])], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
}

/** Per channel: design = gain * paint + offset, fitted over a group's visible pixels (so the paint matches what shows next to it). */
interface ColorFit {
  gain: number[];
  offset: number[];
}

function fitColors(pairs: { paint: number[]; design: number[] }[]): ColorFit {
  const identity = { gain: [1, 1, 1], offset: [0, 0, 0] };
  if (pairs.length < 32) return identity;
  const gain: number[] = [];
  const offset: number[] = [];
  for (let c = 0; c < 3; c++) {
    const xs = pairs.map((p) => p.paint[c]!);
    const ys = pairs.map((p) => p.design[c]!);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < xs.length; i++) (sxy += (xs[i]! - mx) * (ys[i]! - my)), (sxx += (xs[i]! - mx) ** 2);
    const g = sxx < 1 ? 1 : Math.max(0.6, Math.min(1.6, sxy / sxx));
    gain.push(g);
    offset.push(Math.max(-80, Math.min(80, my - g * mx)));
  }
  return { gain, offset };
}

/**
 * One image edit paints in what each part hides: the parts on each bone are pulled apart (nothing
 * overlaps), each shown as the design draws it with its hidden stretches in magenta, and the image
 * model paints the magenta as the part continuing there, in the design's style. The painting is
 * lined up with what was sent (as a whole, then per group) and colour-matched per group to the
 * design's own pixels next to it. Null when the painting doesn't line up.
 */
export async function paintHidden(
  ctx: ArtContext,
  input: { native: Cutout; plan: CutoutPlan; k: number; brief: string; design: Buffer; object?: boolean },
): Promise<PaintResult | null> {
  const { native } = input;
  const nativePlan = scalePlan(input.plan, input.k);
  const lp = planLayers(native, nativePlan);
  const { W, H, label } = lp;
  const src = native.image.data;
  const bonesUsed = [...new Set(nativePlan.parts.map((p) => p.bone))];
  const groupOfBone = new Map(bonesUsed.map((b, g) => [b, g]));
  const groupOf = nativePlan.parts.map((p) => groupOfBone.get(p.bone)!);
  const G = bonesUsed.length;
  // Each group's zone: what it shows and what it may take.
  const zone = Array.from({ length: G }, () => new Uint8Array(W * H));
  nativePlan.parts.forEach((_, k) => {
    const z = zone[groupOf[k]!]!;
    const v = lp.vis[k]!;
    const h = lp.hidden[k]!;
    for (let i = 0; i < W * H; i++) if (v[i] || h[i]) z[i] = 1;
  });
  if (!lp.hidden.some((h) => h.some((v) => v))) return null;
  // Pull the groups apart on small masks.
  const f = Math.max(1, Math.ceil(Math.max(W, H) / 256));
  const sw = Math.floor(W / f);
  const sh = Math.floor(H / f);
  const offsets = explode(zone.map((z) => shrinkAny(z, W, H, f)), sw, sh, Math.max(2, Math.round((LAYOUT_GAP * Math.max(W, H)) / f))).map(([x, y]) => [x * f, y * f] as Vec);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  zone.forEach((z, g) => {
    for (let i = 0; i < W * H; i++)
      if (z[i]) {
        const x = (i % W) + offsets[g]![0];
        const y = Math.floor(i / W) + offsets[g]![1];
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x + 1);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y + 1);
      }
  });
  const extent = Math.max(x1 - x0, y1 - y0, 1);
  const P = Math.max(1024, Math.min(2048, Math.round(extent / 0.84 / 256) * 256));
  const ps = (0.84 * P) / extent;
  const toLayout: Similarity = { s: ps, tx: P / 2 - ((x0 + x1) / 2) * ps, ty: P / 2 - ((y0 + y1) / 2) * ps };
  // The layout: each group's own pixels over the background, its hidden stretches magenta.
  const layout = new Uint8Array(P * P * 4);
  const owner = new Int16Array(P * P).fill(-1);
  const shown = new Uint8Array(P * P);
  const groupShown = Array.from({ length: G }, () => new Uint8Array(P * P));
  for (let y = 0; y < P; y++)
    for (let x = 0; x < P; x++) {
      const o = y * P + x;
      layout.set([...BACKGROUND, 255], o * 4);
      const qx = (x + 0.5 - toLayout.tx) / ps;
      const qy = (y + 0.5 - toLayout.ty) / ps;
      for (let g = 0; g < G; g++) {
        const lx = Math.floor(qx - offsets[g]![0]);
        const ly = Math.floor(qy - offsets[g]![1]);
        if (lx < 0 || ly < 0 || lx >= W || ly >= H) continue;
        const i = ly * W + lx;
        if (!zone[g]![i]) continue;
        owner[o] = g;
        if (!(label[i]! >= 0 && groupOf[label[i]!] === g)) layout.set([...MAGENTA, 255], o * 4);
        else {
          const a = src[i * 4 + 3]! / 255;
          for (let c = 0; c < 3; c++) layout[o * 4 + c] = Math.round(src[i * 4 + c]! * a + BACKGROUND[c]! * (1 - a));
          if (a >= 0.5) (shown[o] = 1), (groupShown[g]![o] = 1);
        }
        break;
      }
    }
  const sent = encodePng({ width: P, height: P, data: layout });
  if (ctx.signal?.aborted) throw new StageError("cancelled");
  const generated = await ctx.image.generate({ prompt: layerPaintPrompt(input.brief, input.object ?? false), references: [sent, input.design], signal: ctx.signal });
  ctx.spend(generated.usage);
  ctx.log({ text: `painting in what the parts hide (${generated.model})`, cost: generated.usage.cost });
  const png = generated.image[0] === 0x89 && generated.image[1] === 0x50 ? generated.image : await ctx.renderer.crop(generated.image, { x: 0, y: 0, width: 1, height: 1 }, 4096);
  const painting = resample(decodePng(png), P, P);
  const pd = painting.data;
  const fg = figureMask(painting);
  for (let i = 0; i < P * P; i++) if (fg[i] && isMagenta(pd[i * 4]!, pd[i * 4 + 1]!, pd[i * 4 + 2]!)) fg[i] = 0;
  const global = registerMasks(shown, P, P, fg, P, P, { scaleRange: 0.08, shiftRange: Math.round(P * 0.05), start: { s: 1, tx: 0, ty: 0 } });
  ctx.log({ text: `the painting lines up with the layers at ${Math.round(global.iou * 100)}% overlap` });
  const painted = encodePng(painting);
  if (global.iou < PAINT_MIN_OVERLAP) {
    ctx.log({ text: "the painting does not line up: hidden stretches keep their edge colours" });
    return null;
  }
  const fits = groupShown.map((m) => refinePiece(m, P, P, fg, P, P, global.t, { shift: Math.round(P * 0.012), scale: 0.04 }));
  // Colour-match each group's paint to the design where it shows.
  const colors: ColorFit[] = fits.map((fit, g) => {
    const pairs: { paint: number[]; design: number[] }[] = [];
    const m = groupShown[g]!;
    for (let o = 0; o < P * P; o += 3) {
      if (!m[o]) continue;
      const [px, py] = applySim(fit.t, (o % P) + 0.5, Math.floor(o / P) + 0.5);
      const c = sample(painting, px, py);
      if (!c || c[3] < 200) continue;
      pairs.push({ paint: [c[0], c[1], c[2]], design: [layout[o * 4]!, layout[o * 4 + 1]!, layout[o * 4 + 2]!] });
    }
    return fitColors(pairs);
  });
  const lookup: PaintLookup = (k, x, y) => {
    const g = groupOf[k]!;
    const [lx, ly] = applySim(toLayout, x + offsets[g]![0], y + offsets[g]![1]);
    if (lx < 0 || ly < 0 || lx >= P || ly >= P || owner[Math.floor(ly) * P + Math.floor(lx)] !== g) return null;
    const [px, py] = applySim(fits[g]!.t, lx, ly);
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    if (ix < 0 || iy < 0 || ix >= P || iy >= P || !fg[iy * P + ix]) return null;
    const c = sample(painting, px, py);
    if (!c || c[3] < 200 || isMagenta(c[0], c[1], c[2])) return null;
    const fit = colors[g]!;
    return [0, 1, 2].map((ch) => Math.max(0, Math.min(255, fit.gain[ch]! * c[ch]! + fit.offset[ch]!))) as [number, number, number];
  };
  return { lookup, sent, painted, registration: Math.round(global.iou * 1000) / 1000, cost: generated.usage.cost, model: generated.model };
}

// --- drawing a layered rig (tests and checks; the game draws it in rig_view.gd) ---------------------

type Affine = [number, number, number, number, number, number]; // x' = a x + c y + e, y' = b x + d y + f

const apply = (m: Affine, [x, y]: readonly [number, number]): Vec => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const compose = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Each bone's transform for bones rotated about their pivots (degrees, clockwise on screen), parents first. */
export function boneTransforms(rig: Rig, rotate: Record<string, number> = {}): Map<string, Affine> {
  const out = new Map<string, Affine>();
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const get = (id: string): Affine => {
    const known = out.get(id);
    if (known) return known;
    const b = byId.get(id)!;
    const a = ((rotate[id] ?? 0) * Math.PI) / 180;
    const [px, py] = b.pivot;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const local: Affine = [cos, sin, -sin, cos, px - cos * px + sin * py, py - sin * px - cos * py];
    const m = b.parent ? compose(get(b.parent), local) : local;
    out.set(id, m);
    return m;
  };
  for (const b of rig.bones) get(b.id);
  return out;
}

/**
 * A layered rig's mesh parts drawn into a `width` x `height` image (RGBA, transparent background):
 * rig coordinates times `scale` plus `offset` are pixels; bones optionally rotated (each vertex
 * blends its bone's and its bendTo bone's transforms by its weight); triangles textured from the
 * atlas (bilinear), drawn in z order over each other. A software stand-in for the runtime.
 */
export function drawLayered(
  rig: Rig,
  atlas: Pixels,
  size: { width: number; height: number },
  options: { scale?: number; offset?: Vec; rotate?: Record<string, number> } = {},
): Pixels {
  const { width: W, height: H } = size;
  const scale = options.scale ?? 1;
  const [offX, offY] = options.offset ?? [0, 0];
  const out = new Uint8Array(W * H * 4);
  const bones = boneTransforms(rig, options.rotate);
  const parts = rig.parts.map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z || a.i - b.i);
  for (const { p } of parts) {
    if (p.shape.type !== "mesh") continue;
    const s = p.shape;
    const verts = [...s.points, ...s.inner];
    const mb = bones.get(p.bone)!;
    const mt = p.bendTo ? bones.get(p.bendTo)! : mb;
    const pos = verts.map((v, i) => {
      const w = s.weights?.[i] ?? 0;
      const a = apply(mb, v);
      const b = apply(mt, v);
      return [((1 - w) * a[0] + w * b[0]) * scale + offX, ((1 - w) * a[1] + w * b[1]) * scale + offY] as Vec;
    });
    for (let t = 0; t + 2 < s.triangles.length; t += 3) {
      const [i0, i1, i2] = [s.triangles[t]!, s.triangles[t + 1]!, s.triangles[t + 2]!];
      const [a, b, c] = [pos[i0]!, pos[i1]!, pos[i2]!];
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-12) continue;
      const [ua, ub, uc] = [s.uv[i0]!, s.uv[i1]!, s.uv[i2]!];
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      // Top-left fill rule (normalized to a positive triangle), so shared edges are drawn once.
      const sign = area > 0 ? 1 : -1;
      const edge = (p0: Vec, p1: Vec, x: number, y: number) => sign * ((p1[0] - p0[0]) * (y - p0[1]) - (p1[1] - p0[1]) * (x - p0[0]));
      const topLeft = (p0: Vec, p1: Vec) => {
        const dx = (p1[0] - p0[0]) * sign;
        const dy = (p1[1] - p0[1]) * sign;
        return dy < 0 || (dy === 0 && dx > 0);
      };
      const tl = [topLeft(b, c), topLeft(c, a), topLeft(a, b)];
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = edge(b, c, px, py);
          const w1 = edge(c, a, px, py);
          const w2 = edge(a, b, px, py);
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          if ((w0 === 0 && !tl[0]) || (w1 === 0 && !tl[1]) || (w2 === 0 && !tl[2])) continue;
          const sum = w0 + w1 + w2;
          const u = (w0 * ua[0] + w1 * ub[0] + w2 * uc[0]) / sum;
          const v = (w0 * ua[1] + w1 * ub[1] + w2 * uc[1]) / sum;
          const col = sample(atlas, u, v);
          if (!col || col[3] <= 0) continue;
          const sa = col[3] / 255;
          const o = (y * W + x) * 4;
          const da = out[o + 3]! / 255;
          const oa = sa + da * (1 - sa);
          for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.round((col[ch]! * sa + out[o + ch]! * da * (1 - sa)) / oa);
          out[o + 3] = Math.round(oa * 255);
        }
    }
  }
  return { width: W, height: H, data: out };
}
