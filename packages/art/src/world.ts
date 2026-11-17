import { z } from "zod";
import {
  Color,
  Id,
  newRoomId,
  PieceKind,
  PlatformRect,
  RoomComposition,
  snapPlacements,
  borderedGrid,
  gridPlatforms,
  gridSize,
  worldRoomFor,
  uniqueId,
  withPlacementIds,
  WorldLayer,
  type SnapRoom,
  type ArtDirection,
  type BiomeAsset,
  type BiomeKit,
  type OperationCall,
  type ProjectSpec,
  type WorldPiece,
} from "@anomaly/core";
import { parseReply } from "./json.ts";
import type { VisionContent, VisionRequest } from "./models.ts";
import { StageError, type ArtContext, type StageResult } from "./stages.ts";

/**
 * World stages. A biome's kit is paid for once: a painted backdrop, a 3x3
 * sheet of big structures, a 3x3 sheet of props (both transparent, sliced
 * automatically) and a ground texture, then one call labels the pieces.
 * Rooms are cheap text calls that compose the kit around a layout. The
 * runtime adds the depth (parallax, fog, lights, shafts, dust) for free.
 */

export type WorldQuality = "draft" | "final";
export type KitPart = "backdrop" | "structures" | "props" | "ground";

/** Per-image quality knob: draft = cheapest; final spends a little more on the pieces and backdrop. */
const QUALITY: Record<WorldQuality, Record<KitPart, string>> = {
  draft: { backdrop: "low", structures: "low", props: "low", ground: "low" },
  final: { backdrop: "medium", structures: "medium", props: "medium", ground: "low" },
};

const style = (d: ArtDirection) =>
  `Style: ${d.style} Painterly, soft edges. Preferred palette: ${d.palette.join(", ")}. No characters, no creatures, no text, no UI.`;

export function worldPrompts(theme: string, direction: ArtDirection, feedback?: string) {
  const extra = feedback?.trim() ? ` Creator's direction: ${feedback.trim()}.` : "";
  return {
    backdrop: `Farthest parallax background layer for a 2D side-scrolling platformer: ${theme}. Distant architecture and shapes fading into thick atmospheric haze, soft light from above, low contrast, wide horizontal composition with no strong focal point at the left or right edge, nothing in the immediate foreground, no ground plane in front.${extra} ${style(direction)}`,
    structures: `Sprite sheet: a 3x3 grid of nine separate LARGE background structures for a 2D side-view platformer set in ${theme}: tall pillars, broken arches, ruined walls, hanging root curtains, stalactite clusters, giant plant stalks and similar big shapes, plus one bare horizontal beam, plank or fallen log on its own: long and thin, lying flat, with nothing under it (no legs, posts or base). Each one isolated, upright (the beam lying flat), side view, filling most of its cell, with empty space around it, on a fully transparent background.${extra} ${style(direction)}`,
    props: `Sprite sheet: a 3x3 grid of nine separate small props for a 2D side-view platformer set in ${theme}: a light source (lantern or glowing thing), glowing plants or mushrooms, rubble, a hanging chain or vine, signs of past inhabitants, and other details that sit on the ground. Each prop isolated and centered in its cell with empty space around it, side view, on a fully transparent background.${extra} ${style(direction)}`,
    ground: `Seamless tileable square texture for the solid ground of a 2D platformer set in ${theme}: packed stone or earth with subtle cracks and moss, flat even lighting, no perspective, no objects, no lanterns, no light sources, no edges or borders.${extra} ${style(direction)}`,
  };
}

const PieceLabels = z.object({
  pieces: z
    .array(
      z.object({
        sheet: z.enum(["structures", "props"]),
        cell: z.number().int().min(0).max(8),
        name: z.string().max(80),
        kind: PieceKind,
        size: z.number().min(8).max(1200),
        glow: Color.optional(),
      }),
    )
    .max(18),
});

