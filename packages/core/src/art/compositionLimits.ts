import type { WorldLayer, WorldPiece } from "./world.ts";

/**
 * Restraint for AI-composed rooms. A room reads as deep when its layered
 * background planes stay visible and each layer holds a few well-chosen
 * pieces: distant structures small (far away, not walls), the back layer
 * modest, the play layer only what sits on platforms or frames the path, the
 * front a few framing silhouettes. Composers over-crowd and over-scale, so
 * after every AI compose and review round `limitComposition` scales pieces
 * down to their layer's size caps, then keeps the first ones (the composer's
 * order is its priority) up to the layer's count and coverage budgets.
 * Creator edits are never limited.
 */

export interface LayerLimit {
  /** Most pieces per view width of room (a room two views wide gets twice as many). */
  perView: number;
  /** Tallest drawn height, as a share of the view's height. */
  maxHeight: number;
  /** Widest drawn width, as a share of the view's width. */
  maxWidth: number;
  /** Most of the room's area the layer's pieces may cover together (by their bounding boxes). */
  maxCover: number;
}

/** Tuned on rendered rooms (a 14-row view, ~448px tall): see packages/art/test/world.test.ts. */
export const COMPOSITION_LIMITS: Record<WorldLayer, LayerLimit> = {
  /** The background planes are the far layer: no pieces there. */
  far: { perView: 0, maxHeight: 0, maxWidth: 0, maxCover: 0 },
  /** Distant shapes: small and few, so the planes behind show. */
  mid: { perView: 2, maxHeight: 0.4, maxWidth: 0.3, maxCover: 0.07 },
  back: { perView: 3, maxHeight: 0.55, maxWidth: 0.35, maxCover: 0.08 },
  /** Things sitting on platforms or framing the path. */
  play: { perView: 6, maxHeight: 0.45, maxWidth: 0.35, maxCover: 0.08 },
  /** A few framing silhouettes at the edges. */
  front: { perView: 1.5, maxHeight: 0.5, maxWidth: 0.3, maxCover: 0.06 },
};

/** View width per view height (the play camera is about 16:9). */
export const VIEW_ASPECT = 16 / 9;

/** The smallest scale a placement may have (the schema's minimum). */
const MIN_SCALE = 0.1;

export interface LimitRoom {
  width: number;
  height: number;
  /** Height (px) of the play camera's view. */
  view: number;
}

type Shape = Pick<WorldPiece, "id" | "size" | "width" | "height" | "kind">;
interface Limitable {
  id?: string;
  piece: string;
  layer: WorldLayer;
  scale?: number;
}

export interface LayerBudget {
  layer: WorldLayer;
  count: number;
  maxHeight: number;
  maxWidth: number;
  maxArea: number;
}

/** The per-layer budgets of one room, in px and pieces. */
export function compositionBudgets(room: LimitRoom): Record<WorldLayer, LayerBudget> {
  const viewWidth = room.view * VIEW_ASPECT;
  const views = Math.max(1, room.width / viewWidth);
  const out = {} as Record<WorldLayer, LayerBudget>;
  for (const [layer, limit] of Object.entries(COMPOSITION_LIMITS) as [WorldLayer, LayerLimit][]) {
    out[layer] = {
      layer,
      count: limit.perView === 0 ? 0 : Math.max(1, Math.round(limit.perView * views)),
      maxHeight: Math.round(limit.maxHeight * room.view),
      maxWidth: Math.round(limit.maxWidth * viewWidth),
      maxArea: limit.maxCover * room.width * room.height,
    };
  }
  return out;
}

export interface Limited<P> {
  placements: P[];
  /** Ids (or piece ids) of placements scaled down to their layer's size cap. */
  scaled: string[];
  /** Ids (or piece ids) of placements dropped over a count or coverage budget, or of unknown pieces' layers. */
  dropped: string[];
}

/** Scale every placement down to its layer's size caps, then keep the first ones within each layer's count and coverage budgets. */
export function limitComposition<P extends Limitable>(placements: P[], pieces: Shape[], room: LimitRoom): Limited<P> {
  const budgets = compositionBudgets(room);
  const shapes = new Map(pieces.map((p) => [p.id, p]));
  const used = new Map<WorldLayer, { count: number; area: number }>();
  const scaled: string[] = [];
  const dropped: string[] = [];
  const out: P[] = [];
  for (const p of placements) {
    const shape = shapes.get(p.piece);
    const name = p.id ?? p.piece;
    if (!shape) {
      out.push(p); // unknown pieces are someone else's problem (they are dropped before this)
      continue;
    }
    const budget = budgets[p.layer];
    const scale = p.scale ?? 1;
    const height = shape.size * scale;
    const width = height * (shape.width / shape.height);
    const fit = Math.min(scale, budget.maxHeight / Math.max(1, shape.size), (budget.maxWidth / Math.max(1, width)) * scale);
    const next = fit >= scale ? scale : Math.max(MIN_SCALE, Math.floor(fit * 100) / 100);
    const area = shape.size * next * (shape.size * next * (shape.width / shape.height));
    const sofar = used.get(p.layer) ?? { count: 0, area: 0 };
    // The first piece of a layer is kept even if it alone is over the coverage budget (it was scaled already).
    if (sofar.count >= budget.count || (sofar.count > 0 && sofar.area + area > budget.maxArea)) {
      dropped.push(name);
      continue;
    }
    used.set(p.layer, { count: sofar.count + 1, area: sofar.area + area });
    if (next < scale - 1e-9) {
      scaled.push(name);
      out.push({ ...p, scale: next });
    } else out.push(p);
  }
  return { placements: out, scaled, dropped };
}

/** The budgets in words, for compose and review prompts (so the AI works within them rather than against them). */
export function compositionLimitsText(room: LimitRoom): string {
  const b = compositionBudgets(room);
  const line = (layer: WorldLayer, what: string) =>
    `  ${layer}: at most ${b[layer].count} piece${b[layer].count === 1 ? "" : "s"}, each at most ${b[layer].maxHeight}px tall and ${b[layer].maxWidth}px wide once scaled (${what}), together covering at most ${Math.round(COMPOSITION_LIMITS[layer].maxCover * 100)}% of the room;`;
  return [
    "Hard limits per layer (enforced afterwards: oversized pieces are scaled down, and pieces past a layer's count or coverage are dropped from the end of your list, so put the most important first):",
    line("mid", "distant shapes: small, far away, never walls"),
    line("back", "modest"),
    line("play", "only what sits on platforms or frames the path"),
    line("front", "a few framing silhouettes at the room's edges"),
    "  far: none (the painted background planes are the far layer: leave them visible).",
  ].join("\n");
}
