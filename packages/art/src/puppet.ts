import { z } from "zod";
import { Id, MAX_PARTS, Point, Rig, type ArtDirection, type Bone, type Part } from "@anomaly/core";
import { CutoutPart, CutoutPlan, components, cutCharacter, solidMask, type Cutout } from "./cutout.ts";
import { hexRgb, type Pixels } from "./match.ts";
import { tracedRig } from "./traced.ts";

/**
 * Puppet rigs: the character drawn again by the image model as a sheet of separate pieces
 * (head, torso, upper arm, forearm, thigh, shin...), each piece whole (nothing hidden behind
 * another), traced as flat shapes and put back together on the skeleton planned on the design:
 * each piece is turned, scaled and moved so two of its points (a joint, the next joint or its
 * far tip, located on the sheet by the vision model) land on the same points of the design.
 * Far-side limbs reuse their near-side twin's piece, a little darker. Pure code; the stage
 * (stages.ts) makes the model calls.
 */

export const PuppetPart = CutoutPart.extend({
  piece: z.string().max(120).describe("The piece as drawn alone on a parts sheet."),
  twin: Id.optional().describe("A far-side limb drawn like this near-side part: reuse that part's piece."),
});
export const PuppetPlan = z
  .object({ bones: CutoutPlan.shape.bones, parts: z.array(PuppetPart).min(1).max(24), notes: z.string().optional() })
  .superRefine((plan, ctx) => {
    const check = CutoutPlan.safeParse(plan);
    if (!check.success) for (const issue of check.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    const ids = new Set(plan.parts.map((p) => p.id));
    for (const p of plan.parts) if (p.twin && (!ids.has(p.twin) || p.twin === p.id)) ctx.addIssue({ code: "custom", path: ["parts"], message: `part "${p.id}": twin "${p.twin}" is not another part` });
  });
export type PuppetPlan = z.infer<typeof PuppetPlan>;

/** The parts whose piece is drawn on the sheet (a twin of a twin, or of a missing part, is drawn itself). */
export function drawnParts(plan: PuppetPlan): PuppetPlan["parts"] {
  const byId = new Map(plan.parts.map((p) => [p.id, p]));
  return plan.parts.filter((p) => !p.twin || byId.get(p.twin)?.twin);
}

export interface SheetPiece {
  /** 1-based, in reading order (rows top to bottom, then left to right). */
  n: number;
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Pixel indices of the sheet's cutout image. */
  pixels: number[];
}

/** Pieces smaller than this share of the largest are specks. */
const MIN_PIECE = 0.03;

/** The separate pieces on a parts sheet (background removed), in reading order. */
export function sheetPieces(sheet: Pixels): { cut: Cutout; pieces: SheetPiece[] } | null {
  const cut = cutCharacter(sheet);
  if (!cut) return null;
  const { width: W, height: H } = cut.image;
  const [ox, oy] = cut.offset;
  const found = components(solidMask(cut.image), W, H, 8);
  const largest = Math.max(0, ...found.map((c) => c.length));
  const pieces = found
    .filter((c) => c.length >= MIN_PIECE * largest)
    .map((pixels) => {
      let [x0, y0, x1, y1] = [W, H, -1, -1];
      for (const i of pixels) {
        const x = i % W;
        const y = (i - x) / W;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
      return { n: 0, box: { x0: x0 + ox, y0: y0 + oy, x1: x1 + ox, y1: y1 + oy }, pixels };
    });
  // Reading order: rows (pieces whose vertical middles are within half a piece of each other), then x.
  pieces.sort((a, b) => (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2);
  const rows: SheetPiece[][] = [];
  for (const p of pieces) {
    const row = rows.at(-1);
    const mid = (p.box.y0 + p.box.y1) / 2;
    if (row && Math.abs(mid - (row[0]!.box.y0 + row[0]!.box.y1) / 2) < 0.5 * Math.max(row[0]!.box.y1 - row[0]!.box.y0, p.box.y1 - p.box.y0)) row.push(p);
    else rows.push([p]);
  }
  const ordered = rows.flatMap((row) => row.sort((a, b) => a.box.x0 - b.box.x0));
  ordered.forEach((p, i) => (p.n = i + 1));
  return { cut, pieces: ordered };
}

/** The sheet with each piece's box drawn (a distinct colour per piece), for the model. */
export function piecesView(sheet: Pixels, pieces: SheetPiece[]): Pixels {
  const out: Pixels = { width: sheet.width, height: sheet.height, data: sheet.data.slice() };
  const colors = [[230, 40, 40], [40, 160, 40], [40, 80, 230], [210, 140, 0], [170, 40, 200], [0, 170, 190]];
  for (const p of pieces) {
    const c = colors[(p.n - 1) % colors.length]!;
    const { x0, y0, x1, y1 } = p.box;
    for (let t = 0; t < 2; t++) {
      for (let x = x0 - 3 - t; x <= x1 + 2 + t; x++) for (const y of [y0 - 3 - t, y1 + 2 + t]) put(out, x, y, c);
      for (let y = y0 - 3 - t; y <= y1 + 2 + t; y++) for (const x of [x0 - 3 - t, x1 + 2 + t]) put(out, x, y, c);
    }
  }
  return out;
}

function put(img: Pixels, x: number, y: number, c: number[]): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  img.data.set([c[0]!, c[1]!, c[2]!, 255], (y * img.width + x) * 4);
}

export interface Anchor {
  at: [number, number];
  /** What the point is, in words the model can find on a lone piece. */
  label: string;
}

/**
 * Two points per part on the design (concept px) that the model can also find on its lone
 * piece: its joint with its parent's piece, where a child piece attaches, or its far tip; the
 * two furthest apart. Bones are the joint-aware pivots (cutout.ts jointPivots).
 */
export function partAnchors(plan: PuppetPlan, bones: Bone[], labels: Int32Array, cut: Cutout): Map<string, [Anchor, Anchor]> {
  const { width: W } = cut.image;
  const [ox, oy] = cut.offset;
  const pivot = new Map(bones.map((b) => [b.id, b.pivot]));
  const parentOf = new Map(bones.map((b) => [b.id, b.parent]));
  const partsOn = (bone: string) => plan.parts.filter((p) => p.bone === bone);
  const name = (p: PuppetPlan["parts"][number]) => p.piece.replace(/\s*\(.*\)\s*$/, "");
  const out = new Map<string, [Anchor, Anchor]>();
  plan.parts.forEach((part, k) => {
    const candidates: Anchor[] = [];
    const parent = parentOf.get(part.bone);
    const parentParts = parent ? partsOn(parent) : [];
    if (parent && parentParts.length > 0) candidates.push({ at: pivot.get(part.bone)!, label: `the joint where it attaches to ${name(parentParts[0]!)}` });
    for (const child of bones.filter((b) => b.parent === part.bone)) {
      const on = partsOn(child.id);
      if (on.length > 0) candidates.push({ at: child.pivot, label: `the point where ${name(on[0]!)} attaches` });
    }
    // Far tip: the part's pixel furthest from its first anchor (else from its bone's pivot).
    const from = candidates[0]?.at ?? pivot.get(part.bone)!;
    let tip: [number, number] | null = null;
    let tipD = -1;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== k) continue;
      const x = (i % W) + 0.5 + ox;
      const y = Math.floor(i / W) + 0.5 + oy;
      const d = Math.hypot(x - from[0], y - from[1]);
      if (d > tipD) (tipD = d), (tip = [x, y]);
    }
    if (tip) candidates.push({ at: tip, label: candidates.length > 0 ? `its far tip (the end furthest from ${candidates[0]!.label.replace(/^the /, "")})` : "its far tip" });
    if (candidates.length < 2) return;
    // The first anchor, and the candidate furthest from it.
    const a = candidates[0]!;
    const b = candidates.slice(1).sort((p, q) => Math.hypot(q.at[0] - a.at[0], q.at[1] - a.at[1]) - Math.hypot(p.at[0] - a.at[0], p.at[1] - a.at[1]))[0]!;
    if (Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]) < 3) return;
    out.set(part.id, [a, b]);
  });
  return out;
}

