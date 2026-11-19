import type { ArtDirection, Clip, Part, PartTexture, Rig } from "@anomaly/core";
import { encodePng, type Pixels } from "./match.ts";
import type { ArtRenderer } from "./stages.ts";
import type { Frame } from "./frame.ts";

/**
 * Pixel work for textured rigs: where each part is drawn (rendered by the real runtime, so masks
 * are exact), lining one image up with another, baking per-part textures from a source image and
 * packing them into one small atlas, and an exploded rest pose (bone groups pulled apart so
 * nothing overlaps) for painting over. Everything here is in *canvas space*: the pixels of the
 * design the rig was traced on (frame.ts), so a rig and its design line up.
 */

// --- part maps ---------------------------------------------------------------------

export interface PartMaps {
  width: number;
  height: number;
  /** Index (into rig.parts) of the part drawn on top at each pixel, -1 where nothing is. */
  visible: Int16Array;
  /** Whole-shape masks (hidden stretches included) for the parts asked for, by part index. */
  full: Map<number, Uint8Array>;
}

/** A distinct flat colour per part index (exact in a crisp render: the runtime draws 2D without anti-aliasing). */
function idColor(i: number): [number, number, number] {
  return [16 + ((i * 3) % 240), 255 - i * 3, 64 + ((i * 7) % 128)];
}

/** The rig with every part a flat id colour (no outline, shade, glow, texture or transparency). */
function idRig(rig: Rig): Rig {
  return {
    ...rig,
    parts: rig.parts.map((p, i) => {
      const [r, g, b] = idColor(i);
      const { shade: _shade, texture: _texture, ...rest } = p;
      return { ...rest, fill: `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`, ink: 0, glow: false, opacity: 1 };
    }),
  };
}

/** A clip (never validated: it may hide more than a clip's 32 parts) that shows only `keep`. */
function onlyClip(rig: Rig, keep: Set<string>): Clip {
  return {
    duration: 1,
    loop: false,
    tracks: [],
    motions: [],
    markers: [],
    visibility: rig.parts.filter((p) => !keep.has(p.id)).map((p) => ({ part: p.id, keys: [[0, false]] as [number, boolean][] })),
  };
}

/** Decode an id render: part index per pixel, -1 elsewhere. */
function decodeIds(png: Pixels, n: number, cell: { x: number; y: number; width: number; height: number }): Int16Array {
  const lookup = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const [r, g, b] = idColor(i);
    lookup.set((r << 16) | (g << 8) | b, i);
  }
  const out = new Int16Array(cell.width * cell.height).fill(-1);
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const o = ((cell.y + y) * png.width + cell.x + x) * 4;
      if (png.data[o + 3]! < 128) continue;
      const id = lookup.get((png.data[o]! << 16) | (png.data[o + 1]! << 8) | png.data[o + 2]!);
      if (id !== undefined) out[y * cell.width + x] = id;
    }
  }
  return out;
}

const MAX_FRAMES = 96;
/** The renderer draws cells of at most 512 px a side (render_service.gd MAX_CELL). */
const MAX_CELL = 512;
function checkCell(size: { width: number; height: number }): void {
  if (size.width > MAX_CELL || size.height > MAX_CELL) throw new Error(`part maps: ${size.width}x${size.height} is bigger than a render cell (${MAX_CELL} px)`);
}

/**
 * Which part is drawn where, for a canvas-space rig in a `size` canvas (rig coordinates are canvas
 * px): the visible part per pixel, and the whole shape of each part in `fullFor` (or of each group
 * of parts in `groups`, keyed by group index).
 */
