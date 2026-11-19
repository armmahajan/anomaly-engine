import { z } from "zod";
import { Color, Id, MAX_PARTS, Part, Rig, Shape, type FileRef } from "@anomaly/core";
import { cutCharacter, placeCutout } from "./cutout.ts";
import { frameForCanvas, pngSize, toCanvasSpace, toRigSpace, type Frame } from "./frame.ts";
import { decodePng, type Pixels } from "./match.ts";
import { distanceTo, erode } from "./traced.ts";
import { detailAuthorPrompt, detailCritiquePrompt, detailSystemPrompt, paintOverPrompt } from "./prompts.ts";
import { askJson, BudgetExceeded, rigImages, StageError, type ArtContext, type StageResult } from "./stages.ts";
import {
  applySim,
  bakePart,
  boneGroups,
  explode,
  figureMask,
  maskBounds,
  meanColor,
  movedGroups,
  packAtlas,
  refinePiece,
  registerMasks,
  renderGroupMasks,
  renderPartMaps,
  sample,
  texturedParts,
  withTextures,
  type Atlas,
  type PartBake,
  type Similarity,
} from "./texture.ts";

/**
 * The look of a vector rig, after it is built and animated: the same shapes on the same bones
 * (clips untouched), dressed in more detail taken from the character's design.
 * - detail: the vision model adds vector detail shapes on the parts (shading bands, highlights,
 *   folds, seams, patterns, small accessories), clipped to their part, over look-and-fix rounds.
 * - projected: each part shows the design's own pixels for it as a texture (the design lined up
 *   with the rig, then each part fitted on its own), the flat fill where the design shows nothing.
 * - paintover: the rest pose with its bone groups pulled apart is painted over by one image edit
 *   in the design's style; the paint maps back onto each part (it lines up by construction).
 * - combo: detail shapes over a paint-over texture of the detailed rig at partial strength.
 * Textures are packed into one small atlas per character.
 */

export const LOOKS = ["detail", "projected", "paintover", "combo"] as const;
export type Look = (typeof LOOKS)[number];

const BACKGROUND = "#d8d6cf";
const GRID = 64;

const image = (data: Buffer) => ({ type: "image" as const, image: data });
const text = (t: string) => ({ type: "text" as const, text: t });

export interface LookInput {
  /** The rig (rig space) as built and animated. */
  rig: Rig;
  /** How the rig sits on `canvas` (the image it was traced on): rig = (canvas px - anchor) * scale. */
  frame: Frame;
  /** Size of that image (canvas px). */
  canvas: { width: number; height: number };
  /** The design to take the look from (any size; usually the concept the rig's design came from). */
  design: Buffer;
  brief: string;
  /** An object (hinged parts, no held equipment), not a character. */
  object?: boolean;
}

export interface LookResult {
  rig: Rig;
  /** Detail shapes added (canvas space, as the model wrote them). */
  details?: unknown[];
  score?: number;
  notes?: string;
  atlas?: { file: FileRef; width: number; height: number; bytes: number; scale: number };
  /** Per textured part: share of its shape the source covered. */
  coverage?: Record<string, number>;
  /** Paint-over: the exploded render sent and the painted image back. */
  exploded?: Buffer;
  painted?: Buffer;
  /** How well the source lined up with the rig (0-1 overlap). */
  registration?: number;
}

// --- shared ----------------------------------------------------------------------------

/** The rig drawn in canvas space (its own design's framing): alone on the background, and with a pixel grid. */
async function canvasRender(ctx: ArtContext, canvasRig: Rig, frame: Frame, canvas: { width: number; height: number }) {
  const direction = ctx.project().art.direction;
  const images = await rigImages(ctx, canvasRig);
  const drawn = await ctx.renderer.renderRig({
    rig: canvasRig,
    direction: { ...direction, inkWidth: direction.inkWidth / frame.scale },
    clips: {},
    frames: [{ clip: null, time: 0 }],
    cellWidth: canvas.width,
    cellHeight: canvas.height,
    columns: 1,
    background: null,
    fit: false,
    ...(images ? { images } : {}),
  });
  const [plain, gridded] = await Promise.all([
    ctx.renderer.compose({ ...canvas, background: BACKGROUND, layers: [{ image: drawn.png }] }),
    ctx.renderer.compose({ ...canvas, background: BACKGROUND, layers: [{ image: drawn.png }], grid: GRID }),
  ]);
  return { plain, gridded, warnings: drawn.warnings };
}

