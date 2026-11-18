import { Rig, type ArtDirection, type Bone, type Part } from "@anomaly/core";
import {
  components,
  dilate,
  jointPivots,
  labelParts,
  simplifyClosed,
  simplifyTo,
  solidMask,
  traceOutline,
  type Cutout,
  type CutoutPlan,
} from "./cutout.ts";
import { hexRgb } from "./match.ts";

/**
 * Traced rigs: the cutout's pieces (cutout.ts: the model's plan, every pixel assigned to a
 * part, joint-aware pivots), each redrawn as flat vector shapes, so the character matches
 * its concept and the project's other vector art at once:
 *  - colours: the character's pixels reduced to a small shared palette (k-means; a centre
 *    close to an art direction colour takes that colour),
 *  - per piece: one base shape (its silhouette in its main colour, with the art direction's
 *    ink outline), then flat colour regions on top (largest first, small specks dropped),
 *  - hidden areas completed: where a piece runs under a piece drawn in front of it (a leg
 *    under the body, the body under an arm), its base shape continues under that piece, so
 *    turning a joint shows the piece behind instead of a hole.
 * Coordinates are concept px (canvas space) throughout, like the plan.
 */

type Rgb = [number, number, number];

/** At most this many palette colours. */
const PALETTE_SIZE = 8;
/** A palette colour this close (RGB distance) to an art direction colour becomes that colour. */
const SNAP_DISTANCE = 20;
/** Palette colours closer than this merge. */
const MERGE_DISTANCE = 26;
/** Colour regions smaller than this fraction of the character are dropped (merged into their surroundings). */
const MIN_DETAIL = 0.0015;
/** How deep a piece continues under the piece in front of it: this share of their seam's half length... */
const EXTEND_SHARE = 1;
/** ...within these fractions of the character's height. */
const EXTEND_MIN = 0.02;
const EXTEND_MAX = 0.14;
/** A piece whose border is at least this share against one piece behind it is completed under it entirely (an arm across a body). */
const ENCLOSED_SHARE = 0.5;
const MAX_POINTS = 48;
const MAX_PARTS = 64;

export interface TracedOptions {
  /** Canvas px per game px (1 / the frame's scale): ink widths are game px. */
  canvasPerGamePx: number;
  /**
   * The cleaner tracer: edge-preserving smoothing before the colours are reduced, small
   * high-contrast details (eyes, ears, hands) and the plan's feature points kept, stray specks
   * dropped, and outlines fitted as smooth curves (corners kept sharp) instead of capped polygons.
   */
  clean?: boolean;
}

/** Clean tracer: colour regions this small (share of the character) survive when they are darker than their surroundings (eyes, lines)... */
const MIN_FEATURE = 0.0002;
/** ...by at least this much luminance (0-255). Small light spots are highlights and brush noise: they merge away. */
const FEATURE_CONTRAST = 60;
/** Clean tracer: detached bits of a piece smaller than this share of the character are dropped. */
const MIN_LOOSE = 0.01;