async function ask<T extends z.ZodType>(ctx: ArtContext, schema: T, request: VisionRequest, label: string): Promise<z.infer<T>> {
  if (ctx.signal?.aborted) throw new StageError("cancelled");
  let reply = await ctx.vision.complete({ ...request, json: true, signal: ctx.signal });
  ctx.spend(reply.usage);
  ctx.log({ text: `${label} (${ctx.vision.id})`, cost: reply.usage.cost });
  let parsed = parseReply(schema, reply.text);
  if (parsed.ok) return parsed.value;
  ctx.log({ text: `${label}: reply had problems, asking for a fix (${parsed.problems.slice(0, 160)})` });
  reply = await ctx.vision.complete({
    ...request,
    json: true,
    signal: ctx.signal,
    history: [
      { role: "user", content: request.content },
      { role: "assistant", content: reply.text },
    ],
    content: [{ type: "text", text: `That reply was invalid: ${parsed.problems}\nReply again with the complete corrected JSON only.` }],
  });
  ctx.spend(reply.usage);
  ctx.log({ text: `${label}: fix (${ctx.vision.id})`, cost: reply.usage.cost });
  parsed = parseReply(schema, reply.text);
  if (parsed.ok) return parsed.value;
  throw new StageError(`${label}: the model's reply was still invalid (${parsed.problems.slice(0, 300)})`);
}

function findBiome(project: ProjectSpec, biomeId: string): BiomeAsset {
  const asset = project.art.assets.find((a) => a.id === biomeId);
  if (!asset || asset.kind !== "biome") throw new StageError(`no biome "${biomeId}"`);
  return asset;
}

async function paint(ctx: ArtContext, part: KitPart, prompt: string, quality: WorldQuality): Promise<Buffer> {
  const img = await ctx.image.generate({
    prompt,
    aspectRatio: part === "backdrop" ? "3:2" : "1:1",
    transparent: part === "structures" || part === "props",
    quality: QUALITY[quality][part],
    signal: ctx.signal,
  });
  ctx.spend(img.usage);
  const file = await ctx.files.put(img.image, img.ext);
  ctx.log({ text: `${part} (${img.model}, ${QUALITY[quality][part]})`, cost: img.usage.cost, file });
  return img.image;
}