/** Pack baked textures into an atlas, store it, and put it on the rig. */
async function applyAtlas(ctx: ArtContext, rig: Rig, bakes: PartBake[], frame: Frame, opacity: number, maxSize: number) {
  const atlas: Atlas = packAtlas(bakes, maxSize);
  const file = await ctx.files.put(atlas.png, "png");
  return {
    rig: withTextures(rig, atlas, bakes, file, frame, opacity),
    atlas: { file, width: atlas.image.width, height: atlas.image.height, bytes: atlas.png.length, scale: Math.round(atlas.scale * 1000) / 1000 },
  };
}

const coverageOf = (rig: Rig, bakes: PartBake[]) => Object.fromEntries(bakes.map((b) => [rig.parts[b.part]!.id, Math.round(b.coverage * 100) / 100]));

/** The design's figure as a mask, and its background colour. */
function designFigure(design: Pixels): { pixels: Pixels; mask: Uint8Array; background: [number, number, number] } | null {
  const cut = cutCharacter(design);
  if (!cut) return null;
  const placed = placeCutout(cut, design);
  const mask = new Uint8Array(design.width * design.height);
  for (let i = 0; i < mask.length; i++) mask[i] = placed.data[i * 4 + 3]! >= 128 ? 1 : 0;
  return { pixels: design, mask, background: cut.background };
}

// --- detail shapes --------------------------------------------------------------------

const Detail = z.object({
  id: Id,
  on: Id,
  shape: Shape,
  fill: Color,
  opacity: z.number().min(0).max(1).optional(),
  clip: z.boolean().optional(),
  ink: z.number().min(0).max(3).optional(),
});
type Detail = z.infer<typeof Detail>;
const DetailsReply = z.object({ details: z.array(z.unknown()).max(MAX_PARTS), notes: z.string().optional() });
const DetailCritique = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string()).default([]), details: z.array(z.unknown()).max(MAX_PARTS).optional() });

/** Details the model wrote, the malformed ones dropped. */
function parseDetails(raw: unknown[]): Detail[] {
  return raw.flatMap((d) => {
    const parsed = Detail.safeParse(d);
    return parsed.success && parsed.data.shape.type !== "image" ? [parsed.data] : [];
  });
}

/**
 * The rig with detail shapes added as parts: each on its part's bone(s), drawn right above that
 * part (draw order renumbered so each part's details sit between it and the next part), clipped
 * to it unless asked not to. Unknown parts, bad shapes and details past the part limit are dropped.
 * `base` keeps its geometry exactly (`added` are in the same space as `base`).
 */
export function withDetails(base: Rig, added: Detail[]): { rig: Rig; kept: Detail[] } {
  const byId = new Map(base.parts.map((p) => [p.id, p]));
  const room = MAX_PARTS - base.parts.length;
  const ids = new Set(base.parts.map((p) => p.id));
  const kept: Detail[] = [];
  const parts = new Map<string, Part[]>();
  for (const d of added) {
    if (kept.length >= room) break;
    let parent = byId.get(d.on);
    if (!parent || parent.shape.type === "image") continue;
    // A detail on a clipped part sits on (and clips to) what that part clips to.
    if (parent.clipTo) parent = byId.get(parent.clipTo) ?? parent;
    let id = `${d.id}`.slice(0, 40);
    for (let n = 2; ids.has(id); n++) id = `${d.id.slice(0, 36)}_${n}`;
    const part = Part.safeParse({
      id,
      bone: parent.bone,
      ...(parent.bendTo ? { bendTo: parent.bendTo } : {}),
      z: 0,
      shape: d.shape,
      fill: d.fill,
      ink: d.ink ?? 0,
      opacity: d.opacity ?? 1,
      ...(d.clip === false ? {} : { clipTo: parent.id }),
    });
    if (!part.success) continue;
    ids.add(id);
    kept.push({ ...d, id });
    parts.set(parent.id, [...(parts.get(parent.id) ?? []), part.data]);
  }
  // Draw order: the base parts in their order (ties by position in the list), each followed by its details.
  const order = base.parts.map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z || a.i - b.i);
  const sequence = order.flatMap(({ p }) => [p, ...(parts.get(p.id) ?? [])]);
  const offset = Math.floor(sequence.length / 2);
  const zOf = new Map(sequence.map((p, i) => [p.id, Math.max(-100, Math.min(100, i - offset))]));
  const all = [...base.parts, ...[...parts.values()].flat()].map((p) => ({ ...p, z: zOf.get(p.id)! }));
  const rig = Rig.safeParse({ ...base, parts: all });
  if (!rig.success) throw new StageError(`detail shapes made an invalid rig: ${rig.error.issues[0]?.message}`);
  return { rig: rig.data, kept };
}

