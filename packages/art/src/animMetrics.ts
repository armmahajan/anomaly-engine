import type { Pixels } from "./match.ts";

/**
 * How cleanly a rig holds together while it animates, measured on renders
 * (transparent background) of the rest pose and of posed frames, framed the
 * same. Rigid motion of the whole character costs nothing; what counts is the
 * body coming apart:
 *  - holes: transparent pockets enclosed by the character (a limb moved and
 *    nothing was behind it),
 *  - seams: thin transparent cracks a small closing would fill (pieces pulled
 *    apart at a joint),
 *  - debris: opaque bits not attached to the character,
 *  - area: the frame's opaque area over the rest pose's (pieces separating
 *    grows it, pieces collapsing into each other shrinks it).
 * Each count is the frame's minus the rest pose's (never below 0), in
 * per-mille of the rest pose's opaque area.
 */

export interface FrameMetrics {
  holes: number;
  seams: number;
  debris: number;
  area: number;
}

export interface MaskStats {
  opaque: number;
  enclosed: number;
  cracks: number;
  debris: number;
}

/** Alpha at or above this is part of the character. */
const OPAQUE_ALPHA = 128;
/** Cracks up to about twice this wide (px) count as seams. */
const SEAM_RADIUS = 2;

/** The opaque mask of an RGBA image (or a w x h region of it). */
export function opaqueMask(image: Pixels, region?: { x: number; y: number; width: number; height: number }): { mask: Uint8Array; width: number; height: number } {
  const r = region ?? { x: 0, y: 0, width: image.width, height: image.height };
  const mask = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const sx = x + r.x;
      const sy = y + r.y;
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      mask[y * r.width + x] = image.data[(sy * image.width + sx) * 4 + 3]! >= OPAQUE_ALPHA ? 1 : 0;
    }
  }
  return { mask, width: r.width, height: r.height };
}

/** Counts for one mask: opaque px, enclosed transparent px, crack px (closing minus mask, not enclosed), detached opaque px. */
export function maskStats(mask: Uint8Array, W: number, H: number): MaskStats {
  let opaque = 0;
  for (let i = 0; i < W * H; i++) opaque += mask[i]!;
  // Transparent pixels reachable from the border (4-connected) are outside; the rest are enclosed.
  const outside = new Uint8Array(W * H);
  const queue: number[] = [];
  const seed = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < W; x++) (seed(x), seed((H - 1) * W + x));
  for (let y = 0; y < H; y++) (seed(y * W), seed(y * W + W - 1));
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    const x = i % W;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (i >= W) seed(i - W);
    if (i < W * (H - 1)) seed(i + W);
  }
  let enclosed = 0;
  for (let i = 0; i < W * H; i++) if (!mask[i] && !outside[i]) enclosed++;
  const closed = erode(dilate(mask, W, H, SEAM_RADIUS), W, H, SEAM_RADIUS);
  let cracks = 0;
  for (let i = 0; i < W * H; i++) if (closed[i] && !mask[i] && outside[i]) cracks++;
  // Detached bits: everything outside the largest 8-connected piece.
  let largest = 0;
  const seen = new Uint8Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    let size = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      size++;
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    largest = Math.max(largest, size);
  }
  return { opaque, enclosed, cracks, debris: opaque - largest };
}

/** A posed frame against the rest pose (see the module comment). */
export function frameMetrics(rest: MaskStats, frame: MaskStats): FrameMetrics {
  const per = (n: number) => Math.round((Math.max(0, n) / Math.max(1, rest.opaque)) * 10000) / 10;
  return {
    holes: per(frame.enclosed - rest.enclosed),
    seams: per(frame.cracks - rest.cracks),
    debris: per(frame.debris - rest.debris),
    area: Math.round((frame.opaque / Math.max(1, rest.opaque)) * 1000) / 1000,
  };
}

export interface ClipMetrics {
  /** Mean over the clip's frames. */
  mean: FrameMetrics;
  /** Worst frame (area: furthest from 1). */
  worst: FrameMetrics;
}

/** Mean and worst over frames. */
export function summarize(frames: FrameMetrics[]): ClipMetrics {
  const keys = ["holes", "seams", "debris"] as const;
  const mean = { holes: 0, seams: 0, debris: 0, area: 0 };
  const worst = { holes: 0, seams: 0, debris: 0, area: 1 };
  for (const f of frames) {
    for (const k of keys) {
      mean[k] += f[k] / frames.length;
      worst[k] = Math.max(worst[k], f[k]);
    }
    mean.area += f.area / frames.length;
    if (Math.abs(f.area - 1) > Math.abs(worst.area - 1)) worst.area = f.area;
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return { mean: { holes: r(mean.holes), seams: r(mean.seams), debris: r(mean.debris), area: Math.round(mean.area * 1000) / 1000 }, worst };
}

/**
 * A render sheet (cells of `cell` px, `columns` per row, transparent background): cell 0 is the
 * rest pose, then `framesPerClip` cells per clip in `clipIds` order. Metrics per clip.
 */
export function sheetMetrics(
  sheet: Pixels,
  cell: { width: number; height: number },
  columns: number,
  clipIds: string[],
  framesPerClip: number,
): Record<string, ClipMetrics & { frames: FrameMetrics[] }> {
  const at = (n: number) => {
    const { mask, width, height } = opaqueMask(sheet, { x: (n % columns) * cell.width, y: Math.floor(n / columns) * cell.height, ...cell });
    return maskStats(mask, width, height);
  };
  const rest = at(0);
  const out: Record<string, ClipMetrics & { frames: FrameMetrics[] }> = {};
  clipIds.forEach((id, c) => {
    const frames = Array.from({ length: framesPerClip }, (_, f) => frameMetrics(rest, at(1 + c * framesPerClip + f)));
    out[id] = { ...summarize(frames), frames };
  });
  return out;
}

function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  return morph(mask, W, H, r, 1);
}

function erode(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  return morph(mask, W, H, r, 0);
}

/** Square-ish (disk) structuring element of radius r: dilation (value 1) or erosion (value 0). Out of bounds counts as empty. */
function morph(mask: Uint8Array, W: number, H: number, r: number, value: 0 | 1): Uint8Array {
  const out = new Uint8Array(W * H);
  const offsets: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) offsets.push([dx, dy]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let hit = value === 0 ? 1 : 0;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        const v = nx >= 0 && ny >= 0 && nx < W && ny < H ? mask[ny * W + nx]! : 0;
        if (value === 1 && v) {
          hit = 1;
          break;
        }
        if (value === 0 && !v) {
          hit = 0;
          break;
        }
      }
      out[y * W + x] = hit;
    }
  }
  return out;
}