export async function renderPartMaps(
  renderer: Pick<ArtRenderer, "renderRig">,
  canvasRig: Rig,
  size: { width: number; height: number },
  fullFor: number[],
  decode: (png: Buffer) => Pixels,
  direction: ArtDirection,
): Promise<PartMaps> {
  checkCell(size);
  const rig = idRig(canvasRig);
  const clips: Record<string, Clip> = {};
  for (const i of fullFor) clips[`only_${i}`] = onlyClip(rig, new Set([rig.parts[i]!.id]));
  const frames = [{ clip: null as string | null, time: 0 }, ...fullFor.map((i) => ({ clip: `only_${i}`, time: 0 }))];
  const full = new Map<number, Uint8Array>();
  let visible: Int16Array | null = null;
  for (let start = 0; start < frames.length; start += MAX_FRAMES) {
    const batch = frames.slice(start, start + MAX_FRAMES);
    const columns = Math.min(batch.length, 8);
    const drawn = await renderer.renderRig({
      rig,
      direction: { ...direction, boil: 0 },
      clips,
      frames: batch,
      cellWidth: size.width,
      cellHeight: size.height,
      columns,
      background: null,
      fit: false,
    });
    const png = decode(drawn.png);
    batch.forEach((frame, j) => {
      const cell = { x: (j % columns) * size.width, y: Math.floor(j / columns) * size.height, ...size };
      const ids = decodeIds(png, rig.parts.length, cell);
      if (frame.clip === null) visible = ids;
      else {
        const i = Number(frame.clip.slice(5));
        full.set(i, Uint8Array.from(ids, (v) => (v === i ? 1 : 0)));
      }
    });
  }
  return { ...size, visible: visible!, full };
}

/** Masks of groups of parts (each group drawn alone, whole), by group index. */
export async function renderGroupMasks(
  renderer: Pick<ArtRenderer, "renderRig">,
  canvasRig: Rig,
  size: { width: number; height: number },
  groups: string[][],
  decode: (png: Buffer) => Pixels,
  direction: ArtDirection,
): Promise<Uint8Array[]> {
  checkCell(size);
  const rig = idRig(canvasRig);
  const clips: Record<string, Clip> = Object.fromEntries(groups.map((g, i) => [`group_${i}`, onlyClip(rig, new Set(g))]));
  const out: Uint8Array[] = [];
  for (let start = 0; start < groups.length; start += MAX_FRAMES) {
    const batch = groups.slice(start, start + MAX_FRAMES).map((_, j) => ({ clip: `group_${start + j}`, time: 0 }));
    const columns = Math.min(batch.length, 8);
    const drawn = await renderer.renderRig({
      rig,
      direction: { ...direction, boil: 0 },
      clips,
      frames: batch,
      cellWidth: size.width,
      cellHeight: size.height,
      columns,
      background: null,
      fit: false,
    });
    const png = decode(drawn.png);
    batch.forEach((_, j) => {
      const cell = { x: (j % columns) * size.width, y: Math.floor(j / columns) * size.height, ...size };
      out.push(Uint8Array.from(decodeIds(png, rig.parts.length, cell), (v) => (v >= 0 ? 1 : 0)));
    });
  }
  return out;
}

// --- masks and registration ----------------------------------------------------------

export interface Similarity {
  /** Uniform scale about the origin, then translation: q = p * s + [tx, ty]. */
  s: number;
  tx: number;
  ty: number;
}

export const applySim = (t: Similarity, x: number, y: number): [number, number] => [x * t.s + t.tx, y * t.s + t.ty];

/** Mask of pixels that differ from a flat background colour (estimated from the border unless given). */
export function foreground(image: Pixels, background?: [number, number, number], tolerance = 30): Uint8Array {
  const { width: W, height: H, data } = image;
  let bg = background;
  if (!bg) {
    const border: number[][] = [];
    for (let x = 0; x < W; x++) border.push([...data.subarray(x * 4, x * 4 + 3)], [...data.subarray(((H - 1) * W + x) * 4, ((H - 1) * W + x) * 4 + 3)]);
    for (let y = 0; y < H; y++) border.push([...data.subarray(y * W * 4, y * W * 4 + 3)], [...data.subarray((y * W + W - 1) * 4, (y * W + W - 1) * 4 + 3)]);
    bg = [0, 1, 2].map((c) => median(border.map((p) => p[c]!))) as [number, number, number];
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (data[i * 4 + 3]! < 128) continue;
    if (Math.hypot(data[i * 4]! - bg[0], data[i * 4 + 1]! - bg[1], data[i * 4 + 2]! - bg[2]) > tolerance) out[i] = 1;
  }
  return out;
}