export function tracedRig(
  cut: Cutout,
  plan: CutoutPlan,
  direction: Pick<ArtDirection, "palette" | "ink" | "inkWidth">,
  options: TracedOptions,
): { rig: Rig; warnings: string[]; labels: Int32Array; bones: Bone[] } {
  const { width: W, height: H } = cut.image;
  const clean = options.clean === true;
  const solid0 = solidMask(cut.image);
  // The clean tracer reads colours from an edge-preserving smoothed copy: brush texture and soft shading flatten, edges stay.
  const data = clean ? bilateral(cut.image.data, solid0, W, H) : cut.image.data;
  const [ox, oy] = cut.offset;
  const N = W * H;
  const warnings: string[] = [];
  const label = labelParts(cut, plan);
  const bones = jointPivots(cut, plan, label);
  const solid = solidMask(cut.image);
  let area = 0;
  for (let i = 0; i < N; i++) area += solid[i]!;
  const charHeight = cut.bounds.maxY - cut.bounds.minY;
  const minDetail = Math.max(12, area * MIN_DETAIL);
  const minFeature = Math.max(6, area * MIN_FEATURE);
  // The plan's feature points (canvas px) as pixel indices of the cutout.
  const featureAt = new Set<number>();
  if (clean) {
    for (const [fx, fy] of plan.features ?? []) {
      const x = Math.round(fx - ox);
      const y = Math.round(fy - oy);
      if (x >= 0 && y >= 0 && x < W && y < H) featureAt.add(y * W + x);
    }
  }
  // Distance to the background: the character's own silhouette, where the outline goes.
  const fromOutside = distanceTo(invert(solid), W, H);

  // Colours.
  const palette = characterPalette(data, solid, direction.palette);
  const cluster = new Int16Array(N).fill(-1);
  for (let i = 0; i < N; i++) if (solid[i]) cluster[i] = nearest(palette, [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!]);

  // Draw order of the plan's parts (z, then plan order) and how they touch.
  const P = plan.parts.length;
  // Clean: each part's most common colour, and the part on its bone's parent (what a hidden stretch of it continues as).
  const commonColor = plan.parts.map((_, k) => {
    const counts = new Int32Array(palette.length);
    for (let i = 0; i < N; i++) if (label[i] === k && cluster[i]! >= 0) counts[cluster[i]!]!++;
    return counts.indexOf(Math.max(...counts));
  });
  const parentBone = new Map(plan.bones.map((b) => [b.id, b.parent]));
  const parentPart = plan.parts.map((p) => {
    const up = parentBone.get(p.bone);
    return up ? plan.parts.findIndex((q) => q.bone === up) : -1;
  });
  const order = plan.parts.map((_, k) => k).sort((a, b) => plan.parts[a]!.z - plan.parts[b]!.z || a - b);
  const rank = new Int32Array(P);
  order.forEach((k, r) => (rank[k] = r));
  const touch = Array.from({ length: P }, () => new Int32Array(P)); // touch[j][k]: j pixels with a k neighbour
  const border = new Int32Array(P); // pixels on each part's border (next to another part or the background)
  const seamBox = new Map<number, [number, number, number, number]>(); // pair -> minX, minY, maxX, maxY
  for (let i = 0; i < N; i++) {
    const j = label[i]!;
    if (j < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    const seen = new Set<number>();
    let onBorder = false;
    for (const n of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      const k = n < 0 ? -1 : label[n]!;
      if (k === j) continue;
      onBorder = true;
      if (k < 0 || seen.has(k)) continue;
      seen.add(k);
      touch[j]![k]!++;
      const key = Math.min(j, k) * P + Math.max(j, k);
      const box = seamBox.get(key) ?? [x, y, x, y];
      seamBox.set(key, [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]);
    }
    if (onBorder) border[j]!++;
  }

  interface Shape {
    piece: number;
    id: string;
    mask: Uint8Array;
    fill: Rgb;
    ink: number;
    kind: "ink" | "base" | "detail";
    size: number;
  }
  const inks: Shape[] = [];
  const bases: Shape[] = [];
  const details: Shape[] = [];
  // Ink: the art direction's colour, as wide as the drawing's own outline but never wider than the art direction's.
  const inkPx = direction.inkWidth * options.canvasPerGamePx;
  const lineWidth = drawnLineWidth(cut.image.data, solid, W, H);
  const inkScale = clamp(lineWidth / Math.max(inkPx, 0.001), 0.3, 1);
  const inkEff = inkPx * inkScale;

  for (const k of order) {
    const spec = plan.parts[k]!;
    const own = new Uint8Array(N);
    let ownCount = 0;
    for (let i = 0; i < N; i++) if (label[i] === k) (own[i] = 1, ownCount++);
    if (ownCount === 0) {
      warnings.push(`part "${spec.id}" covers no pixels (dropped)`);
      continue;
    }

    // Hidden areas: continue under the pieces drawn in front that it touches (on other bones).
    const base = own.slice();
    let distance: Float32Array | null = null;
    for (let j = 0; j < P; j++) {
      if (rank[j]! <= rank[k]! || plan.parts[j]!.bone === spec.bone || touch[j]![k]! < 3) continue;
      const box = seamBox.get(Math.min(j, k) * P + Math.max(j, k))!;
      const half = Math.hypot(box[2] - box[0] + 1, box[3] - box[1] + 1) / 2;
      const enclosed = touch[j]![k]! >= ENCLOSED_SHARE * border[j]!;
      const reach = enclosed ? Infinity : Math.min(EXTEND_MAX * charHeight, Math.max(EXTEND_MIN * charHeight, EXTEND_SHARE * half));
      distance ??= distanceTo(own, W, H);
      for (let i = 0; i < N; i++) if (label[i] === j && distance[i]! <= reach) base[i] = 1;
    }
    const closed = erode(dilate(base, W, H, 2), W, H, 2);
    for (let i = 0; i < N; i++) if (closed[i] && solid[i]) base[i] = 1;

    // Colours inside the piece: drop the drawing's own dark outline along the silhouette (the ink
    // outline replaces it) and the pale fringe the background left, smooth, and merge specks into
    // their surroundings. Lines the drawing has inside the character stay.
    const colors = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++) if (own[i]) colors[i] = cluster[i]!;
    const depth = distanceTo(invert(own), W, H); // inside: distance to the piece's edge
    const band = Math.max(2, Math.round(lineWidth + 1));
    const main = dominant(colors, depth, band, palette.length);
    const mainLum = luminance(palette[main]!);
    const outline = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!own[i]) continue;
      if (data[i * 4 + 3]! < 160 || (fromOutside[i]! <= band && luminance(palette[colors[i]!]!) < mainLum * 0.75)) outline[i] = 1;
    }
    fillFromNeighbours(colors, outline, W, H);
    modeFilter(colors, own, W, H, clean ? 1 : 2);
    // Clean: a small region that stands out from what surrounds it (an eye, an ear's line, a hand), or holds a feature point, stays.
    const kept = new Uint8Array(N);
    const keepRegion = clean
      ? (region: number[], c: number, to: number) => {
          const keep =
            region.length >= 3 &&
            (region.some((i) => featureNear(i, featureAt, W, H)) || (region.length >= minFeature && luminance(palette[to]!) - luminance(palette[c]!) >= FEATURE_CONTRAST));
          if (keep) for (const i of region) kept[i] = 1;
          return keep;
        }
      : undefined;
    mergeSpecks(colors, own, W, H, minDetail, keepRegion);
    // Clean: the stretch completed under the pieces in front is coloured like a drawn limb continuing: next to the
    // piece's own pixels their colour, further in its parent piece's colour (a forearm runs on as the sleeve, a shin
    // as the trousers), so a hidden limb swinging out shows no pale blank of its main colour.
    if (clean) fillHidden(colors, own, base, W, H, parentPart[k]! >= 0 ? commonColor[parentPart[k]!]! : -1, Math.max(3, 0.02 * charHeight));

    // Thinner ink on thin pieces; the shape shrinks from the silhouette by most of it so the outline lands on the drawing's edge.
    const pieces = components(base, W, H, 8).sort((a, b) => b.length - a.length);
    pieces.forEach((piece, n) => {
      if (n > 0 && piece.length < (clean ? Math.max(minDetail, MIN_LOOSE * area) : minDetail)) return;
      const mask = new Uint8Array(N);
      for (const i of piece) mask[i] = 1;
      const perimeter = countBorder(mask, W, H);
      const thickness = (2 * piece.length) / Math.max(1, perimeter);
      const ink = clamp(thickness / (3 * Math.max(inkEff, 0.001)), 0.35, 1) * inkScale;
      let inset = Math.min(0.75 * ink * inkPx, 0.25 * thickness);
      const inward = (by: number) => {
        const out = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (mask[i] && fromOutside[i]! > by) out[i] = 1;
        return out;
      };
      let shrunk = inward(inset);
      while (count(shrunk) < 0.5 * piece.length && inset >= 1) shrunk = inward((inset /= 2));
      if (count(shrunk) < 3) shrunk = mask;
      else if (inset > 0) {
        // Thin bits (a wire, a strap, a tail tip) would vanish or come loose: they keep their full width, joined to the rest.
        const opened = dilate(shrunk, W, H, inset * 1.5 + 2);
        const loose = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (mask[i] && !opened[i]) loose[i] = 1;
        const thin = new Uint8Array(N);
        for (const bit of components(loose, W, H, 8)) if (bit.length >= Math.max(12, inset * inset)) for (const i of bit) thin[i] = 1;
        if (count(thin) > 0) {
          const near = dilate(thin, W, H, inset + 1);
          for (let i = 0; i < N; i++) if (mask[i] && near[i]) shrunk[i] = 1;
        }
      }
      // Clean: only the shape's main piece is drawn, so only it may hold colour regions (no floating specks).
      if (clean) shrunk = largestPiece(shrunk, W, H);
      const id = n === 0 ? spec.id : `${spec.id}_${n + 1}`;
      bases.push({ piece: k, id, mask: shrunk, fill: palette[main]!, ink: 0, kind: "base", size: piece.length });
      if (direction.inkWidth > 0) inks.push({ piece: k, id: `${id}_ink`, mask: shrunk, fill: hexRgb(direction.ink), ink: round2(ink), kind: "ink", size: piece.length });
    });
    const inside = new Uint8Array(N);
    for (const b of bases) if (b.piece === k) for (let i = 0; i < N; i++) if (b.mask[i]) inside[i] = 1;

    // Colour regions on top of the base: everything but the main colour where it reaches the edge.
    for (let c = 0; c < palette.length; c++) {
      const of = new Uint8Array(N);
      for (let i = 0; i < N; i++) if (colors[i] === c && inside[i]) of[i] = 1;
      for (const region of components(of, W, H, 4)) {
        if (region.length < minDetail && !(clean && region.length >= 3 && region.some((i) => kept[i]))) continue;
        const mask = new Uint8Array(N);
        for (const i of region) mask[i] = 1;
        if (c === main && touchesOutside(region, inside, W, H)) continue;
        const filled = fillHoles(mask, W, H);
        details.push({ piece: k, id: "", mask: filled, fill: palette[c]!, ink: 0, kind: "detail", size: count(filled) });
      }
    }
  }

  // The part budget: every base and its outline, then the largest colour regions.
  const room = Math.max(0, MAX_PARTS - bases.length - inks.length);
  if (details.length > room) warnings.push(`kept the ${room} largest of ${details.length} colour regions`);
  const kept = new Set(details.sort((a, b) => b.size - a.size).slice(0, room));
  // The outlines go under everything: one ink silhouette around the character (and around each
  // piece that swings out of it), no lines where the drawing has none.
  const shapes: Shape[] = [...inks];
  for (const k of order) {
    shapes.push(...bases.filter((s) => s.piece === k));
    shapes.push(...details.filter((s) => s.piece === k && kept.has(s)).sort((a, b) => b.size - a.size));
  }
  const ids = new Set<string>();
  const parts: Part[] = [];
  const counter = new Map<number, number>();
  for (const s of shapes) {
    const points = clean ? curveOutline(s.mask, W, H) : blobOutline(s.mask, W, H);
    if (!points) continue;
    let id = s.id;
    if (s.kind === "detail") {
      const n = (counter.get(s.piece) ?? 0) + 1;
      counter.set(s.piece, n);
      id = `${plan.parts[s.piece]!.id}_d${n}`;
    }
    while (ids.has(id)) id = `${id}_x`;
    ids.add(id);
    parts.push({
      id,
      bone: plan.parts[s.piece]!.bone,
      z: 0,
      shape: { type: "blob", points: points.points.map(([x, y]) => [round1(x + ox), round1(y + oy)] as [number, number]), smooth: 1, sharp: points.sharp },
      fill: toHex(s.fill),
      ink: s.ink,
      glow: false,
      opacity: 1,
    });
  }
  // Unique z in draw order (the runtime's sort is not stable).
  parts.forEach((p, i) => (p.z = i - Math.floor(parts.length / 2)));
  const rig = Rig.parse({ mode: "traced", bones, parts });
  return { rig, warnings, labels: label, bones };
}