/** Slice sheets and label their pieces; existing ids are kept per cell so rooms keep working after a repaint. */
async function piecesFrom(
  ctx: ArtContext,
  sheets: Partial<Record<"structures" | "props", Buffer>>,
  previous: WorldPiece[],
): Promise<WorldPiece[]> {
  const sliced: Partial<Record<"structures" | "props", { png: Buffer; width: number; height: number; cell: number }[]>> = {};
  for (const sheet of ["structures", "props"] as const) {
    const image = sheets[sheet];
    if (image) sliced[sheet] = await ctx.renderer.sliceGrid(image, 3, 3, sheet === "props" ? 384 : 512);
  }
  const which = (Object.keys(sliced) as ("structures" | "props")[]).filter((s) => sliced[s]!.length > 0);
  if (which.length === 0) throw new StageError("the piece sheets came back empty");
  const content: VisionContent[] = which.map((s) => ({ type: "image" as const, image: sheets[s]! }));
  content.push({
    type: "text",
    text: [
      `Image${which.length > 1 ? "s" : ""}: ${which.map((s, i) => `${i + 1} = the '${s}' sheet`).join(", ")}; each is a 3x3 grid, cells 0-8 in reading order.`,
      `Non-empty cells: ${which.map((s) => `${s} ${sliced[s]!.map((p) => p.cell).join(", ")}`).join("; ")}.`,
      "For every non-empty cell give: a short name; kind (structure = big architecture or plant mass, decor = small thing on the ground, light = gives off light, hanging = hangs down from the ceiling, span = ONLY a bare horizontal beam, plank, lintel or log with nothing under it, meant to rest across two supports; anything with its own legs, posts or base is a structure); size = its natural on-screen height in px (characters are 40px tall, the room is 720px tall: pillars ~300-600, lanterns ~40-60, mushrooms ~20-60); glow = '#rrggbb' light color for anything that glows.",
      'Reply with JSON only: {"pieces": [{"sheet": "structures"|"props", "cell": 0-8, "name", "kind", "size", "glow"?}]}',
    ].join("\n"),
  });
  const labels = await ask(
    ctx,
    PieceLabels,
    {
      system: "You are a 2D game environment artist preparing a kit of sprites for a side-view platformer whose characters are about 40px tall.",
      content,
      maxTokens: 4000,
    },
    "labelling pieces",
  );
  const sheetOf = (id: string) => (id.startsWith("s") ? "structures" : "props");
  const out: WorldPiece[] = previous.filter((p) => !which.includes(sheetOf(p.id)));
  for (const label of labels.pieces) {
    if (!which.includes(label.sheet)) continue;
    const slice = sliced[label.sheet]!.find((p) => p.cell === label.cell);
    if (!slice) continue;
    const prefix = `${label.sheet === "structures" ? "s" : "p"}${label.cell}_`;
    const old = previous.find((p) => p.id.startsWith(prefix));
    const slug = label.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "piece";
    const id = old?.id ?? uniqueId(`${prefix}${slug}`, out.map((p) => p.id));
    if (!Id.safeParse(id).success || out.some((p) => p.id === id)) continue;
    out.push({
      id,
      file: await ctx.files.put(slice.png, "png"),
      name: label.name,
      kind: label.kind,
      width: slice.width,
      height: slice.height,
      size: label.size,
      ...(label.glow ? { glow: label.glow } : {}),
    });
  }
  return out;
}

// --- stage: kit ---------------------------------------------------------------------

export interface WorldKitInput {
  /** Existing biome to (re)paint; omit to create one. */
  biomeId?: string;
  name?: string;
  /** What the place is, in plain words. */
  theme?: string;
  quality?: WorldQuality;
  feedback?: string;
}

export async function worldKitStage(ctx: ArtContext, input: WorldKitInput): Promise<StageResult & { biomeId: string }> {
  const project = ctx.project();
  const operations: OperationCall[] = [];
  const biome = input.biomeId ? findBiome(project, input.biomeId) : null;
  const theme = input.theme?.trim() || biome?.brief;
  if (!theme) throw new StageError("describe the place (its theme) first");
  const quality = input.quality ?? biome?.kit?.quality ?? "draft";
  let biomeId: string;
  let name: string;
  if (!biome) {
    const fromTheme = theme.split(/[,.]/)[0]!.trim().slice(0, 60);
    name = input.name?.trim() || (fromTheme ? fromTheme[0]!.toUpperCase() + fromTheme.slice(1) : "Biome");
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 40) || "biome";
    biomeId = uniqueId(slug, project.art.assets.map((a) => a.id));
    operations.push({ name: "createAsset", input: { asset: { id: biomeId, name, kind: "biome", brief: theme } } });
  } else {
    biomeId = biome.id;
    name = biome.name;
    if (theme !== biome.brief) operations.push({ name: "updateAsset", input: { assetId: biomeId, changes: { brief: theme } } });
  }

  const prompts = worldPrompts(theme, project.art.direction, input.feedback);
  const [backdrop, structures, props, ground] = await Promise.all(
    (["backdrop", "structures", "props", "ground"] as const).map((part) => paint(ctx, part, prompts[part], quality)),
  );
  const pieces = await piecesFrom(ctx, { structures: structures!, props: props! }, biome?.kit?.pieces ?? []);
  const kit: BiomeKit = {
    backdrop: await ctx.files.put(await ctx.renderer.tileableX(backdrop!), "png"),
    ground: await ctx.files.put(await ctx.renderer.tileableX(ground!, 0.12), "png"),
    pieces,
    quality,
  };
  ctx.log({ text: `kit ready: ${pieces.length} pieces` });
  operations.push({ name: "setBiomeKit", input: { assetId: biomeId, kit } });
  return { operations, biomeId, summary: `painted the ${quality} kit for ${name}` };
}

