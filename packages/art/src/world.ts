import { z } from "zod";
import {
  Color,
  Id,
  newRoomId,
  PieceKind,
  PlatformRect,
  RoomComposition,
  uniqueId,
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
    structures: `Sprite sheet: a 3x3 grid of nine separate LARGE background structures for a 2D side-view platformer set in ${theme}: tall pillars, broken arches, ruined walls, hanging root curtains, stalactite clusters, giant plant stalks and similar big shapes. Each one isolated, upright, side view, filling most of its cell, with empty space around it, on a fully transparent background.${extra} ${style(direction)}`,
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
      "For every non-empty cell give: a short name; kind (structure = big architecture or plant mass, decor = small thing on the ground, light = gives off light, hanging = hangs down from the ceiling); size = its natural on-screen height in px (characters are 40px tall, the room is 720px tall: pillars ~300-600, lanterns ~40-60, mushrooms ~20-60); glow = '#rrggbb' light color for anything that glows.",
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
    name = input.name?.trim() || theme.split(/[,.]/)[0]!.trim().slice(0, 60) || "Biome";
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
  /** Dress the arena with the new room. */
  dressArena?: boolean;
}

export async function worldComposeStage(ctx: ArtContext, input: WorldComposeInput): Promise<StageResult & { roomId: string }> {
  const project = ctx.project();
  const biome = findBiome(project, input.biomeId);
  if (!biome.kit) throw new StageError(`paint ${biome.name}'s kit first`);
  const kit = biome.kit;
  const { width, height } = project.sandbox;
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
        { type: "text", text: composePrompt(biome.brief, width, height, kit.pieces, input.newLayout ? null : project.sandbox.platforms, input.feedback) },
      ],
      maxTokens: 12000,
    },
    "composing the room",
  )) as z.infer<typeof RoomComposition> & { platforms?: z.infer<typeof PlatformRect>[] };
  const { platforms, ...composition } = composed;
  const pieceIds = new Set(kit.pieces.map((p) => p.id));
  const placements = composition.placements.filter((p) => pieceIds.has(p.piece));
  if (placements.length < composition.placements.length) {
    ctx.log({ text: `dropped ${composition.placements.length - placements.length} placement(s) of unknown pieces` });
  }
  const name = input.name?.trim() || `${biome.name} ${biome.rooms.length + 1}`;
  const roomId = newRoomId(biome, name);
  return {
    operations: [
      {
        name: "addRoom",
        input: {
          assetId: biome.id,
          dressArena: input.dressArena ?? false,
          room: { id: roomId, name, composition: { ...composition, placements }, layout: platforms ?? null, cost: 0, at: new Date().toISOString() },
        },
      },
    ],
    roomId,
    summary: `composed ${name}${platforms ? " with a suggested layout" : ""}`,
  };
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
