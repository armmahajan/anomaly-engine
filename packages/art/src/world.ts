import { z } from "zod";
import { Color, Id, PieceKind, WorldScene, type FileRef, type ArtDirection, type WorldPiece } from "@anomaly/core";
import { parseReply } from "./json.ts";
import type { ImageModel, ModelUsage, VisionModel } from "./models.ts";

/**
 * World generation (prototype): one biome kit -> one composed room.
 *
 * Paid once per biome: a painted backdrop, a sheet of 9 big structures, a
 * sheet of 9 props, and a ground texture (4 cheap images), plus two cheap
 * text calls to label the pieces and compose the room. Every further room
 * from the same kit is just another composition call (or a generator).
 * Depth (parallax, fog, lights, shafts, dust) is the runtime's job, free.
 */

export interface WorldRenderer {
  tileableX(image: Buffer, blend?: number): Promise<Buffer>;
  sliceGrid(image: Buffer, cols: number, rows: number, maxSize?: number): Promise<{ png: Buffer; width: number; height: number; cell: number }[]>;
}

export interface WorldContext {
  image: ImageModel;
  vision: VisionModel;
  renderer: WorldRenderer;
  files: { put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> };
  direction: ArtDirection;
  log(text: string, cost?: number): void;
  spend(usage: ModelUsage): void;
  signal?: AbortSignal;
}

export interface BiomeInput {
  name: string;
  /** What the place is, in plain words. */
  theme: string;
  /** Room size in world px (the sandbox is 720 tall). */
  width?: number;
  height?: number;
}

const style = (d: ArtDirection) =>
  `Style: ${d.style} Painterly, soft edges. Preferred palette: ${d.palette.join(", ")}. No characters, no creatures, no text, no UI.`;