// --- stage: repaint one part ---------------------------------------------------------

export interface WorldRepaintInput {
  biomeId: string;
  part: KitPart;
  feedback?: string;
}

export async function worldRepaintStage(ctx: ArtContext, input: WorldRepaintInput): Promise<StageResult> {
  const project = ctx.project();
  const biome = findBiome(project, input.biomeId);
  if (!biome.kit) throw new StageError(`paint ${biome.name}'s kit first`);
  const prompt = worldPrompts(biome.brief, project.art.direction, input.feedback)[input.part];
  const image = await paint(ctx, input.part, prompt, biome.kit.quality);
  let kit: BiomeKit = biome.kit;
  if (input.part === "backdrop") kit = { ...kit, backdrop: await ctx.files.put(await ctx.renderer.tileableX(image), "png") };
  else if (input.part === "ground") kit = { ...kit, ground: await ctx.files.put(await ctx.renderer.tileableX(image, 0.12), "png") };
  else kit = { ...kit, pieces: await piecesFrom(ctx, { [input.part]: image }, kit.pieces) };
  return { operations: [{ name: "setBiomeKit", input: { assetId: biome.id, kit } }], summary: `repainted ${biome.name}'s ${input.part}` };
}

// --- stage: compose a room ------------------------------------------------------------

export interface WorldComposeInput {
  biomeId: string;
  name?: string;
  feedback?: string;
  /** Also design new platforms (stored as a suggestion the creator can accept). */
  newLayout?: boolean;
  /** A world room to dress with the new room (its tiles are what the room is composed around). */
  dressRoom?: string;
  /** Recompose this existing room (same id, name and suggested layout) instead of adding one. */
  roomId?: string;
}