/**
 * Mask of everything but the flat background: background-coloured pixels connected to the image
 * border (tolerance from the border's own noise), so a pale part inside its outline stays in.
 */
export function figureMask(image: Pixels): Uint8Array {
  const { width: W, height: H, data } = image;
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) border.push(y * W, y * W + W - 1);
  const rgb = (i: number) => [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!];
  const bg = [0, 1, 2].map((c) => median(border.map((i) => rgb(i)[c]!)));
  const dist = (i: number) => Math.hypot(data[i * 4]! - bg[0]!, data[i * 4 + 1]! - bg[1]!, data[i * 4 + 2]! - bg[2]!);
  const spread = border.map(dist).sort((a, b) => a - b);
  const near = Math.min(40, Math.max(10, spread[Math.floor(spread.length * 0.95)]! * 1.5 + 6));
  const out = new Uint8Array(W * H).fill(1);
  const queue: number[] = [];
  for (const i of border) if (out[i] && dist(i) <= near) (out[i] = 0), queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (out[j] && dist(j) <= near) {
        out[j] = 0;
        queue.push(j);
      }
    }
  }
  return out;
}

export function maskBounds(mask: Uint8Array, W: number, H: number): { minX: number; minY: number; maxX: number; maxY: number; count: number } | null {
  let [minX, minY, maxX, maxY, count] = [W, H, -1, -1, 0];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (mask[y * W + x]) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  return maxX < 0 ? null : { minX, minY, maxX: maxX + 1, maxY: maxY + 1, count };
}

/** Downsample a mask by an integer factor (a cell is set when half its pixels are). */
function shrink(mask: Uint8Array, W: number, H: number, k: number): { mask: Uint8Array; W: number; H: number } {
  const w = Math.floor(W / k);
  const h = Math.floor(H / k);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) n += mask[(y * k + dy) * W + x * k + dx]!;
      out[y * w + x] = n * 2 >= k * k ? 1 : 0;
    }
  return { mask: out, W: w, H: h };
}