/** Where the model found a part on the sheet: its piece, its two anchors (sheet px), mirrored or not. */
export const PieceMatch = z.object({
  id: Id,
  piece: z.number().int().min(1).nullable(),
  a: Point.optional(),
  b: Point.optional(),
  flip: z.boolean().default(false),
});
export type PieceMatch = z.infer<typeof PieceMatch>;

/** A part's placement correction from the critic (concept px, degrees, a scale factor), applied after the anchors. */
export const PieceNudge = z.object({
  id: Id,
  dx: z.number().default(0),
  dy: z.number().default(0),
  rotate: z.number().min(-90).max(90).default(0),
  scale: z.number().min(0.6).max(1.6).default(1),
});
export type PieceNudge = z.infer<typeof PieceNudge>;

/** How far a part's own scale may stray from the pieces' median (the sheet draws every piece at one scale). */
const SCALE_SPREAD = 1.3;
/** Far-side twins are this much darker (toward the ink). */
const FAR_SHADE = 0.18;

export interface PuppetBuild {
  /** Canvas-space rig (concept px). */
  rig: Rig;
  warnings: string[];
  /** Parts drawn from the concept because their piece was missing or unusable. */
  fallback: string[];
}

/**
 * Put the puppet together: each part's piece traced (clean tracer) on the sheet, moved onto the
 * design by its anchors (plus the critic's nudges), far twins reusing their near piece; a part
 * with no usable piece keeps its shapes traced from the design itself (`conceptRig`, a traced
 * rig of the same plan). Canvas px, bones as given (the design's joint pivots).
 */