/** Detail shapes from canvas space onto a rig-space rig (the base parts keep their exact geometry). */
function detailsInRigSpace(rig: Rig, details: Detail[], frame: Frame): Detail[] {
  if (details.length === 0) return [];
  const root = rig.bones.find((b) => b.parent === null)!;
  const carrier: Rig = {
    bones: [root],
    parts: details.map((d, i) => ({ id: `d${i}`, bone: root.id, z: 0, shape: d.shape, fill: d.fill, ink: 0, glow: false, opacity: 1 })),
  };
  const mapped = toRigSpace(carrier, frame);
  return details.map((d, i) => ({ ...d, shape: mapped.parts[i]!.shape }));
}

export interface DetailOptions {
  /** Look-and-fix rounds (renders reviewed; default 3, the last one only scored). */
  rounds?: number;
}

/** The vision model adds detail shapes from the design, then reviews the render and fixes them; the best-scored attempt wins. */
export async function detailLook(ctx: ArtContext, input: LookInput, options: DetailOptions = {}): Promise<LookResult> {
  const { rig, frame, canvas, design, brief } = input;
  const canvasRig = toCanvasSpace(rig, frame);
  const maxDetails = MAX_PARTS - rig.parts.length;
  if (maxDetails <= 0) throw new StageError(`the rig already has ${rig.parts.length} parts (the most is ${MAX_PARTS}): no room for details`);
  const system = detailSystemPrompt(ctx.project().art.direction, canvas, input.object);
  const start = await canvasRender(ctx, canvasRig, frame, canvas);
  const authored = await askJson(
    ctx,
    DetailsReply,
    { system, content: [image(design), image(start.gridded), text(detailAuthorPrompt({ brief, rig: canvasRig, maxDetails }))], maxTokens: 16000 },
    "adding detail shapes",
  );
  let details = parseDetails(authored.details);
  const rounds = options.rounds ?? 3;
  let best: { details: Detail[]; score: number; notes: string } | null = null;
  for (let round = 0; round < rounds; round++) {
    const { rig: dressed, kept } = withDetails(canvasRig, details);
    details = kept;
    const view = await canvasRender(ctx, dressed, frame, canvas);
    ctx.log({ text: `details: render ${round + 1} (${kept.length} shapes)`, file: await ctx.files.put(view.plain, "png") });
    const critique = await askJson(
      ctx,
      DetailCritique,
      { system, content: [image(design), image(view.gridded), text(detailCritiquePrompt({ brief, rig: canvasRig, details: kept, maxDetails }))], maxTokens: 16000 },
      `reviewing details ${round + 1}`,
    );
    const notes = critique.issues.join("; ");
    ctx.log({ text: `details: score ${critique.score}/10${notes ? `: ${notes}` : ""}` });
    if (!best || critique.score > best.score) best = { details: kept, score: critique.score, notes };
    if (critique.score >= 9 || round === rounds - 1) break;
    const revised = parseDetails(critique.details ?? []);
    if (revised.length === 0) break;
    details = revised;
  }
  const chosen = best!;
  const { rig: dressed } = withDetails(rig, detailsInRigSpace(rig, chosen.details, frame));
  return { rig: dressed, details: chosen.details, score: chosen.score, notes: chosen.notes };
}

// --- projected: the design's own pixels ---------------------------------------------------------

export interface TextureOptions {
  /** Atlas size limit (px a side; default 512). */
  maxSize?: number;
  /** Texture strength over the flat fill (default 1). */
  opacity?: number;
  /** Set each textured part's flat fill to its texture's average colour (what shows where the source has nothing). */
  retint?: boolean;
  /** Paint-over: image quality for the edit (default "medium"). */
  quality?: string;
  /** Paint-over: ask once more when the painting doesn't line up (default true). */
  retry?: boolean;
}

/**
 * Projected texture: the design lined up with the rig's silhouette (scale and shift), its figure's
 * pixels given to the part drawn there (the rest to the nearest part through the figure), then
 * each part's own pixels fitted to the part (centre and spread per axis, within limits) and baked
 * over its whole shape. Stretches the design doesn't show for a part (hidden behind another) keep
 * the flat fill, except right next to the design's pixels.
 */