/** Intersection over union of mask `a` mapped by `t` onto mask `b` (sampled over b's grid, within `window` if given). */
function iou(a: Uint8Array, aW: number, aH: number, aCount: number, b: Uint8Array, bW: number, bH: number, t: Similarity, window?: { minX: number; minY: number; maxX: number; maxY: number }): number {
  let inter = 0;
  let bCount = 0;
  const [x0, y0, x1, y1] = window ? [Math.max(0, window.minX), Math.max(0, window.minY), Math.min(bW, window.maxX), Math.min(bH, window.maxY)] : [0, 0, bW, bH];
  let aMapped = 0;
  for (let y = y0; y < y1; y++) {
    const ay = Math.round((y + 0.5 - t.ty) / t.s - 0.5);
    for (let x = x0; x < x1; x++) {
      const ax = Math.round((x + 0.5 - t.tx) / t.s - 0.5);
      const inA = ax >= 0 && ay >= 0 && ax < aW && ay < aH && a[ay * aW + ax] === 1;
      const inB = b[y * bW + x] === 1;
      if (inA) aMapped++;
      if (inB) bCount++;
      if (inA && inB) inter++;
    }
  }
  const aArea = window ? aMapped : aCount * t.s * t.s;
  const union = aArea + bCount - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * The similarity that lays mask `a` (aW x aH) best over mask `b` (bW x bH), by overlap: starts
 * from their bounds lined up (bottom-centre, same height) and searches scale and shift, coarse to fine.
 */
export function registerMasks(
  a: Uint8Array,
  aW: number,
  aH: number,
  b: Uint8Array,
  bW: number,
  bH: number,
  options: { scaleRange?: number; shiftRange?: number; start?: Similarity } = {},
): { t: Similarity; iou: number } {
  const ab = maskBounds(a, aW, aH);
  const bb = maskBounds(b, bW, bH);
  if (!ab || !bb) return { t: options.start ?? { s: 1, tx: 0, ty: 0 }, iou: 0 };
  let t: Similarity = options.start ?? (() => {
    const s = (bb.maxY - bb.minY) / Math.max(1, ab.maxY - ab.minY);
    return { s, tx: (bb.minX + bb.maxX) / 2 - ((ab.minX + ab.maxX) / 2) * s, ty: bb.maxY - ab.maxY * s };
  })();
  const scaleRange = options.scaleRange ?? 0.2;
  const shiftRange = options.shiftRange ?? Math.max(bW, bH) * 0.08;
  // Coarse: masks shrunk 4x.
  const k = 4;
  const sa = shrink(a, aW, aH, k);
  const sb = shrink(b, bW, bH, k);
  const saCount = sa.mask.reduce((s, v) => s + v, 0);
  const coarse = (c: Similarity): Similarity => ({ s: c.s, tx: c.tx / k, ty: c.ty / k });
  let best = { t, score: iou(sa.mask, sa.W, sa.H, saCount, sb.mask, sb.W, sb.H, coarse(t)) };
  const pivotX = (ab.minX + ab.maxX) / 2;
  const pivotY = ab.maxY;
  for (let ds = -scaleRange; ds <= scaleRange + 1e-9; ds += scaleRange / 8) {
    const s = t.s * (1 + ds);
    // Scale about the figure's feet so a scale change doesn't need a big shift.
    const [px, py] = applySim(t, pivotX, pivotY);
    const base: Similarity = { s, tx: px - pivotX * s, ty: py - pivotY * s };
    for (let dx = -shiftRange; dx <= shiftRange; dx += k) {
      for (let dy = -shiftRange; dy <= shiftRange; dy += k) {
        const c = { s, tx: base.tx + dx, ty: base.ty + dy };
        const score = iou(sa.mask, sa.W, sa.H, saCount, sb.mask, sb.W, sb.H, coarse(c));
        if (score > best.score) best = { t: c, score };
      }
    }
  }
  // Fine: full resolution, small steps, from the coarse winner or the start, whichever fits better there.
  const aCount = ab.count;
  let score = iou(a, aW, aH, aCount, b, bW, bH, t);
  const coarseScore = iou(a, aW, aH, aCount, b, bW, bH, best.t);
  if (coarseScore > score) {
    score = coarseScore;
    t = best.t;
  }
  for (const step of [2, 1, 0.5]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const c of [
        { ...t, tx: t.tx + step },
        { ...t, tx: t.tx - step },
        { ...t, ty: t.ty + step },
        { ...t, ty: t.ty - step },
        { ...t, s: t.s * (1 + step / 200) },
        { ...t, s: t.s * (1 - step / 200) },
      ]) {
        const v = iou(a, aW, aH, aCount, b, bW, bH, c);
        if (v > score + 1e-6) {
          score = v;
          t = c;
          improved = true;
        }
      }
    }
  }
  return { t, iou: score };
}

/** Fine-tune `t` for one piece (mask `a`) against `b` inside a window around where it lands: shift and a little scale. */
export function refinePiece(
  a: Uint8Array,
  aW: number,
  aH: number,
  b: Uint8Array,
  bW: number,
  bH: number,
  t: Similarity,
  options: { shift: number; scale: number; scaleSteps?: number; step?: number },
): { t: Similarity; iou: number; before: number } {
  const ab = maskBounds(a, aW, aH);
  if (!ab) return { t, iou: 0, before: 0 };
  const pad = options.shift + 4;
  const [x0, y0] = applySim(t, ab.minX, ab.minY);
  const [x1, y1] = applySim(t, ab.maxX, ab.maxY);
  const window = { minX: Math.floor(x0 - pad), minY: Math.floor(y0 - pad), maxX: Math.ceil(x1 + pad), maxY: Math.ceil(y1 + pad) };
  const cx = (ab.minX + ab.maxX) / 2;
  const cy = (ab.minY + ab.maxY) / 2;
  const before = iou(a, aW, aH, ab.count, b, bW, bH, t, window);
  let best = { t, score: before };
  const [pcx, pcy] = applySim(t, cx, cy);
  const steps = options.scaleSteps ?? 2;
  const step = options.step ?? 1;
  for (let ds = -options.scale; ds <= options.scale + 1e-9; ds += options.scale / steps || 1) {
    const s = t.s * (1 + ds);
    for (let dx = -options.shift; dx <= options.shift; dx += step) {
      for (let dy = -options.shift; dy <= options.shift; dy += step) {
        const c = { s, tx: pcx - cx * s + dx, ty: pcy - cy * s + dy };
        const v = iou(a, aW, aH, ab.count, b, bW, bH, c, window);
        if (v > best.score + 1e-6) best = { t: c, score: v };
      }
    }
    if (options.scale === 0) break;
  }
  return { t: best.t, iou: best.score, before };
}