export async function worldComposeStage(ctx: ArtContext, input: WorldComposeInput): Promise<StageResult & { roomId: string }> {
  const project = ctx.project();
  const biome = findBiome(project, input.biomeId);
  if (!biome.kit) throw new StageError(`paint ${biome.name}'s kit first`);
  const kit = biome.kit;
  // Composed around a world room's tiles: the one it dresses (recomposing), the one to dress, else the playtest room.
  const target =
    (input.roomId ? worldRoomFor(project, biome.id, input.roomId) : project.world.rooms.find((r) => r.id === input.dressRoom)) ??
    project.world.rooms.find((r) => r.id === project.world.playtest?.room) ??
    project.world.rooms[0];
  const grid = target?.grid ?? borderedGrid(50, 23);
  const { width, height } = gridSize(grid);
  const arenaPlatforms = gridPlatforms(grid, project.world.ledgeThickness);
  const backdrop = await ctx.files.get(kit.backdrop);
  const schema = input.newLayout ? RoomComposition.extend({ platforms: z.array(PlatformRect).min(1).max(12) }) : RoomComposition;
  const composed = (await ask(
    ctx,
    schema,
    {
      system:
        "You are a level art director for a 2D side-scrolling platformer. You compose beautiful, deep, atmospheric rooms from a kit of sprites by writing scene data. You value negative space, clear silhouettes and a readable play area.",
      content: [
        { type: "image", image: backdrop },
        { type: "text", text: composePrompt(biome.brief, width, height, kit.pieces, input.newLayout ? null : arenaPlatforms, input.feedback) },
      ],
      maxTokens: 12000,
    },
    "composing the room",
  )) as z.infer<typeof RoomComposition> & { platforms?: z.infer<typeof PlatformRect>[] };
  const { platforms, ...raw } = composed;
  const pieceIds = new Set(kit.pieces.map((p) => p.id));
  const known = raw.placements.filter((p) => pieceIds.has(p.piece));
  if (known.length < raw.placements.length) {
    ctx.log({ text: `dropped ${raw.placements.length - known.length} placement(s) of unknown pieces` });
  }
  // Rest every piece on something, then look at the room and fix what's wrong.
  const room: SnapRoom = {
    width: Math.max(960, width),
    height: Math.max(360, height),
    // Nothing rests on breakable tiles (a ground pound removes them): gridPlatforms leaves them out.
    platforms: (platforms ?? arenaPlatforms).filter((r) => r.width >= 8 && r.height >= 8).map(({ x, y, width, height }) => ({ x, y, width, height })),
  };
  const snapped = snapPlacements(withPlacementIds(known), kit.pieces, room);
  if (snapped.moved > 0) ctx.log({ text: `snapped ${snapped.moved} piece(s) onto surfaces` });
  const reviewed = await reviewRoom(ctx, { theme: biome.brief, kit, composition: { ...raw, placements: snapped.placements }, room, feedback: input.feedback });
  const composition = reviewed.composition;
  const placements = composition.placements;
  const verdict = reviewed.score === null ? "" : ` (reviewed ${reviewed.score}/10${reviewed.fixes ? `, ${reviewed.fixes} fix${reviewed.fixes === 1 ? "" : "es"}` : ""})`;
  const existing = input.roomId ? biome.rooms.find((r) => r.id === input.roomId) : undefined;
  if (input.roomId && !existing) throw new StageError(`${biome.name} has no room "${input.roomId}"`);
  if (existing) {
    return {
      operations: [{ name: "setRoomComposition", input: { assetId: biome.id, roomId: existing.id, composition: { ...composition, placements } } }],
      roomId: existing.id,
      summary: `recomposed ${existing.name} for the new pieces${verdict}`,
    };
  }
  const name = input.name?.trim() || `${biome.name} ${biome.rooms.length + 1}`;
  const roomId = newRoomId(biome, name);
  return {
    operations: [
      {
        name: "addRoom",
        input: {
          assetId: biome.id,
          dressRoom: input.dressRoom ?? null,
          room: { id: roomId, name, composition: { ...composition, placements }, layout: platforms ?? null, cost: 0, at: new Date().toISOString() },
        },
      },
    ],
    roomId,
    summary: `composed ${name}${platforms ? " with a suggested layout" : ""}${verdict}`,
  };
}

// --- look and fix ------------------------------------------------------------------

/** Render width/height of one camera frame for reviews. */
const REVIEW_FRAME = { width: 960, height: 540 };
/** Don't start a review with less than this left in the job's budget. */
const REVIEW_RESERVE = 0.01;

const NewPlacement = z.object({
  piece: Id,
  layer: WorldLayer,
  x: z.number(),
  y: z.number(),
  scale: z.number().min(0.1).max(6).default(1),
  flip: z.boolean().default(false),
});

const RoomReview = z.object({
  score: z.number().min(0).max(10),
  issues: z.array(z.string()).max(20).default([]),
  fixes: z
    .array(
      z.object({
        id: z.string(),
        remove: z.boolean().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        scale: z.number().min(0.1).max(6).optional(),
        layer: WorldLayer.optional(),
        flip: z.boolean().optional(),
      }),
    )
    .max(60)
    .default([]),
  add: z.array(NewPlacement).max(6).default([]),
});
type RoomReview = z.infer<typeof RoomReview>;

type Composition = z.infer<typeof RoomComposition>;

interface ReviewInput {
  theme: string;
  kit: BiomeKit;
  composition: Composition;
  room: SnapRoom;
  feedback?: string;
}

/** Camera x positions that together show the whole room (at most 3 frames). */
function reviewCameras(room: SnapRoom): number[] {
  const view = (REVIEW_FRAME.width * room.height) / REVIEW_FRAME.height;
  if (room.width <= view * 1.1) return [room.width / 2];
  const n = Math.min(3, Math.ceil(room.width / view));
  return Array.from({ length: n }, (_, i) => Math.round(view / 2 + ((room.width - view) * i) / (n - 1)));
}