export async function projectedLook(ctx: ArtContext, input: LookInput, options: TextureOptions = {}): Promise<LookResult> {
  const { rig, frame, canvas } = input;
  const canvasRig = toCanvasSpace(rig, frame);
  const direction = ctx.project().art.direction;
  const probe = await renderPartMaps(ctx.renderer, canvasRig, canvas, [], decodePng, direction);
  const wanted = texturedParts(canvasRig, probe);
  const maps = await renderPartMaps(ctx.renderer, canvasRig, canvas, wanted, decodePng, direction);
  const figure = designFigure(decodePng(input.design));
  if (!figure) throw new StageError("could not find the character in the design");
  const { pixels: D, mask: Dmask, background: bg } = figure;
  const W = canvas.width;
  const H = canvas.height;
  const silhouette = Uint8Array.from(maps.visible, (v) => (v >= 0 ? 1 : 0));
  const global = registerMasks(silhouette, W, H, Dmask, D.width, D.height, { scaleRange: 0.25 });
  ctx.log({ text: `projected: the design lines up with the rig at ${Math.round(global.iou * 100)}% overlap` });

  // Label the design's figure: the part drawn there in the rig, else the nearest labelled pixel through the figure.
  const labels = new Int16Array(D.width * D.height).fill(-1);
  const queue: number[] = [];
  for (let y = 0; y < D.height; y++)
    for (let x = 0; x < D.width; x++) {
      const i = y * D.width + x;
      if (!Dmask[i]) continue;
      const rx = Math.round((x + 0.5 - global.t.tx) / global.t.s - 0.5);
      const ry = Math.round((y + 0.5 - global.t.ty) / global.t.s - 0.5);
      const v = rx >= 0 && ry >= 0 && rx < W && ry < H ? maps.visible[ry * W + rx]! : -1;
      if (v >= 0) {
        labels[i] = v;
        queue.push(i);
      }
    }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % D.width;
    const y = (i - x) / D.width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= D.width || ny >= D.height) continue;
      const j = ny * D.width + nx;
      if (Dmask[j] && labels[j] === -1) {
        labels[j] = labels[i]!;
        queue.push(j);
      }
    }
  }

  // Per bone group (a head with its hair, face and ear moves as one): line the design up with the
  // group by content, the rig's own drawing against the design, luminance only (so a recoloured
  // design still lines up): a shift and a scale about its centre, small ones preferred.
  const rendered = decodePng((await canvasRender(ctx, canvasRig, frame, canvas)).plain);
  const rigLum = luminance(rendered);
  const designLum = luminance(D);
  const groups = boneGroups(canvasRig);
  const groupMasks = await renderGroupMasks(ctx.renderer, canvasRig, canvas, groups, decodePng, direction);
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
  const fits = groupMasks.map((m) => {
    // Coarse: the group's outline against the design's figure (heads and tails find their place; pieces inside the figure stay put).
    const b = maskBounds(m, W, H);
    const size = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY) * global.t.s : 0;
    const coarse = refinePiece(m, W, H, Dmask, D.width, D.height, global.t, { shift: Math.max(4, Math.min(28, Math.round(size * 0.25))), scale: 0.25, scaleSteps: 5, step: 2 });
    // Fine: the drawing inside (eyes, folds, edges) by luminance, a few pixels at most.
    const fine = alignPart(m, W, H, rigLum, designLum, D.width, D.height, coarse.t, { reach: 6, scales: [0.95, 1, 1.05] });
    return { start: coarse.t, ...fine };
  });
  // The design's soft outer edge (anti-aliasing, its outline against the background) is left out.
  const inner = erode(Dmask, D.width, D.height, Math.max(2, Math.round(Math.max(D.width, D.height) * 0.008)));
  const bakes: PartBake[] = [];
  const shifts: Record<string, [number, number, number]> = {};
  for (const p of wanted) {
    const fit = fits[groupOf.get(canvasRig.parts[p]!.id)!]!;
    shifts[canvasRig.parts[p]!.id] = [Math.round(fit.dx * 10) / 10, Math.round(fit.dy * 10) / 10, Math.round(fit.k * 100) / 100];
    const map = (x: number, y: number): [number, number] => {
      const [qx, qy] = applySim(fit.start, x, y);
      return [fit.cx + (qx - fit.cx) * fit.k + fit.dx, fit.cy + (qy - fit.cy) * fit.k + fit.dy];
    };
    const pick = (x: number, y: number): [number, number, number] | null => {
      const [qx, qy] = map(x, y);
      const ix = Math.floor(qx);
      const iy = Math.floor(qy);
      if (ix < 0 || iy < 0 || ix >= D.width || iy >= D.height || !inner[iy * D.width + ix]) return null;
      // Where the part is drawn, whatever the design shows there; where it is hidden, only the design's pixels of this part.
      const shown = maps.visible[Math.floor(y) * W + Math.floor(x)] === p;
      if (!shown && labels[iy * D.width + ix] !== p) return null;
      const c = sample(D, qx, qy);
      return c && c[3] > 128 ? [c[0], c[1], c[2]] : null;
    };
    const reach = Math.max(4, Math.round(Math.min(W, H) * 0.012));
    // Twice: the second time without pixels nearer the design's background than the part's typical
    // colour (a pale halo or gap the design has around a dark part).
    const first = bakePart(p, maps.full.get(p)!, canvas, pick, { reach });
    const typical = first ? typicalColor(first) : null;
    const bake = typical
      ? bakePart(
          p,
          maps.full.get(p)!,
          canvas,
          (x, y) => {
            const c = pick(x, y);
            if (!c) return null;
            const toBg = Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
            const toPart = Math.hypot(c[0] - typical[0], c[1] - typical[1], c[2] - typical[2]);
            return toBg < 40 && toBg < toPart ? null : c;
          },
          { reach },
        )
      : first;
    if (bake && bake.coverage > 0) bakes.push(bake);
  }
  ctx.log({ text: `projected: per-part shifts [dx, dy, scale] ${JSON.stringify(shifts)}` });
  let base = rig;
  if (options.retint ?? true) base = retinted(rig, bakes, wanted);
  const applied = await applyAtlas(ctx, base, bakes, frame, options.opacity ?? 1, options.maxSize ?? 512);
  return { rig: applied.rig, atlas: applied.atlas, coverage: coverageOf(rig, bakes), registration: Math.round(global.iou * 1000) / 1000 };
}