export function assemblePuppet(input: {
  plan: PuppetPlan;
  bones: Bone[];
  anchors: Map<string, [Anchor, Anchor]>;
  sheet: { cut: Cutout; pieces: SheetPiece[] };
  matches: PieceMatch[];
  nudges?: PieceNudge[];
  conceptRig: Rig;
  direction: Pick<ArtDirection, "palette" | "ink" | "inkWidth">;
  /** Concept px per game px. */
  canvasPerGamePx: number;
}): PuppetBuild {
  const { plan, bones, anchors, sheet, direction } = input;
  const warnings: string[] = [];
  const fallback: string[] = [];
  const byId = new Map(input.matches.map((m) => [m.id, m]));
  const nudge = new Map((input.nudges ?? []).map((n) => [n.id, n]));
  const usedBy = new Map<number, string[]>();
  for (const m of input.matches) if (m.piece !== null) usedBy.set(m.piece, [...(usedBy.get(m.piece) ?? []), m.id]);

  // Each part: the match it uses (its own, or its twin's) and its raw scale.
  const source = (part: PuppetPlan["parts"][number]) => (part.twin && byId.get(part.twin)?.piece ? byId.get(part.twin)! : byId.get(part.id));
  const placements = plan.parts.map((part) => {
    const match = source(part);
    const anchor = anchors.get(part.id);
    const piece = match?.piece ? sheet.pieces.find((p) => p.n === match.piece) : undefined;
    if (!match || !piece || !match.a || !match.b || !anchor) return { part, ok: false as const };
    if ((usedBy.get(piece.n) ?? []).filter((id) => !plan.parts.find((p) => p.id === id)?.twin).length > 1) {
      warnings.push(`piece ${piece.n} was matched to several parts (${usedBy.get(piece.n)!.join(", ")}): they are drawn from the design`);
      return { part, ok: false as const };
    }
    const v = [match.b[0] - match.a[0], match.b[1] - match.a[1]];
    const u = [anchor[1].at[0] - anchor[0].at[0], anchor[1].at[1] - anchor[0].at[1]];
    const lv = Math.hypot(v[0]!, v[1]!);
    if (lv < 3) return { part, ok: false as const };
    return { part, ok: true as const, match, piece, anchor, scale: Math.hypot(u[0]!, u[1]!) / lv };
  });
  const scales = placements.flatMap((p) => (p.ok ? [p.scale] : [])).sort((a, b) => a - b);
  const median = scales[Math.floor(scales.length / 2)] ?? 1;

  const traced = new Map<number, Part[]>();
  const tracePiece = (piece: SheetPiece, scale: number): Part[] => {
    const hit = traced.get(piece.n);
    if (hit) return hit;
    const parts = traceSheetPiece(sheet.cut, piece, direction, input.canvasPerGamePx / scale);
    traced.set(piece.n, parts);
    return parts;
  };

  const shapesOf = new Map<string, Part[]>();
  for (const p of placements) {
    if (!p.ok) {
      const own = input.conceptRig.parts.filter((s) => new RegExp(`^${p.part.id}(_\\d+)?(_ink|_d\\d+)?$`).test(s.id));
      if (own.length > 0) fallback.push(p.part.id);
      shapesOf.set(p.part.id, own);
      continue;
    }
    const { match, piece, anchor, part } = p;
    const scale = Math.min(median * SCALE_SPREAD, Math.max(median / SCALE_SPREAD, p.scale)) * (nudge.get(part.id)?.scale ?? 1);
    // Sheet px -> concept px: (mirror about the piece's middle,) rotate and scale about anchor a, put a on the design's anchor.
    const mid = (piece.box.x0 + piece.box.x1) / 2;
    const mirror = (q: readonly [number, number]): [number, number] => (match.flip ? [2 * mid - q[0], q[1]] : [q[0], q[1]]);
    const a = mirror(match.a!);
    const b = mirror(match.b!);
    const angle =
      Math.atan2(anchor[1].at[1] - anchor[0].at[1], anchor[1].at[0] - anchor[0].at[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]) + ((nudge.get(part.id)?.rotate ?? 0) * Math.PI) / 180;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const [tx, ty] = [anchor[0].at[0] + (nudge.get(part.id)?.dx ?? 0), anchor[0].at[1] + (nudge.get(part.id)?.dy ?? 0)];
    const map = (q: readonly [number, number]): [number, number] => {
      const [x, y] = mirror(q);
      const dx = (x - a[0]) * scale;
      const dy = (y - a[1]) * scale;
      return [round1(tx + dx * cos - dy * sin), round1(ty + dx * sin + dy * cos)];
    };
    const far = part.twin !== undefined && byId.get(part.twin)?.piece !== undefined;
    const shapes = tracePiece(piece, scale).map((s): Part => {
      return {
        ...s,
        id: s.id.replace(/^piece/, part.id),
        bone: part.bone,
        fill: far && s.ink === 0 ? shade(s.fill, direction.ink, FAR_SHADE) : s.fill,
        shape: transformShape(s.shape, map, match.flip),
      };
    });
    shapesOf.set(part.id, shapes);
  }

  // Draw order: the plan's z, then each piece's own order; ids unique; within the part budget (smallest colour details go first).
  const order = plan.parts.map((_, k) => k).sort((a, b) => plan.parts[a]!.z - plan.parts[b]!.z || a - b);
  let all = order.flatMap((k) => shapesOf.get(plan.parts[k]!.id) ?? []);
  if (all.length > MAX_PARTS) {
    const details = all.filter((s) => /_d\d+$/.test(s.id)).sort((p, q) => area(q) - area(p));
    const drop = new Set(details.slice(Math.max(0, details.length - (all.length - MAX_PARTS))));
    warnings.push(`dropped the ${drop.size} smallest colour details (part budget)`);
    all = all.filter((s) => !drop.has(s));
  }
  const ids = new Set<string>();
  const parts = all.map((s, i) => {
    let id = s.id;
    while (ids.has(id)) id = `${id}_x`;
    ids.add(id);
    return { ...s, id, z: i - Math.floor(all.length / 2) };
  });
  return { rig: Rig.parse({ mode: "traced", bones, parts }), warnings, fallback };
}