async function renderRoom(ctx: ArtContext, input: ReviewInput, composition: Composition, labels: boolean): Promise<Buffer> {
  const { kit, room } = input;
  const used = new Set(composition.placements.map((p) => p.piece));
  const refs = [kit.backdrop, kit.ground, ...kit.pieces.filter((p) => used.has(p.id)).map((p) => p.file)];
  const images = Object.fromEntries(await Promise.all([...new Set(refs)].map(async (ref) => [ref, (await ctx.files.get(ref)).toString("base64")] as const)));
  const scene = { name: "review", width: room.width, height: room.height, backdrop: kit.backdrop, ground: kit.ground, pieces: kit.pieces, platforms: room.platforms, ...composition };
  const shot = await ctx.renderer.renderWorld({ scene, images, cameras: reviewCameras(room), ...REVIEW_FRAME, labels });
  return shot.png;
}

/** Apply a review's edits; returns the new placements and how many edits took. */
function applyReview(composition: Composition, review: RoomReview, kit: BiomeKit): { composition: Composition; changes: number } {
  const fixes = new Map(review.fixes.map((f) => [f.id, f]));
  let changes = 0;
  const kept = composition.placements.flatMap((p) => {
    const fix = p.id ? fixes.get(p.id) : undefined;
    if (!fix) return [p];
    changes++;
    if (fix.remove) return [];
    const { id: _id, remove: _remove, ...edits } = fix;
    return [{ ...p, ...Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined)) }];
  });
  const pieceIds = new Set(kit.pieces.map((p) => p.id));
  const added = review.add.filter((a) => pieceIds.has(a.piece));
  changes += added.length;
  const placements = withPlacementIds([...kept, ...added.map((a) => ({ id: undefined as string | undefined, ...a }))]);
  return { composition: { ...composition, placements }, changes };
}

/**
 * Look and fix: render the room with each placement's id written on it, have the
 * vision model score it and name small edits (move, rescale, re-layer, remove, add),
 * snap again, repeat for `ctx.roomRounds` rounds (default 1). A fix that scores worse
 * than what it replaced is undone.
 */
async function reviewRoom(ctx: ArtContext, input: ReviewInput): Promise<{ composition: Composition; score: number | null; fixes: number }> {
  const rounds = ctx.roomRounds ?? 1;
  let current = input.composition;
  let best: { composition: Composition; score: number } | null = null;
  let revised = false;
  let fixes = 0;
  for (let round = 0; round < rounds; round++) {
    const shot = await renderRoom(ctx, input, current, true);
    ctx.log({ text: round === 0 ? "room render (ids for the review)" : `room render after fixes ${round}`, file: await ctx.files.put(shot, "png") });
    if (ctx.remaining() < REVIEW_RESERVE) {
      ctx.log({ text: "budget nearly used; skipping the room review" });
      break;
    }
    const prompt = reviewPrompt(input, current, reviewCameras(input.room).length);
    const review = await ask(
      ctx,
      RoomReview,
      {
        system: "You are a level art director reviewing a rendered 2D platformer room. You fix concrete problems with small, precise edits and leave what works alone.",
        content: [
          { type: "image", image: shot },
          { type: "text", text: prompt },
        ],
        maxTokens: 6000,
      },
      rounds > 1 ? `reviewing the room (${round + 1})` : "reviewing the room",
    );
    ctx.log({ text: `room score ${review.score}/10${review.issues.length ? `: ${review.issues.join("; ")}` : ""}` });
    if (best && revised && review.score <= best.score) {
      ctx.log({ text: "the fixes didn't help; keeping the earlier version" });
      current = best.composition;
      revised = false;
      break;
    }
    best = { composition: current, score: review.score };
    revised = false;
    if (review.score >= 8) break;
    const applied = applyReview(current, review, input.kit);
    if (applied.changes === 0) break;
    const snapped = snapPlacements(applied.composition.placements, input.kit.pieces, input.room);
    current = { ...applied.composition, placements: snapped.placements };
    revised = true;
    fixes += applied.changes;
    ctx.log({ text: `applied ${applied.changes} fix${applied.changes === 1 ? "" : "es"}${snapped.moved ? ` (${snapped.moved} re-snapped)` : ""}` });
  }
  if (revised) ctx.log({ text: "room after fixes", file: await ctx.files.put(await renderRoom(ctx, input, current, false), "png") });
  return { composition: current, score: best?.score ?? null, fixes: current === input.composition ? 0 : fixes };
}