/** The median colour of a bake's own (opaque) pixels. */
function typicalColor(bake: PartBake): [number, number, number] | null {
  const channels: number[][] = [[], [], []];
  const d = bake.image.data;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) for (let c = 0; c < 3; c++) channels[c]!.push(d[i + c]!);
  if (channels[0]!.length === 0) return null;
  return channels.map((v) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!) as [number, number, number];
}

/** Luminance per pixel (0-255; transparent pixels count as mid grey). */
function luminance(img: Pixels): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    const l = 0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!;
    out[i] = l * a + 128 * (1 - a);
  }
  return out;
}

/**
 * How to move the design (already lined up as a whole by `global`) for one piece (a mask): a shift
 * and a scale about its centre that best correlate (normalized cross-correlation of luminance) the
 * rig's drawing over the piece with the design, less a cost for moving far. Kept only when clearly
 * better than none.
 */
function alignPart(
  mask: Uint8Array,
  W: number,
  H: number,
  rigLum: Float32Array,
  designLum: Float32Array,
  DW: number,
  DH: number,
  global: Similarity,
  options: { reach?: number; scales?: number[] } = {},
): { cx: number; cy: number; k: number; dx: number; dy: number } {
  const b = maskBounds(mask, W, H);
  const none = { cx: 0, cy: 0, k: 1, dx: 0, dy: 0 };
  if (!b) return none;
  const step = Math.max(1, Math.round(Math.sqrt(b.count / 2500)));
  const xs: number[] = [];
  const ys: number[] = [];
  const r: number[] = [];
  for (let y = b.minY; y < b.maxY; y += step)
    for (let x = b.minX; x < b.maxX; x += step)
      if (mask[y * W + x]) {
        const [qx, qy] = applySim(global, x + 0.5, y + 0.5);
        xs.push(qx);
        ys.push(qy);
        r.push(rigLum[y * W + x]!);
      }
  const n = r.length;
  if (n < 16) return none;
  const rMean = r.reduce((s, v) => s + v, 0) / n;
  const rDev = r.map((v) => v - rMean);
  const rNorm = Math.sqrt(rDev.reduce((s, v) => s + v * v, 0));
  if (rNorm < 1e-3) return none;
  const cx = xs.reduce((s, v) => s + v, 0) / n;
  const cy = ys.reduce((s, v) => s + v, 0) / n;
  const ncc = (k: number, dx: number, dy: number) => {
    let sum = 0;
    let sum2 = 0;
    let cross = 0;
    for (let i = 0; i < n; i++) {
      const qx = Math.round(cx + (xs[i]! - cx) * k + dx - 0.5);
      const qy = Math.round(cy + (ys[i]! - cy) * k + dy - 0.5);
      const d = qx >= 0 && qy >= 0 && qx < DW && qy < DH ? designLum[qy * DW + qx]! : 128;
      sum += d;
      sum2 += d * d;
      cross += rDev[i]! * d;
    }
    const varD = sum2 - (sum * sum) / n;
    return varD <= 1e-6 ? -1 : cross / (rNorm * Math.sqrt(varD));
  };
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY) * global.s;
  const reach = options.reach ?? Math.max(4, Math.min(24, Math.round(size * 0.2)));
  // Small moves preferred: a full-reach shift or the widest scale costs 0.15 of correlation.
  const cost = (k: number, dx: number, dy: number) => 0.15 * ((dx * dx + dy * dy) / (reach * reach)) + 0.15 * Math.abs(Math.log(k) / Math.log(1.25));
  const base = ncc(1, 0, 0);
  let best = { k: 1, dx: 0, dy: 0, score: base };
  for (const k of options.scales ?? [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.17, 1.25])
    for (let dx = -reach; dx <= reach; dx += 2)
      for (let dy = -reach; dy <= reach; dy += 2) {
        const v = ncc(k, dx, dy) - cost(k, dx, dy);
        if (v > best.score) best = { k, dx, dy, score: v };
      }
  for (let dx = best.dx - 1; dx <= best.dx + 1; dx++)
    for (let dy = best.dy - 1; dy <= best.dy + 1; dy++) {
      const v = ncc(best.k, dx, dy) - cost(best.k, dx, dy);
      if (v > best.score) best = { ...best, dx, dy, score: v };
    }
  return best.score > base + 0.02 ? { cx, cy, k: best.k, dx: best.dx, dy: best.dy } : { ...none, cx, cy };
}