// --- baking textures -------------------------------------------------------------------

/** Bilinear sample (premultiplied by alpha) at a fractional pixel; null outside the image. */
export function sample(image: Pixels, x: number, y: number): [number, number, number, number] | null {
  const fx = x - 0.5;
  const fy = y - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > image.width - 0.5 || fy > image.height - 0.5) return null;
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(fy)));
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, fx - x0));
  const ay = Math.max(0, Math.min(1, fy - y0));
  const acc = [0, 0, 0, 0];
  for (const [px, py, w] of [[x0, y0, (1 - ax) * (1 - ay)], [x1, y0, ax * (1 - ay)], [x0, y1, (1 - ax) * ay], [x1, y1, ax * ay]] as const) {
    const o = (py * image.width + px) * 4;
    const a = image.data[o + 3]! / 255;
    acc[0]! += w * image.data[o]! * a;
    acc[1]! += w * image.data[o + 1]! * a;
    acc[2]! += w * image.data[o + 2]! * a;
    acc[3]! += w * a;
  }
  if (acc[3]! <= 0) return [0, 0, 0, 0];
  return [acc[0]! / acc[3]!, acc[1]! / acc[3]!, acc[2]! / acc[3]!, acc[3]! * 255];
}

/** A baked part texture: canvas-px box (the part's whole shape plus a margin) and its pixels. */
export interface PartBake {
  part: number;
  box: { x: number; y: number; width: number; height: number };
  image: Pixels;
  /** Share of the shape covered by the source's own pixels (before holes were filled). */
  coverage: number;
}

export interface BakeOptions {
  /** Canvas px past the shape the texture still covers (outline wobble, rounding). Default 3. */
  margin?: number;
  /** Holes (no source pixel for the part) closer than this (canvas px) to one take its colour; further, the flat fill shows. Default 6. */
  reach?: number;
}

/**
 * Bake one part's texture over its whole shape: `pick(x, y)` gives the source colour for canvas
 * pixel (x, y) or null where the source has nothing for this part (hidden, another part, the
 * background). Holes near known pixels take the nearest known colour; further ones stay
 * transparent (the part's flat fill shows there).
 */