export function worldPrompts(theme: string, direction: ArtDirection) {
  return {
    backdrop: `Farthest parallax background layer for a 2D side-scrolling platformer: ${theme}. Distant architecture and shapes fading into thick atmospheric haze, soft light from above, low contrast, wide horizontal composition with no strong focal point at the left or right edge, nothing in the immediate foreground, no ground plane in front. ${style(direction)}`,
    structures: `Sprite sheet: a 3x3 grid of nine separate LARGE background structures for a 2D side-view platformer set in ${theme}: tall pillars, broken arches, ruined walls, hanging root curtains, stalactite clusters, giant fungus stalks and similar big shapes. Each one isolated, upright, side view, filling most of its cell, with empty space around it, on a fully transparent background. ${style(direction)}`,
    props: `Sprite sheet: a 3x3 grid of nine separate small props for a 2D side-view platformer set in ${theme}: a light source (lantern or glowing thing), glowing plants or mushrooms, rubble, a hanging chain or vine, signs of past inhabitants, and other details that sit on the ground. Each prop isolated and centered in its cell with empty space around it, side view, on a fully transparent background. ${style(direction)}`,
    ground: `Seamless tileable square texture for the solid ground of a 2D platformer set in ${theme}: packed stone or earth with subtle cracks and moss, flat even lighting, no perspective, no objects, no lanterns, no light sources, no edges or borders. ${style(direction)}`,
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

const Composition = WorldScene.pick({ palette: true, platforms: true, placements: true, lights: true, fog: true, rays: true, dust: true });

async function askJson<T extends z.ZodType>(ctx: WorldContext, schema: T, system: string, content: Parameters<VisionModel["complete"]>[0]["content"], label: string, maxTokens: number): Promise<z.infer<T>> {
  let reply = await ctx.vision.complete({ system, content, json: true, maxTokens, signal: ctx.signal });
  ctx.spend(reply.usage);
  ctx.log(`${label} (${ctx.vision.id})`, reply.usage.cost);
  let parsed = parseReply(schema, reply.text);
  if (parsed.ok) return parsed.value;
  ctx.log(`${label}: fixing reply (${parsed.problems.slice(0, 160)})`);
  reply = await ctx.vision.complete({
    system,
    json: true,
    maxTokens,
    signal: ctx.signal,
    history: [
      { role: "user", content },
      { role: "assistant", content: reply.text },
    ],
    content: [{ type: "text", text: `That reply was invalid: ${parsed.problems}\nReply again with the complete corrected JSON only.` }],
  });
  ctx.spend(reply.usage);
  ctx.log(`${label}: fix (${ctx.vision.id})`, reply.usage.cost);
  parsed = parseReply(schema, reply.text);
  if (parsed.ok) return parsed.value;
  throw new Error(`${label}: still invalid (${parsed.problems.slice(0, 300)})`);
}

export async function generateBiome(ctx: WorldContext, input: BiomeInput): Promise<WorldScene> {
  const width = input.width ?? 2880;
  const height = input.height ?? 720;
  const prompts = worldPrompts(input.theme, ctx.direction);

  // 1. The kit: four cheap images, in parallel.
  const [backdropImg, structuresImg, propsImg, groundImg] = await Promise.all([
    ctx.image.generate({ prompt: prompts.backdrop, aspectRatio: "3:2", signal: ctx.signal }),
    ctx.image.generate({ prompt: prompts.structures, aspectRatio: "1:1", transparent: true, signal: ctx.signal }),
    ctx.image.generate({ prompt: prompts.props, aspectRatio: "1:1", transparent: true, signal: ctx.signal }),
    ctx.image.generate({ prompt: prompts.ground, aspectRatio: "1:1", signal: ctx.signal }),
  ]);
  for (const [name, img] of [["backdrop", backdropImg], ["structures sheet", structuresImg], ["props sheet", propsImg], ["ground texture", groundImg]] as const) {
    ctx.spend(img.usage);
    ctx.log(`${name} (${img.model})`, img.usage.cost);
  }

  // 2. Make it usable: seamless backdrop and ground, sliced pieces.
  const backdrop = await ctx.files.put(await ctx.renderer.tileableX(backdropImg.image), "png");
  const ground = await ctx.files.put(await ctx.renderer.tileableX(groundImg.image, 0.12), "png");
  const sheets = {
    structures: await ctx.renderer.sliceGrid(structuresImg.image, 3, 3),
    props: await ctx.renderer.sliceGrid(propsImg.image, 3, 3, 384),
  };
  ctx.log(`sliced ${sheets.structures.length} structures and ${sheets.props.length} props`);

  // 3. Name the pieces and size them (one call, both sheets).
  const labels = await askJson(
    ctx,
    PieceLabels,
    "You are a 2D game environment artist preparing a kit of sprites for a side-view platformer whose characters are about 40px tall.",
    [
      { type: "image", image: structuresImg.image },
      { type: "image", image: propsImg.image },
      {
        type: "text",
        text: [
          "Image 1 is the 'structures' sheet, image 2 the 'props' sheet; each is a 3x3 grid, cells 0-8 in reading order.",
          `Non-empty cells: structures ${sheets.structures.map((p) => p.cell).join(", ")}; props ${sheets.props.map((p) => p.cell).join(", ")}.`,
          "For every non-empty cell give: a short name; kind (structure = big architecture or plant mass, decor = small thing on the ground, light = gives off light, hanging = hangs down from the ceiling); size = its natural on-screen height in px (characters are 40px tall, the room is 720px tall: pillars ~300-600, lanterns ~40-60, mushrooms ~20-60); glow = '#rrggbb' light color for anything that glows.",
          'Reply with JSON only: {"pieces": [{"sheet": "structures"|"props", "cell": 0-8, "name", "kind", "size", "glow"?}]}',
        ].join("\n"),
      },
    ],
    "labelling pieces",
    4000,
  );

  const pieces: WorldPiece[] = [];
  for (const label of labels.pieces) {
    const slice = sheets[label.sheet].find((p) => p.cell === label.cell);
    if (!slice) continue;
    const id = `${label.sheet === "structures" ? "s" : "p"}${label.cell}_${label.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "piece"}`;
    if (pieces.some((p) => p.id === id) || !Id.safeParse(id).success) continue;
    pieces.push({
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

  // 4. Compose the room (data only), looking at the backdrop for the palette.
  return composeRoom(ctx, { ...input, width, height }, { backdrop, ground, pieces, backdropImage: backdropImg.image });
}

export interface BiomeKit {
  backdrop: FileRef;
  ground: FileRef;
  pieces: WorldPiece[];
  /** The backdrop's pixels, so the composer can match its colors. */
  backdropImage: Buffer;
}

/** One room from an existing kit: a single cheap text call. Call it again for more rooms. */
export async function composeRoom(ctx: WorldContext, input: BiomeInput & { width: number; height: number }, kit: BiomeKit): Promise<WorldScene> {
  const composition = await askJson(
    ctx,
    Composition,
    "You are a level art director for a 2D side-scrolling platformer. You compose beautiful, deep, atmospheric rooms from a kit of sprites by writing scene data. You value negative space, clear silhouettes and a readable play area.",
    [
      { type: "image", image: kit.backdropImage },
      { type: "text", text: composePrompt(input, input.width, input.height, kit.pieces) },
    ],
    "composing the room",
    12000,
  );
  const scene = WorldScene.parse({
    name: input.name,
    width: input.width,
    height: input.height,
    backdrop: kit.backdrop,
    ground: kit.ground,
    pieces: kit.pieces,
    ...composition,
  });
  ctx.log(`room composed: ${scene.placements.length} placements, ${scene.lights.length} extra lights, ${scene.platforms.length} platforms`);
  return scene;
}

function composePrompt(input: BiomeInput, width: number, height: number, pieces: WorldPiece[]): string {
  const list = pieces.map((p) => `- ${p.id}: ${p.name} (${p.kind}, ${p.size}px tall, ${(p.width / p.height).toFixed(2)} w/h${p.glow ? `, glows ${p.glow}` : ""})`);
  return [
    `The image is this biome's painted backdrop. Biome: ${input.theme}.`,
    `Compose one room ${width}px wide and ${height}px tall (x right, y DOWN, 0,0 = top-left). The camera shows about 960px of width at a time and pans across it.`,
    "Layers, back to front (the runtime draws them with parallax, fog between them, depth tint and lighting):",
    "  far = the backdrop (already set; don't place pieces there); mid = big distant structures, tinted into the fog (use several large structures, scale 1-2.5, spread across the room); back = decor and structures just behind the play layer; play = the walkable layer; front = near-black silhouettes in front of everything (a few hanging pieces from the ceiling at y 0 and tall shapes at the bottom edge, sparse so the play area stays readable).",
    "For a piece's x, give the room x it is seen at. y is its bottom (on a floor or platform top), or its top for 'hanging' pieces (usually 0).",
    `Kit pieces:\n${list.join("\n")}`,
    "Requirements:",
    `- platforms: a floor spanning the whole width (y around ${height - 110}, height 110+) plus 3-5 floating ledges or steps a character could jump between (40px tall characters, jumps ~150px high); keep platforms inside the room and away from the ceiling.`,
    "- Budget per layer (this matters most; crowding kills depth):",
    "  mid: 5-8 big structures (scale 1.2-2.5), spaced 300-600px apart, standing on the floor line, some flipped;",
    "  back: at most 4 structures (scale 0.5-1.0, only at the room's ends or between ledges, never behind a ledge) plus 6-12 small decor pieces on the floor;",
    "  play: 12-25 props sitting ON surfaces (floor or ledge tops): lights on ledges and along the path, plants clustered at bases, a few hanging pieces from the ceiling;",
    "  front: 5-9 silhouettes: hanging pieces at y 0 near the room's ends and every ~700px, and tall structures standing at y = room height + 60 (cut off by the bottom edge), scale 1.2-2.",
    "- Leave the band between y 120 and the floor mostly open in the mid and back layers so the hazy backdrop shows through; vary spacing (clusters and gaps, not an even row).",
    "- lights: optional extra point lights (pieces of kind 'light' get their own automatically); palette.ambient should be a mid-dark tint (not near-black, e.g. channels 0x70-0xa0) because lights add on top.",
    "- fog: density behind the mid, back and play layers (0.2-0.7; deeper layers foggier). rays: 2-4 soft light shafts from above. dust: floating motes (amount 60-160).",
    "- Colors must harmonize with the backdrop.",
    'Reply with JSON only: {"palette": {"ambient", "fog", "light", "shadow"}, "platforms": [{"x","y","width","height"}], "placements": [{"piece","layer","x","y","scale","flip"}], "lights": [{"x","y","color","energy","radius"}], "fog": {"mid","back","play"}, "rays": [{"x","width","angle","alpha"}], "dust": {"color","amount"}}',
  ].join("\n");
}