/** Each baked part's flat fill (and shade) moved to its texture's average colour, so stretches the texture leaves bare match it. */
function retinted(rig: Rig, bakes: PartBake[], others: number[] = []): Rig {
  const fills = new Map<number, string>();
  // Original fill -> its texture's colour, for whole parts left without a texture.
  const byFill = new Map<string, string>();
  for (const b of bakes) {
    const c = b.coverage >= 0.2 ? meanColor(b) : null;
    if (!c) continue;
    fills.set(b.part, c);
    const original = rig.parts[b.part]!.fill.toLowerCase();
    if (!byFill.has(original)) byFill.set(original, c);
  }
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const hex = (c: number[]) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
  return {
    ...rig,
    parts: rig.parts.map((p, i) => {
      const fill = fills.get(i);
      if (fill) {
        const { shade: _shade, ...rest } = p;
        return { ...rest, fill };
      }
      const moved = others.includes(i) ? byFill.get(p.fill.toLowerCase()) : undefined;
      if (!moved) return p;
      // Its shade moves by the same ratio as its fill.
      const [from, to] = [rgb(p.fill), rgb(moved)];
      const shade = p.shade && { ...p.shade, color: hex(rgb(p.shade.color).map((v, c) => (v * (to[c]! + 1)) / (from[c]! + 1))) };
      return { ...p, fill: moved, ...(shade ? { shade } : {}) };
    }),
  };
}

// --- paint-over: the exploded rest pose painted in the design's style ------------------------------

const PAINT_SIZE = 1024;
/** Paint-over: ask again (once) when the painting lines up with the pieces less than this (0-1 overlap). */
const RETRY_BELOW = 0.65;
/** Paint-over: a group whose paint overlaps its pieces less than this keeps its flat fill. */
const GROUP_MIN = 0.55;
/** Paint-over: the most a painted pixel's luminance may differ from the piece it was painted over (0-255). */
const FLIP = 70;

/** A square mask twice as big (nearest neighbour). */
function upscale2(mask: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size * 2; y++) for (let x = 0; x < size * 2; x++) out[y * size * 2 + x] = mask[(y >> 1) * size + (x >> 1)]!;
  return out;
}
/** Gap between pulled-apart groups, as a share of the canvas. */
const EXPLODE_GAP = 0.025;

/**
 * Paint-over texture: the rig at rest with its bone groups pulled apart (nothing overlaps), drawn
 * large, painted over by one image edit with the design as reference; each group of the painting
 * is lined up with its pieces again (in case the model shifted it) and each part's paint baked
 * over its whole shape.
 */