export function bakePart(
  part: number,
  mask: Uint8Array,
  size: { width: number; height: number },
  pick: (x: number, y: number) => [number, number, number] | null,
  options: BakeOptions = {},
): PartBake | null {
  const margin = options.margin ?? 3;
  const reach = options.reach ?? 6;
  const b = maskBounds(mask, size.width, size.height);
  if (!b) return null;
  const box = { x: b.minX - margin, y: b.minY - margin, width: b.maxX - b.minX + 2 * margin, height: b.maxY - b.minY + 2 * margin };
  const { width: W, height: H } = box;
  const data = new Uint8Array(W * H * 4);
  const known = new Int32Array(W * H).fill(-1);
  const dist = new Float32Array(W * H).fill(Infinity);
  const queue: number[] = [];
  let inside = 0;
  let covered = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = box.x + x;
      const cy = box.y + y;
      const inMask = cx >= 0 && cy >= 0 && cx < size.width && cy < size.height && mask[cy * size.width + cx] === 1;
      if (!inMask) continue;
      inside++;
      const c = pick(cx + 0.5, cy + 0.5);
      if (!c) continue;
      covered++;
      const i = y * W + x;
      data.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], i * 4);
      known[i] = i;
      dist[i] = 0;
      queue.push(i);
    }
  }
  if (covered === 0) return { part, box, image: { width: W, height: H, data }, coverage: 0 };
  // Spread known colours outward (nearest known pixel, 8-neighbour steps) over holes and the margin.
  const limit = Math.max(reach, margin + 1);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % W;
    const y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        const d = dist[i]! + (dx && dy ? Math.SQRT2 : 1);
        if (d < dist[j]! && d <= limit) {
          dist[j] = d;
          known[j] = known[i]!;
          queue.push(j);
        }
      }
  }
  for (let i = 0; i < W * H; i++) {
    if (dist[i]! === 0 || known[i]! < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    const cx = box.x + x;
    const cy = box.y + y;
    const inMask = cx >= 0 && cy >= 0 && cx < size.width && cy < size.height && mask[cy * size.width + cx] === 1;
    // Inside the shape: holes up to `reach`. Outside: only the margin (it is clipped away anyway).
    if (inMask ? dist[i]! > reach : dist[i]! > margin + 1) continue;
    data.set(data.subarray(known[i]! * 4, known[i]! * 4 + 3), i * 4);
    data[i * 4 + 3] = 255;
  }
  return { part, box, image: { width: W, height: H, data }, coverage: inside === 0 ? 0 : covered / inside };
}

// --- atlas ------------------------------------------------------------------------------

export interface Atlas {
  image: Pixels;
  png: Buffer;
  /** Atlas px region per bake (same order as given), and the scale each was packed at. */
  regions: { part: number; uv: [number, number, number, number] }[];
  scale: number;
}

const GUTTER = 3;

/**
 * Pack baked textures into one atlas no bigger than `max` px a side (shelf packing, tallest first),
 * shrinking them all alike until they fit; never enlarges. Gutters keep neighbours from bleeding.
 */
export function packAtlas(bakes: PartBake[], max = 512): Atlas {
  let scale = 1;
  for (let attempt = 0; attempt < 40; attempt++) {
    const sized = bakes.map((b, i) => ({ i, w: Math.max(1, Math.round(b.image.width * scale)), h: Math.max(1, Math.round(b.image.height * scale)) }));
    const order = [...sized].sort((a, b) => b.h - a.h || b.w - a.w);
    // Roughly square: as wide as the widest piece, or the square root of the total area (plus slack for the shelves).
    const area = sized.reduce((s, p) => s + (p.w + 2 * GUTTER) * (p.h + 2 * GUTTER), 0);
    const width = Math.min(max, Math.max(...sized.map((s) => s.w + 2 * GUTTER), Math.ceil(Math.sqrt(area) * 1.15), 16));
    let x = 0;
    let y = 0;
    let shelf = 0;
    const place = new Map<number, [number, number]>();
    let fits = true;
    for (const s of order) {
      if (s.w + 2 * GUTTER > width) {
        fits = false;
        break;
      }
      if (x + s.w + 2 * GUTTER > width) {
        x = 0;
        y += shelf;
        shelf = 0;
      }
      place.set(s.i, [x + GUTTER, y + GUTTER]);
      x += s.w + 2 * GUTTER;
      shelf = Math.max(shelf, s.h + 2 * GUTTER);
    }
    const height = y + shelf;
    if (!fits || height > max) {
      scale *= 0.9;
      continue;
    }
    // Width: as narrow as the packing allows only if that doesn't break the shelves; keep `width`.
    const W = width;
    const H = Math.max(1, height);
    const data = new Uint8Array(W * H * 4);
    const regions: Atlas["regions"] = [];
    sized.forEach((s) => {
      const [px, py] = place.get(s.i)!;
      const src = bakes[s.i]!.image;
      const scaled = scale === 1 ? src : resizePremultiplied(src, s.w, s.h);
      for (let yy = 0; yy < s.h; yy++) data.set(scaled.data.subarray(yy * s.w * 4, (yy + 1) * s.w * 4), ((py + yy) * W + px) * 4);
      regions.push({ part: bakes[s.i]!.part, uv: [px, py, s.w, s.h] });
    });
    const image = { width: W, height: H, data };
    return { image, png: encodePng(image), regions, scale };
  }
  throw new Error("packAtlas: the textures do not fit");
}