/**
 * How wide the drawing's own outline is (px): how deep the dark band along the silhouette's
 * edge goes. Rings at increasing depth inside the edge are dark less and less often; the line
 * ends where that share falls below half of the edge's. 0 when the edge isn't dark.
 */
export function drawnLineWidth(data: Uint8Array, solid: Uint8Array, W: number, H: number): number {
  const depth = distanceTo(invert(solid), W, H);
  const lums: number[] = [];
  for (let i = 0; i < W * H; i++) if (solid[i] && depth[i]! > 12) lums.push(luminance([data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!]));
  lums.sort((a, b) => a - b);
  const median = lums[Math.floor(lums.length / 2)] ?? 128;
  const RINGS = 40;
  const dark = new Float64Array(RINGS);
  const all = new Float64Array(RINGS);
  for (let i = 0; i < W * H; i++) {
    if (!solid[i] || data[i * 4 + 3]! < 200) continue;
    const r = Math.floor(depth[i]! - 0.5);
    if (r < 0 || r >= RINGS) continue;
    all[r]!++;
    if (luminance([data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!]) < median * 0.6) dark[r]!++;
  }
  const share = (r: number) => (all[r]! > 0 ? dark[r]! / all[r]! : 0);
  // The edge's own pixels are often pale (blended with the background): the line starts at the darkest of the first rings.
  let start = 0;
  for (let r = 1; r < 4; r++) if (share(r) > share(start)) start = r;
  const edge = share(start);
  if (edge < 0.3) return 0;
  for (let r = start + 1; r < RINGS; r++) if (share(r) < edge / 2) return r;
  return RINGS;
}