export async function paintOverLook(ctx: ArtContext, input: LookInput, options: TextureOptions = {}): Promise<LookResult> {
  const { rig, frame, canvas, design, brief } = input;
  const canvasRig = toCanvasSpace(rig, frame);
  const direction = ctx.project().art.direction;
  const W = canvas.width;
  const H = canvas.height;
  const groups = boneGroups(canvasRig);
  const masks = await renderGroupMasks(ctx.renderer, canvasRig, canvas, groups, decodePng, direction);
  const offsets = explode(masks, W, H, Math.round(Math.max(W, H) * EXPLODE_GAP));
  const exploded = movedGroups(canvasRig, groups, offsets);

  // Exploded canvas -> paint px: fit the pulled-apart figure into the painting with a margin.
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  masks.forEach((m, g) => {
    const b = maskBounds(m, W, H);
    if (!b) return;
    const [dx, dy] = offsets[g]!;
    minX = Math.min(minX, b.minX + dx);
    minY = Math.min(minY, b.minY + dy);
    maxX = Math.max(maxX, b.maxX + dx);
    maxY = Math.max(maxY, b.maxY + dy);
  });
  const k = (PAINT_SIZE * 0.84) / Math.max(maxX - minX, maxY - minY, 1);
  const toPaint: Similarity = { s: k, tx: PAINT_SIZE / 2 - ((minX + maxX) / 2) * k, ty: PAINT_SIZE / 2 - ((minY + maxY) / 2) * k };
  // Rendered at half size (the renderer draws at most 512 px a cell) and scaled up for the edit.
  const half = PAINT_SIZE / 2;
  const renderRig = toCanvasSpace(exploded, { scale: 2 / k, anchor: [toPaint.tx / 2, toPaint.ty / 2] });
  const paintSize = { width: PAINT_SIZE, height: PAINT_SIZE };
  const drawn = await ctx.renderer.renderRig({
    rig: renderRig,
    direction: { ...direction, inkWidth: ((direction.inkWidth / frame.scale) * k) / 2, boil: 0 },
    clips: {},
    frames: [{ clip: null, time: 0 }],
    cellWidth: half,
    cellHeight: half,
    columns: 1,
    background: BACKGROUND,
    fit: false,
  });
  const sent = { png: await ctx.renderer.compose({ ...paintSize, background: BACKGROUND, layers: [{ image: drawn.png }] }) };
  ctx.log({ text: "paint-over: the pieces pulled apart", file: await ctx.files.put(sent.png, "png") });
  const paintMasks = (await renderGroupMasks(ctx.renderer, renderRig, { width: half, height: half }, groups, decodePng, direction)).map((m) => upscale2(m, half));

  const sentPixels = decodePng(sent.png);
  const sentFg = figureMask(sentPixels);
  const inkPx = Math.round((direction.inkWidth / frame.scale) * k);
  const drawnMasks = paintMasks.map((m) => {
    const d = distanceTo(m, PAINT_SIZE, PAINT_SIZE);
    return Uint8Array.from(d, (v) => (v <= inkPx ? 1 : 0));
  });

  /** One painting: asked for, scaled to the render's size, lined up with the pieces (as a whole, then each group a little). */
  const paint = async (strict: boolean) => {
    if (ctx.signal?.aborted) throw new StageError("cancelled");
    const generated = await ctx.image.generate({
      prompt: paintOverPrompt(brief, strict),
      references: [sent.png, design],
      quality: options.quality ?? "medium",
      signal: ctx.signal,
    });
    ctx.spend(generated.usage);
    ctx.log({ text: `paint-over${strict ? " (again, stricter)" : ""} (${generated.model})`, cost: generated.usage.cost });
    // The painting at the size of the render it was painted over (the edit is asked for square, like the render).
    const png = await ctx.renderer.compose({ ...paintSize, background: BACKGROUND, layers: [{ image: generated.image }] });
    const pixels = decodePng(png);
    // What was sent and what came back, each against its own flat background (outlines included).
    const fg = figureMask(pixels);
    const global = registerMasks(sentFg, PAINT_SIZE, PAINT_SIZE, fg, PAINT_SIZE, PAINT_SIZE, { scaleRange: 0.08, shiftRange: 48, start: { s: 1, tx: 0, ty: 0 } });
    ctx.log({ text: `paint-over: the painting lines up with the pieces at ${Math.round(global.iou * 100)}% overlap` });
    // Each group again, a little (the model may have nudged a piece), as drawn: grown by its outline.
    const groupsFit = drawnMasks.map((m) => refinePiece(m, PAINT_SIZE, PAINT_SIZE, fg, PAINT_SIZE, PAINT_SIZE, global.t, { shift: 12, scale: 0.05 }));
    return { png, pixels, fg, global, groupsFit };
  };
  let painting = await paint(false);
  // A painting that redrew the character instead of painting the pieces where they are: once more, more firmly.
  if (painting.global.iou < RETRY_BELOW && options.retry !== false) {
    const again = await paint(true);
    if (again.global.iou > painting.global.iou) painting = again;
  }
  const { png: paintedPng, pixels: P, fg: paintFg, global, groupsFit } = painting;
  // A group whose paint doesn't line up with its pieces keeps its flat fill.
  const perGroup = groupsFit.map((f) => f.t);
  const usable = groupsFit.map((f) => f.iou >= GROUP_MIN);
  ctx.log({ text: `paint-over: groups line up at ${groups.map((g, i) => `${g[0]} ${Math.round(groupsFit[i]!.iou * 100)}%`).join(", ")}` });
  const skipped = groups.filter((_, i) => !usable[i]).map((g) => g[0]);
  if (skipped.length) ctx.log({ text: `paint-over: no paint for ${skipped.join(", ")} (it did not line up)` });

  const probe = await renderPartMaps(ctx.renderer, canvasRig, canvas, [], decodePng, direction);
  const wanted = texturedParts(canvasRig, probe);
  const maps = await renderPartMaps(ctx.renderer, canvasRig, canvas, wanted, decodePng, direction);
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
  const bakes: PartBake[] = [];
  for (const p of wanted) {
    const g = groupOf.get(canvasRig.parts[p]!.id)!;
    if (!usable[g]) continue;
    const [dx, dy] = offsets[g]!;
    const t = perGroup[g]!;
    const bake = bakePart(
      p,
      maps.full.get(p)!,
      canvas,
      (x, y) => {
        const [px, py] = applySim(toPaint, x + dx, y + dy);
        const [qx, qy] = applySim(t, px, py);
        const ix = Math.floor(qx);
        const iy = Math.floor(qy);
        if (ix < 0 || iy < 0 || ix >= PAINT_SIZE || iy >= PAINT_SIZE || !paintFg[iy * PAINT_SIZE + ix]) return null;
        const c = sample(P, qx, qy);
        if (!c) return null;
        // The paint may recolour a piece but not turn light into dark or back (that is another piece, or the background).
        const o = (Math.round(py) * PAINT_SIZE + Math.round(px)) * 4;
        const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (Math.abs(lum(c[0], c[1], c[2]) - lum(sentPixels.data[o]!, sentPixels.data[o + 1]!, sentPixels.data[o + 2]!)) > FLIP) return null;
        return [c[0], c[1], c[2]];
      },
      { reach: Math.max(4, Math.round(Math.min(W, H) * 0.012)) },
    );
    if (bake && bake.coverage > 0) bakes.push(bake);
  }
  const base = options.retint ? retinted(rig, bakes, wanted) : rig;
  const applied = await applyAtlas(ctx, base, bakes, frame, options.opacity ?? 1, options.maxSize ?? 512);
  return {
    rig: applied.rig,
    atlas: applied.atlas,
    coverage: coverageOf(rig, bakes),
    exploded: sent.png,
    painted: paintedPng,
    registration: Math.round(global.iou * 1000) / 1000,
  };
}