/** Area-averaging resize with premultiplied alpha (shrinking textures). */
export function resizePremultiplied(img: Pixels, W: number, H: number): Pixels {
  const data = new Uint8Array(W * H * 4);
  const sx = img.width / W;
  const sy = img.height / H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let yy = y0; yy < Math.min(y1, img.height); yy++)
        for (let xx = x0; xx < Math.min(x1, img.width); xx++) {
          const o = (yy * img.width + xx) * 4;
          const a = img.data[o + 3]! / 255;
          acc[0]! += img.data[o]! * a;
          acc[1]! += img.data[o + 1]! * a;
          acc[2]! += img.data[o + 2]! * a;
          acc[3]! += a;
          n++;
        }
      const o = (y * W + x) * 4;
      if (acc[3]! > 0) {
        data[o] = Math.round(acc[0]! / acc[3]!);
        data[o + 1] = Math.round(acc[1]! / acc[3]!);
        data[o + 2] = Math.round(acc[2]! / acc[3]!);
      }
      data[o + 3] = Math.round((acc[3]! / Math.max(1, n)) * 255);
    }
  }
  return { width: W, height: H, data };
}

/**
 * The rig (rig space) with textures from an atlas: each baked part's canvas box becomes its
 * rest-pose rectangle (through `frame`), its atlas region the image region.
 */
export function withTextures(rig: Rig, atlas: Atlas, bakes: PartBake[], file: string, frame: Frame, opacity = 1): Rig {
  const byPart = new Map(atlas.regions.map((r, i) => [r.part, { uv: r.uv, box: bakes[i]!.box }]));
  const r2 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    ...rig,
    parts: rig.parts.map((p, i) => {
      const placed = byPart.get(i);
      if (!placed) return p;
      const { box, uv } = placed;
      const texture: PartTexture = {
        file,
        rect: [r2((box.x - frame.anchor[0]) * frame.scale), r2((box.y - frame.anchor[1]) * frame.scale), r2(box.width * frame.scale), r2(box.height * frame.scale)],
        uv,
        opacity,
      };
      return { ...p, texture };
    }),
  };
}

// --- which parts get textures ---------------------------------------------------------

/** Parts that carry a texture: whole shapes (not clipped details), outlined or big (eyes, brows and detail lines stay crisp vector). */
export function texturedParts(rig: Rig, maps: { visible: Int16Array }): number[] {
  const area = new Map<number, number>();
  for (const v of maps.visible) if (v >= 0) area.set(v, (area.get(v) ?? 0) + 1);
  const total = [...area.values()].reduce((s, v) => s + v, 0);
  return rig.parts.flatMap((p, i) => (p.shape.type !== "image" && p.clipTo === undefined && (p.ink > 0 || (area.get(i) ?? 0) >= total * 0.04) ? [i] : []));
}

/** Average colour of a part's texture where it is opaque (for retinting its flat fill), or null. */
export function meanColor(bake: PartBake): string | null {
  let [r, g, b, n] = [0, 0, 0, 0];
  const d = bake.image.data;
  for (let i = 0; i < d.length; i += 4)
    if (d[i + 3]! === 255) {
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
      n++;
    }
  if (n === 0) return null;
  return `#${[r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("")}`;
}

// --- exploded rest pose -----------------------------------------------------------------