/** One sheet piece traced as flat shapes (clean tracer), in sheet px; ids "piece", "piece_ink", "piece_d<n>". */
function traceSheetPiece(sheetCut: Cutout, piece: SheetPiece, direction: Pick<ArtDirection, "palette" | "ink" | "inkWidth">, canvasPerGamePx: number): Part[] {
  const { width: W, data } = sheetCut.image;
  const [ox, oy] = sheetCut.offset;
  const M = 4;
  const x0 = piece.box.x0 - ox - M;
  const y0 = piece.box.y0 - oy - M;
  const w = piece.box.x1 - piece.box.x0 + 2 * M;
  const h = piece.box.y1 - piece.box.y0 + 2 * M;
  const out = new Uint8Array(w * h * 4);
  for (const i of piece.pixels) {
    const x = (i % W) - x0;
    const y = Math.floor(i / W) - y0;
    out.set(data.subarray(i * 4, i * 4 + 4), (y * w + x) * 4);
  }
  const cut: Cutout = {
    image: { width: w, height: h, data: out },
    offset: [x0 + ox, y0 + oy],
    bounds: { minX: piece.box.x0, minY: piece.box.y0, maxX: piece.box.x1, maxY: piece.box.y1 },
    background: sheetCut.background,
  };
  const { x0: bx0, y0: by0, x1: bx1, y1: by1 } = piece.box;
  const plan: CutoutPlan = {
    bones: [{ id: "piece", parent: null, pivot: [(bx0 + bx1) / 2, by1] }],
    parts: [{ id: "piece", bone: "piece", z: 0, region: [[bx0 - 2, by0 - 2], [bx1 + 2, by0 - 2], [bx1 + 2, by1 + 2], [bx0 - 2, by1 + 2]] }],
  };
  return tracedRig(cut, plan, direction, { canvasPerGamePx, clean: true }).rig.parts;
}

function transformShape(shape: Part["shape"], map: (q: readonly [number, number]) => [number, number], flip: boolean): Part["shape"] {
  if (shape.type === "blob") {
    // Mirroring reverses the outline's turn; the runtime doesn't care, but keep sharp indices as they are.
    return { ...shape, points: shape.points.map(map) };
  }
  if (shape.type === "stroke") return { ...shape, points: shape.points.map(map) };
  if (shape.type === "ellipse") return { ...shape, center: map(shape.center), rotation: flip ? -shape.rotation : shape.rotation };
  return shape;
}

function area(part: Part): number {
  const pts = "points" in part.shape ? part.shape.points : [];
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j]![0] + pts[i]![0]) * (pts[j]![1] - pts[i]![1]);
  return Math.abs(s / 2);
}

function shade(hex: string, toward: string, amount: number): string {
  const a = hexRgb(hex);
  const b = hexRgb(toward);
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * amount).toString(16).padStart(2, "0")).join("")}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