// --- the stage --------------------------------------------------------------------------------

export interface DressInput {
  characterId: string;
  look: Look;
  /** The image to take the look from (default: the chosen design). */
  design?: FileRef;
  /** Detail: look-and-fix rounds (default 3). */
  rounds?: number;
  /** Combo: the paint-over's strength under the detail shapes (default 0.6). */
  textureOpacity?: number;
  /** Paint-over: image quality (default "medium"). */
  quality?: string;
}

/**
 * Dress a character's vector rig in more detail from its design (one of LOOKS). The clips stay as
 * they are: only the look changes. Opt-in (no default flow calls it yet).
 */
export async function dressRig(ctx: ArtContext, input: DressInput): Promise<StageResult & { result: LookResult }> {
  const project = ctx.project();
  const character = project.characters.find((c) => c.id === input.characterId);
  if (!character) throw new StageError(`no character "${input.characterId}"`);
  const asset = project.art.assets.find((a) => a.id === character.appearance);
  if (!asset || asset.kind !== "character" || !asset.rig || !asset.chosen) throw new StageError(`"${character.name}" needs a rig first`);
  if ((asset.rig.mode ?? "vector") === "cutout") throw new StageError("a cutout rig already shows its design: dressing is for vector rigs");
  const chosen = await ctx.files.get(asset.chosen.file);
  const canvas = pngSize(chosen);
  const frame = asset.preview?.frame ?? frameForCanvas(asset.rig, canvas);
  const design = input.design ? await ctx.files.get(input.design) : chosen;
  const base: LookInput = { rig: withoutTextures(asset.rig), frame, canvas, design, brief: asset.brief };
  const result = await look(ctx, base, input);
  return {
    operations: [{ name: "setRig", input: { assetId: asset.id, rig: result.rig } }],
    summary: `dressed ${character.name}'s rig (${input.look}${result.score !== undefined ? `, score ${result.score}/10` : ""})`,
    result,
  };
}

/** One look on a rig (no project needed). */
export async function look(ctx: ArtContext, base: LookInput, input: { look: Look; rounds?: number; textureOpacity?: number; quality?: string }): Promise<LookResult> {
  try {
    switch (input.look) {
      case "detail":
        return await detailLook(ctx, base, { rounds: input.rounds });
      case "projected":
        return await projectedLook(ctx, base);
      case "paintover":
        return await paintOverLook(ctx, base, { quality: input.quality, retint: true });
      case "combo": {
        const detailed = await detailLook(ctx, base, { rounds: input.rounds });
        const painted = await paintOverLook(ctx, { ...base, rig: detailed.rig }, { quality: input.quality, opacity: input.textureOpacity ?? 0.6 });
        return { ...painted, details: detailed.details, score: detailed.score, notes: detailed.notes };
      }
    }
  } catch (error) {
    if (error instanceof BudgetExceeded || error instanceof StageError) throw error;
    throw new StageError(`dressing the rig failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A rig without part textures (a new texture replaces an earlier one). */
export function withoutTextures(rig: Rig): Rig {
  return { ...rig, parts: rig.parts.map(({ texture: _texture, ...p }) => p) };
}