// --- colours -------------------------------------------------------------------------

/** A small palette for the character (k-means over its opaque pixels), snapped to the art direction's colours where close. */
export function characterPalette(data: Uint8Array, solid: Uint8Array, preferred: readonly string[]): Rgb[] {
  const samples: Rgb[] = [];
  const total = solid.reduce((s, v) => s + v, 0);
  const stride = Math.max(1, Math.floor(total / 8000));
  let seen = 0;
  for (let i = 0; i < solid.length; i++) {
    if (!solid[i] || data[i * 4 + 3]! < 200) continue;
    if (seen++ % stride === 0) samples.push([data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!]);
  }
  if (samples.length === 0) return [[128, 128, 128]];
  // Deterministic farthest-point start, then Lloyd iterations.
  const mean = [0, 1, 2].map((c) => samples.reduce((s, p) => s + p[c]!, 0) / samples.length) as Rgb;
  let centers: Rgb[] = [samples[nearest(samples, mean)]!];
  while (centers.length < Math.min(PALETTE_SIZE, samples.length)) {
    let far = 0;
    let farD = -1;
    samples.forEach((p, i) => {
      const d = dist(p, centers[nearest(centers, p)]!);
      if (d > farD) (farD = d), (far = i);
    });
    if (farD < MERGE_DISTANCE) break;
    centers.push(samples[far]!);
  }
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of samples) {
      const s = sums[nearest(centers, p)]!;
      s[0]! += p[0];
      s[1]! += p[1];
      s[2]! += p[2];
      s[3]!++;
    }
    centers = centers.map((c, k) => (sums[k]![3]! > 0 ? ([0, 1, 2].map((ch) => sums[k]![ch]! / sums[k]![3]!) as Rgb) : c));
  }
  const wanted = preferred.map((h) => hexRgb(h));
  const snapped = centers.map((c) => {
    const w = wanted.length > 0 ? wanted[nearest(wanted, c)]! : null;
    return (w && dist(w, c) < SNAP_DISTANCE ? w : c.map(Math.round)) as Rgb;
  });
  const out: Rgb[] = [];
  for (const c of snapped) if (!out.some((o) => dist(o, c) < MERGE_DISTANCE)) out.push(c);
  return out;
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const luminance = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const toHex = (c: Rgb) => `#${c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function nearest(list: readonly (readonly number[])[], p: readonly number[]): number {
  let best = 0;
  let bestD = Infinity;
  list.forEach((c, k) => {
    const d = dist(c, p);
    if (d < bestD) (bestD = d), (best = k);
  });
  return best;
}

/** The most common colour deeper than `band` px inside the piece (else anywhere in it). */
function dominant(colors: Int16Array, depth: Float32Array, band: number, n: number): number {
  for (const minDepth of [band + 0.5, 0]) {
    const counts = new Int32Array(n);
    for (let i = 0; i < colors.length; i++) if (colors[i]! >= 0 && depth[i]! > minDepth) counts[colors[i]!]!++;
    let best = 0;
    for (let c = 1; c < n; c++) if (counts[c]! > counts[best]!) best = c;
    if (counts[best]! > 0) return best;
  }
  return 0;
}

/** Flagged pixels take the colour of the nearest unflagged pixel of the piece (breadth first). */
function fillFromNeighbours(colors: Int16Array, flagged: Uint8Array, W: number, H: number): void {
  const queue: number[] = [];
  const done = new Uint8Array(colors.length);
  for (let i = 0; i < colors.length; i++) if (colors[i]! >= 0 && !flagged[i]) (done[i] = 1), queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    each4(i, W, H, (j) => {
      if (flagged[j] && !done[j]) {
        done[j] = 1;
        colors[j] = colors[i]!;
        queue.push(j);
      }
    });
  }
}

/** Passes of a 3x3 majority filter inside the mask. */
function modeFilter(colors: Int16Array, mask: Uint8Array, W: number, H: number, passes = 2): void {
  for (let pass = 0; pass < passes; pass++) {
    const next = colors.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        const votes = new Map<number, number>();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || !mask[ny * W + nx]) continue;
            const c = colors[ny * W + nx]!;
            votes.set(c, (votes.get(c) ?? 0) + 1);
          }
        }
        let best = colors[i]!;
        let bestV = votes.get(best) ?? 0;
        for (const [c, v] of votes) if (v > bestV) (best = c), (bestV = v);
        next[i] = best;
      }
    }
    colors.set(next);
  }
}

/** Colour regions smaller than `min` px take the colour they border most (unless `keep` says the region stays). */
function mergeSpecks(
  colors: Int16Array,
  mask: Uint8Array,
  W: number,
  H: number,
  min: number,
  keep?: (region: number[], color: number, into: number) => boolean,
): void {
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const seen = new Uint8Array(colors.length);
    for (let s = 0; s < colors.length; s++) {
      if (!mask[s] || seen[s]) continue;
      const c = colors[s]!;
      const region = [s];
      seen[s] = 1;
      const around = new Map<number, number>();
      for (let q = 0; q < region.length; q++) {
        each4(region[q]!, W, H, (j) => {
          if (!mask[j]) return;
          if (colors[j] === c) {
            if (!seen[j]) (seen[j] = 1), region.push(j);
          } else around.set(colors[j]!, (around.get(colors[j]!) ?? 0) + 1);
        });
      }
      if (region.length >= min || around.size === 0) continue;
      const to = [...around].sort((a, b) => b[1] - a[1])[0]![0];
      if (keep?.(region, c, to)) continue;
      for (const i of region) colors[i] = to;
      changed = true;
    }
    if (!changed) break;
  }
}

// --- masks ---------------------------------------------------------------------------

function each4(i: number, W: number, H: number, fn: (j: number) => void): void {
  const x = i % W;
  if (x > 0) fn(i - 1);
  if (x < W - 1) fn(i + 1);
  if (i >= W) fn(i - W);
  if (i < W * (H - 1)) fn(i + W);
}

function count(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i]!;
  return n;
}

function invert(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

/** Chamfer distance (px) from every pixel to the nearest pixel of the mask (0 on it). Off-image counts as not in the mask. */
export function distanceTo(mask: Uint8Array, W: number, H: number): Float32Array {
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? 0 : 1e9;
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
  return d;
}

/** The mask shrunk by `radius` px (pixels closer than that to its outside are dropped; the image edge counts as outside). */
export function erode(mask: Uint8Array, W: number, H: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const outside = invert(mask);
  // Pad: the image border is outside too.
  for (let x = 0; x < W; x++) (outside[x] = 1), (outside[(H - 1) * W + x] = 1);
  for (let y = 0; y < H; y++) (outside[y * W] = 1), (outside[y * W + W - 1] = 1);
  const d = distanceTo(outside, W, H);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] && d[i]! > radius ? 1 : 0;
  return out;
}

/** The mask with its enclosed holes filled. */
export function fillHoles(mask: Uint8Array, W: number, H: number): Uint8Array {
  const outside = new Uint8Array(W * H);
  const queue: number[] = [];
  const seed = (i: number) => {
    if (!mask[i] && !outside[i]) (outside[i] = 1), queue.push(i);
  };
  for (let x = 0; x < W; x++) (seed(x), seed((H - 1) * W + x));
  for (let y = 0; y < H; y++) (seed(y * W), seed(y * W + W - 1));
  for (let q = 0; q < queue.length; q++) each4(queue[q]!, W, H, seed);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

function countBorder(mask: Uint8Array, W: number, H: number): number {
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    let edge = false;
    each4(i, W, H, (j) => {
      if (!mask[j]) edge = true;
    });
    const x = i % W;
    if (x === 0 || x === W - 1 || i < W || i >= W * (H - 1)) edge = true;
    if (edge) n++;
  }
  return n;
}

function touchesOutside(region: number[], own: Uint8Array, W: number, H: number): boolean {
  for (const i of region) {
    let out = false;
    each4(i, W, H, (j) => {
      if (!own[j]) out = true;
    });
    if (out) return true;
  }
  return false;
}

// --- outlines ------------------------------------------------------------------------

/** The mask's largest piece as a blob outline (local px): at most MAX_POINTS points, sharp where it turns hard, never crossing itself. */
export function blobOutline(mask: Uint8Array, W: number, H: number): { points: [number, number][]; sharp: number[] } | null {
  const pieces = components(mask, W, H, 8);
  if (pieces.length === 0) return null;
  const biggest = pieces.sort((a, b) => b.length - a.length)[0]!;
  const only = new Uint8Array(W * H);
  for (const i of biggest) only[i] = 1;
  const outline = traceOutline(only, W, H);
  if (outline.length < 3) return null;
  for (let tolerance = 1.2; tolerance < 40; tolerance *= 1.6) {
    const points = simplifyTo(simplifyClosed(outline, tolerance), MAX_POINTS);
    if (points.length < 3) return null;
    if (crossesItself(points)) continue;
    const sharp: number[] = [];
    points.forEach((p, i) => {
      const a = points[(i - 1 + points.length) % points.length]!;
      const b = points[(i + 1) % points.length]!;
      const u = [a[0] - p[0], a[1] - p[1]];
      const v = [b[0] - p[0], b[1] - p[1]];
      const cos = (u[0]! * v[0]! + u[1]! * v[1]!) / (Math.hypot(u[0]!, u[1]!) * Math.hypot(v[0]!, v[1]!) || 1);
      if (cos > Math.cos((75 * Math.PI) / 180)) sharp.push(i); // a turn tighter than 75°: a point, horn tip or claw
    });
    return { points, sharp };
  }
  return null;
}

function crossesItself(points: [number, number][]): boolean {
  const n = points.length;
  const cross = (a: number[], b: number[], c: number[]) => (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = points[j]!;
      const d = points[(j + 1) % n]!;
      if (Math.sign(cross(a, b, c)) * Math.sign(cross(a, b, d)) < 0 && Math.sign(cross(c, d, a)) * Math.sign(cross(c, d, b)) < 0) return true;
    }
  }
  return false;
}

// --- the clean tracer ------------------------------------------------------------------

/**
 * Colours for the hidden stretch of a piece (in `base`, not its own pixels): within `near` px of
 * its own pixels the nearest own colour, beyond that `parent` (when >= 0, else the nearest own).
 */
function fillHidden(colors: Int16Array, own: Uint8Array, base: Uint8Array, W: number, H: number, parent: number, near: number): void {
  const queue: number[] = [];
  const steps = new Int32Array(colors.length);
  for (let i = 0; i < colors.length; i++) if (own[i] && colors[i]! >= 0) queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    each4(i, W, H, (j) => {
      if (!base[j] || own[j] || colors[j]! >= 0) return;
      steps[j] = steps[i]! + 1;
      colors[j] = parent >= 0 && steps[j]! > near ? parent : colors[i]!;
      queue.push(j);
    });
  }
}

/** The mask's largest 8-connected piece. */
function largestPiece(mask: Uint8Array, W: number, H: number): Uint8Array<ArrayBuffer> {
  const pieces = components(mask, W, H, 8);
  if (pieces.length <= 1) return mask.slice();
  const out = new Uint8Array(W * H);
  for (const i of pieces.sort((a, b) => b.length - a.length)[0]!) out[i] = 1;
  return out;
}

/** A feature point on or right next to pixel i. */
function featureNear(i: number, features: Set<number>, W: number, H: number): boolean {
  if (features.size === 0) return false;
  if (features.has(i)) return true;
  let near = false;
  each4(i, W, H, (j) => {
    if (features.has(j)) near = true;
  });
  return near;
}

/**
 * Edge-preserving smoothing (a bilateral filter, two passes) of the character's colours: brush
 * texture and soft shading even out inside a colour area, while edges between areas stay sharp.
 * Only the character's pixels are read and written. Returns new RGBA data.
 */
export function bilateral(data: Uint8Array, solid: Uint8Array, W: number, H: number, passes = 2, radius = 2, sigmaColor = 22): Uint8Array {
  let src = data;
  const spatial: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius)));
  const range = new Float64Array(3 * 256 * 256);
  for (let d = 0; d < range.length; d++) range[d] = Math.exp(-d / (2 * sigmaColor * sigmaColor));
  for (let pass = 0; pass < passes; pass++) {
    const out = src.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!solid[i] || src[i * 4 + 3]! < 160) continue;
        const r0 = src[i * 4]!;
        const g0 = src[i * 4 + 1]!;
        const b0 = src[i * 4 + 2]!;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sw = 0;
        let k = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++, k++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if (!solid[j] || src[j * 4 + 3]! < 160) continue;
            const r = src[j * 4]!;
            const g = src[j * 4 + 1]!;
            const b = src[j * 4 + 2]!;
            const d = (r - r0) * (r - r0) + (g - g0) * (g - g0) + (b - b0) * (b - b0);
            const w = spatial[k]! * (d < range.length ? range[d]! : 0);
            sr += w * r;
            sg += w * g;
            sb += w * b;
            sw += w;
          }
        }
        if (sw > 0) {
          out[i * 4] = Math.round(sr / sw);
          out[i * 4 + 1] = Math.round(sg / sw);
          out[i * 4 + 2] = Math.round(sb / sw);
        }
      }
    }
    src = out;
  }
  return src;
}

/** Points of a closed outline every `step` px along it. */
function resampleClosed(points: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [];
  const n = points.length;
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = carry;
    while (t < len) {
      out.push([a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len]);
      t += step;
    }
    carry = t - len;
  }
  return out;
}

/** Turns sharper than this (degrees, measured over a few px either side) are corners: tips, claws, hems. */
const CORNER_TURN = 62;

/**
 * The mask's largest piece as a smooth blob (local px): the pixel outline resampled, smoothed
 * along its length (corners excepted) and fitted with as few points as the runtime's curve
 * needs to follow it (at most MAX_POINTS), corners marked sharp; never crossing itself.
 */
export function curveOutline(mask: Uint8Array, W: number, H: number): { points: [number, number][]; sharp: number[] } | null {
  const pieces = components(mask, W, H, 8);
  if (pieces.length === 0) return null;
  const biggest = pieces.sort((a, b) => b.length - a.length)[0]!;
  if (biggest.length < 30) return blobOutline(mask, W, H);
  const only = new Uint8Array(W * H);
  for (const i of biggest) only[i] = 1;
  const raw = traceOutline(only, W, H);
  if (raw.length < 3) return null;
  // Pixel corners -> pixel-edge midpoints: the staircase's own wobble is half a pixel.
  const mids = raw.map((p, i) => {
    const q = raw[(i + 1) % raw.length]!;
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number];
  });
  const dense = resampleClosed(mids, 1);
  const n = dense.length;
  if (n < 12) return blobOutline(mask, W, H);
  // Corners: a hard turn between the chords k px back and k px ahead, the sharpest in its neighbourhood.
  const k = 4;
  const turn = dense.map((p, i) => {
    const a = dense[(i - k + n) % n]!;
    const b = dense[(i + k) % n]!;
    const u = [p[0] - a[0], p[1] - a[1]];
    const v = [b[0] - p[0], b[1] - p[1]];
    const cos = (u[0]! * v[0]! + u[1]! * v[1]!) / (Math.hypot(u[0]!, u[1]!) * Math.hypot(v[0]!, v[1]!) || 1);
    return (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI;
  });
  let corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i]! < CORNER_TURN) continue;
    let peak = true;
    for (let d = -k; d <= k && peak; d++) if (d !== 0 && (turn[(i + d + n) % n]! > turn[i]! || (turn[(i + d + n) % n] === turn[i] && d < 0))) peak = false;
    if (peak) corners.push(i);
  }
  // A small round shape reads as all corners: then it has none.
  if (corners.length > n / (3 * k)) corners = [];
  // Smooth along the outline (Gaussian), less near corners so tips stay pointed.
  const area = biggest.length;
  const sigma = clamp(Math.sqrt(area) / 18, 1, 2.5);
  const reach = Math.ceil(2.5 * sigma);
  const cornerDistance = new Float64Array(n).fill(Infinity);
  for (const c of corners) for (let d = -reach * 2; d <= reach * 2; d++) cornerDistance[(c + d + n) % n] = Math.min(cornerDistance[(c + d + n) % n]!, Math.abs(d));
  const smooth = dense.map((p, i) => {
    const s = Math.min(sigma, (sigma * cornerDistance[i]!) / (2 * reach));
    if (s < 0.3) return p;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let d = -reach; d <= reach; d++) {
      const w = Math.exp(-(d * d) / (2 * s * s));
      const q = dense[(i + d + n) % n]!;
      sx += w * q[0];
      sy += w * q[1];
      sw += w;
    }
    return [sx / sw, sy / sw] as [number, number];
  });
  // Fit: split at corners (else at two far-apart points), Douglas-Peucker each stretch; looser until it fits the point budget.
  const anchors = corners.length >= 2 ? corners : [0, farthestFrom(smooth, 0)].sort((a, b) => a - b);
  for (let tolerance = 1; tolerance < 40; tolerance *= 1.3) {
    const kept: number[] = [];
    for (let s = 0; s < anchors.length; s++) {
      const from = anchors[s]!;
      const to = s + 1 < anchors.length ? anchors[s + 1]! : anchors[0]! + n;
      const stretch: number[] = [];
      for (let i = from; i <= to; i++) stretch.push(i % n);
      const picked = dpIndices(stretch.map((i) => smooth[i]!), tolerance);
      for (const j of picked.slice(0, -1)) kept.push(stretch[j]!);
    }
    if (kept.length > MAX_POINTS) continue;
    if (kept.length < 3) return blobOutline(mask, W, H);
    const points = kept.map((i) => [round1(smooth[i]![0]), round1(smooth[i]![1])] as [number, number]);
    if (crossesItself(points)) continue;
    const cornerSet = new Set(corners);
    const sharp = kept.flatMap((i, j) => (cornerSet.has(i) ? [j] : []));
    return { points, sharp };
  }
  return blobOutline(mask, W, H);
}

function farthestFrom(points: [number, number][], from: number): number {
  let best = from;
  let bestD = -1;
  points.forEach((p, i) => {
    const d = Math.hypot(p[0] - points[from]![0], p[1] - points[from]![1]);
    if (d > bestD) (bestD = d), (best = i);
  });
  return best;
}

/** Douglas-Peucker on an open polyline: the indices kept (first and last always). */
function dpIndices(points: [number, number][], tolerance: number): number[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = points[a]!;
    const [bx, by] = points[b]!;
    const length = Math.hypot(bx - ax, by - ay);
    let worst = -1;
    let index = a;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]!;
      const d = length < 1e-6 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length;
      if (d > worst) (worst = d), (index = i);
    }
    if (worst > tolerance) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}