function reviewPrompt(input: ReviewInput, composition: Composition, frames: number): string {
  const { room, kit } = input;
  const pieces = new Map(kit.pieces.map((p) => [p.id, p]));
  const unsupported = snapPlacements(composition.placements, kit.pieces, room).unsupported;
  const rows = composition.placements.map((p) => {
    const piece = pieces.get(p.piece);
    return `- ${p.id}: ${piece?.name ?? p.piece} (${piece?.kind ?? "?"}), ${p.layer}, x ${Math.round(p.x)}, y ${Math.round(p.y)}, scale ${p.scale}${p.flip ? ", flipped" : ""}`;
  });
  return [
    `The image is a composed room of a 2D side-scrolling platformer (biome: ${input.theme}) rendered in the game: ${frames === 1 ? "one camera view" : `${frames} camera views from left to right, stacked top to bottom`}. Each placed piece has its id written over it in yellow (labels are only for this review).`,
    `Room: ${room.width}x${room.height}px (x right, y DOWN). Walkable platforms: ${room.platforms.map((r) => `[x ${r.x}, y ${r.y}, w ${r.width}, h ${r.height}]`).join(", ")}.`,
    "Layers back to front: mid (distant, fogged, scrolls slower), back (just behind play, scrolls a bit slower), play (the walkable layer), front (near-black silhouettes that scroll faster). Because of parallax, mid/back/front pieces line up with the platforms only when the camera is near them.",
    "Each placement's y is its bottom (its top for hanging pieces).",
    `Placements:\n${rows.join("\n")}`,
    unsupported.length ? `These play pieces stand over nothing (no platform under their x): ${unsupported.join(", ")}.` : "",
    "Look for, most important first:",
    "1. pieces floating in the air, or clipping awkwardly into platforms (standing pieces rest on a surface; hanging ones hang from the top or a ledge's underside);",
    "2. pieces cluttering the walkable path or hiding platform edges; front silhouettes covering the middle of a view;",
    "3. scale mistakes (a small prop as big as a pillar, a pillar tiny beside a lantern) and pieces cut off in ugly ways;",
    "4. crowding and even rows (depth needs clusters and gaps), or dull empty stretches.",
    "Score 1-10 how good it looks as a finished game room. If it's below 8, fix the worst problems with small edits by id: move (x, y), rescale, change layer, flip, or remove; or add up to 6 placements from the kit. Don't rewrite what works. After your edits, standing play pieces drop onto the surface under their x, hanging ones rise to the ceiling, and spans rest on supports under both ends (structures in their layer or ledges), so x alone moves a piece onto a ledge.",
    `Kit pieces: ${kit.pieces.map((p) => `${p.id} (${p.name}, ${p.kind}, ${p.size}px)`).join(", ")}.`,
    input.feedback?.trim() ? `Creator's direction for this room: ${input.feedback.trim()}` : "",
    'Reply with JSON only: {"score", "issues": ["..."], "fixes": [{"id", "x"?, "y"?, "scale"?, "layer"?, "flip"?, "remove"?}], "add": [{"piece","layer","x","y","scale","flip"}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

function composePrompt(
  theme: string,
  width: number,
  height: number,
  pieces: WorldPiece[],
  platforms: { x: number; y: number; width: number; height: number }[] | null,
  feedback?: string,
): string {
  const list = pieces.map((p) => `- ${p.id}: ${p.name} (${p.kind}, ${p.size}px tall, ${(p.width / p.height).toFixed(2)} w/h${p.glow ? `, glows ${p.glow}` : ""})`);
  const layout = platforms
    ? `The walkable layout is FIXED (do not output platforms): ${platforms.map((r) => `[x ${r.x}, y ${r.y}, w ${r.width}, h ${r.height}]`).join(", ")}. Platforms outside 0..${width} are walls and can be ignored. Dress around it: props sit ON these surfaces.`
    : `Also design the walkable layout ("platforms"): a floor spanning the whole width (y around ${height - 110}, height 110+) plus 3-5 floating ledges or steps a 40px character could jump between (jumps ~150px high), inside the room and away from the ceiling.`;
  return [
    `The image is this biome's painted backdrop. Biome: ${theme}.`,
    `Compose one room ${width}px wide and ${height}px tall (x right, y DOWN, 0,0 = top-left). The camera shows about 960px of width at a time and pans across it.`,
    layout,
    "Layers, back to front (the runtime draws them with parallax, fog between them, depth tint and lighting):",
    "  far = the backdrop (already set; don't place pieces there); mid = big distant structures, tinted into the fog; back = decor and structures just behind the play layer; play = the walkable layer; front = near-black silhouettes in front of everything.",
    "For a piece's x, give the room x it is seen at. y is its bottom (on a floor or platform top), or its top for 'hanging' pieces (usually 0).",
    "'span' pieces (beams, lintels, logs) rest across two supports: put one between two structures of the same layer (x midway between them, y at their tops, scaled so its ends reach them) or across a gap between two ledges. Pieces are snapped onto their supports afterwards. Use each span piece at least once (in the mid or back layer between two structures, or in the play layer over a gap).",
    `Kit pieces:\n${list.join("\n")}`,
    "Budget per layer (this matters most; crowding kills depth):",
    "  mid: 5-8 big structures (scale 1.2-2.5), spaced 300-600px apart, standing on the floor line, some flipped;",
    "  back: at most 4 structures (scale 0.5-1.0, only at the room's ends or between ledges, never behind a ledge) plus 6-12 small decor pieces on the floor;",
    "  play: 12-25 props sitting ON surfaces (floor or ledge tops): lights on ledges and along the path, plants clustered at bases, a few hanging pieces from the ceiling;",
    "  front: 5-9 silhouettes: hanging pieces at y 0 near the room's ends and every ~700px, and tall structures standing at the bottom edge (cut off by it), scale 1.2-2.",
    "Leave the band between y 120 and the floor mostly open in the mid and back layers so the hazy backdrop shows through; vary spacing (clusters and gaps, not an even row).",
    "Atmosphere: palette.ambient a mid-dark tint (channels 0x70-0xa0; lights add on top); fog density behind mid/back/play 0.2-0.6 (deeper = foggier); 2-4 soft light shafts from above (rays); dust motes (amount 60-160). Colors must harmonize with the backdrop. Optional extra point lights (pieces of kind 'light' get their own).",
    feedback?.trim() ? `Creator's direction for this room: ${feedback.trim()}` : "",
    `Reply with JSON only: {"palette": {"ambient", "fog", "light", "shadow"},${platforms ? "" : ' "platforms": [{"x","y","width","height"}],'} "placements": [{"piece","layer","x","y","scale","flip"}], "lights": [{"x","y","color","energy","radius"}], "fog": {"mid","back","play"}, "rays": [{"x","width","angle","alpha"}], "dust": {"color","amount"}}`,
  ]
    .filter(Boolean)
    .join("\n");
}