/** Parts grouped by the bone(s) that move them (each group moves as one). */
export function boneGroups(rig: Rig): string[][] {
  const groups = new Map<string, string[]>();
  for (const p of rig.parts) {
    const key = `${p.bone}|${p.bendTo ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), p.id]);
  }
  return [...groups.values()];
}

/**
 * Offsets (canvas px) that pull overlapping groups apart until every pair is at least `gap` px
 * apart, moving each as little as it can (the lighter of two moves more), along the line between
 * their centres (sideways when the centres coincide).
 */
export function explode(masks: Uint8Array[], W: number, H: number, gap: number): [number, number][] {
  // Work on 2x shrunk masks for speed, dilated by half the gap.
  const k = 2;
  const small = masks.map((m) => shrink(m, W, H, k));
  const w = small[0]?.W ?? 1;
  const h = small[0]?.H ?? 1;
  const r = Math.max(1, Math.round(gap / k / 2));
  const grown = small.map((m) => dilateMask(m.mask, w, h, r));
  const info = grown.map((m) => {
    const b = maskBounds(m, w, h);
    const area = m.reduce((s, v) => s + v, 0);
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) (sx += i % w), (sy += Math.floor(i / w));
    return { b, area: Math.max(1, area), cx: sx / Math.max(1, area), cy: sy / Math.max(1, area) };
  });
  const off: [number, number][] = masks.map(() => [0, 0]);
  const overlap = (i: number, j: number): number => {
    const a = info[i]!.b;
    const c = info[j]!.b;
    if (!a || !c) return 0;
    const [ix, iy] = [Math.round(off[i]![0]), Math.round(off[i]![1])];
    const [jx, jy] = [Math.round(off[j]![0]), Math.round(off[j]![1])];
    const x0 = Math.max(a.minX + ix, c.minX + jx);
    const x1 = Math.min(a.maxX + ix, c.maxX + jx);
    const y0 = Math.max(a.minY + iy, c.minY + jy);
    const y1 = Math.min(a.maxY + iy, c.maxY + jy);
    if (x0 >= x1 || y0 >= y1) return 0;
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) if (grown[i]![(y - iy) * w + x - ix] && grown[j]![(y - jy) * w + x - jx]) n++;
    return n;
  };
  for (let iter = 0; iter < 400; iter++) {
    let moved = false;
    for (let i = 0; i < masks.length; i++) {
      for (let j = i + 1; j < masks.length; j++) {
        if (overlap(i, j) === 0) continue;
        moved = true;
        let dx = info[j]!.cx + off[j]![0] - (info[i]!.cx + off[i]![0]);
        let dy = info[j]!.cy + off[j]![1] - (info[i]!.cy + off[i]![1]);
        let len = Math.hypot(dx, dy);
        if (len < 1) {
          dx = 1;
          dy = 0;
          len = 1;
        }
        const wi = info[j]!.area / (info[i]!.area + info[j]!.area);
        const step = 1.5;
        off[i]![0] -= (dx / len) * step * wi;
        off[i]![1] -= (dy / len) * step * wi;
        off[j]![0] += (dx / len) * step * (1 - wi);
        off[j]![1] += (dy / len) * step * (1 - wi);
      }
    }
    if (!moved) break;
  }
  return off.map(([x, y]) => [Math.round(x * k), Math.round(y * k)]);
}

export function dilateMask(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) out[ny * W + nx] = 1;
        }
    }
  return out;
}

/** The rig with each group of parts moved by its offset (rest pose only: bones are not moved, so it is for still renders). */
export function movedGroups(rig: Rig, groups: string[][], offsets: [number, number][]): Rig {
  const by = new Map<string, [number, number]>();
  groups.forEach((g, i) => g.forEach((id) => by.set(id, offsets[i]!)));
  const move = (p: Part): Part => {
    const [dx, dy] = by.get(p.id) ?? [0, 0];
    const pt = ([x, y]: readonly [number, number]): [number, number] => [x + dx, y + dy];
    const s = p.shape;
    const shape = s.type === "ellipse" ? { ...s, center: pt(s.center) } : s.type === "mesh" ? { ...s, points: s.points.map(pt), inner: s.inner.map(pt) } : { ...s, points: s.points.map(pt) };
    const t = p.texture;
    return { ...p, shape, ...(t ? { texture: { ...t, rect: [t.rect[0] + dx, t.rect[1] + dy, t.rect[2], t.rect[3]] as [number, number, number, number] } } : {}) } as Part;
  };
  return { ...rig, parts: rig.parts.map(move) };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
