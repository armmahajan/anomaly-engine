import { z } from "zod";
import {
  Color,
  Id,
  newRoomId,
  PieceKind,
  PlatformRect,
  RoomComposition,
  snapPlacements,
  limitComposition,
  compositionLimitsText,
  type LimitRoom,
  checkPlaneScales,
  kitFiles,
  ParticleKind,
  PLANE_RECIPE,
  type BackgroundPlane,
  type PlaneRecipe,
  clearPassages,
  dressingOutOfDate,
  borderedGrid,
  gridPlatforms,
  gridSize,
  DOOR_APPROACH,
  TILE,
  uniqueId,
  withPlacementIds,
  WorldLayer,
  type SnapRoom,
  type ArtDirection,
  type BiomeAsset,
  type BiomeKit,
  type DoorOpening,
  type OperationCall,
  type ProjectSpec,
  type WorldPiece,
  type WorldRoom,
  type WikiPage,
} from "@anomaly/core";
import { parseReply } from "./json.ts";
import { pngSize } from "./frame.ts";
import { decodePng } from "./match.ts";
import type { VisionContent, VisionRequest } from "./models.ts";
import { StageError, type ArtContext, type StageResult } from "./stages.ts";

/**
 * World stages. A biome's kit is paid for once: layered background planes (a
 * sky and two bands of silhouettes, core PLANE_RECIPE, at medium quality), a
 * 3x3 sheet of big structures, a 3x3 sheet of props (both transparent, sliced
 * automatically) and a ground texture, then one call labels the pieces (and
 * names what drifts in the air). What the sheets hold is planned first, from
 * the place itself (planKit): no fixed list of contents.
 * Rooms are cheap text calls that compose the kit around a layout. The
 * runtime adds the depth (parallax, fog, lights, shafts, dust) for free.
 */

export type WorldQuality = "draft" | "final";
/** `backgrounds`: every background plane; `backdrop`: an old kit's one backdrop, or a layered kit's sky. */
export type KitPart = "backdrop" | "backgrounds" | "structures" | "props" | "ground";
type PaintPart = "backdrop" | "plane" | "structures" | "props" | "ground";

/**
 * Per-image quality knob: draft = cheapest; final spends a little more on the pieces. Background
 * planes are always medium: they cover the whole screen, so they are what looks cheap first.
 */
const QUALITY: Record<WorldQuality, Record<PaintPart, string>> = {
  // Piece sheets at low quality come back as blocky pixel art (props drawn ~50 px tall still look chunky): medium.
  draft: { backdrop: "low", plane: "medium", structures: "medium", props: "medium", ground: "low" },
  final: { backdrop: "medium", plane: "medium", structures: "medium", props: "medium", ground: "low" },
};

export const style = (d: ArtDirection) =>
  `Style: ${d.style} Painterly, soft edges. Preferred palette: ${d.palette.join(", ")}. No characters, no creatures, no text, no UI.`;

// --- kit plan: what this place's sheets hold ------------------------------------------

/**
 * The roles composition needs from a kit (core PieceKind): structures that stand, ones that
 * hang from above and one bare span; props that give light, ones that sit on the ground and
 * ones that hang. What fills each role comes from the place, never from a fixed list.
 */
const StructureRole = z.enum(["standing", "hanging", "span"]);
const PropRole = z.enum(["light", "ground", "hanging"]);
const kitItem = <R extends z.ZodType>(role: R) => z.object({ name: z.string().trim().min(1).max(60), look: z.string().trim().max(240).default(""), role });

export const KitPlan = z
  .object({
    structures: z.array(kitItem(StructureRole)).min(6).max(9),
    props: z.array(kitItem(PropRole)).min(6).max(9),
    /** What the walkable ground is made of. */
    ground: z.string().trim().max(240).optional(),
  })
  .superRefine((plan, issue) => {
    const count = <T extends { role: string }>(list: T[], role: string) => list.filter((i) => i.role === role).length;
    if (count(plan.structures, "span") !== 1) issue.addIssue({ code: "custom", path: ["structures"], message: "exactly one structure must have role span" });
    if (count(plan.structures, "standing") < 4) issue.addIssue({ code: "custom", path: ["structures"], message: "at least 4 structures must be standing" });
    if (count(plan.structures, "hanging") < 1) issue.addIssue({ code: "custom", path: ["structures"], message: "at least 1 structure must be hanging" });
    if (count(plan.props, "light") < 1) issue.addIssue({ code: "custom", path: ["props"], message: "at least 1 prop must be a light" });
    if (count(plan.props, "ground") < 4) issue.addIssue({ code: "custom", path: ["props"], message: "at least 4 props must sit on the ground" });
  });
export type KitPlan = z.infer<typeof KitPlan>;

const ROLE_TEXT: Record<string, string> = {
  standing: "stands upright on its own base",
  hanging: "hangs down from above, its top flat where it attaches",
  span: "long and thin, lying flat, with nothing under it (no legs, posts or base)",
  light: "gives off light",
  ground: "sits on the ground",
};

const enumerate = (items: KitPlan["structures"] | KitPlan["props"]) =>
  items.map((item, i) => `${i + 1}. ${item.name}${item.look ? `: ${item.look.replace(/[.\s]+$/, "")}` : ""} (${ROLE_TEXT[item.role]})`).join("; ");

/** The wiki page of the place a biome paints: its region's page (by the biome's name), else a page titled like it. */
export function placePage(project: ProjectSpec, name?: string): WikiPage | undefined {
  const key = name?.trim().toLowerCase();
  if (!key) return undefined;
  const region = project.progression.regions.find((r) => r.name.trim().toLowerCase() === key && r.wikiPageId);
  return project.wiki.pages.find((p) => p.id === region?.wikiPageId) ?? project.wiki.pages.find((p) => p.title.trim().toLowerCase() === key);
}

export function kitPlanPrompt(theme: string, direction: ArtDirection, page?: WikiPage): string {
  const plain = (text: string) => text.replace(/\[\[[a-z0-9_]+\|([^\]\n]+)\]\]|\[\[([a-z0-9_]+)\]\]/g, (_, label, id) => label ?? id.replace(/_/g, " ")).replace(/\s+/g, " ").trim();
  const pageText = page
    ? [page.summary ? `${page.title}: ${page.summary}` : page.title, ...Object.entries(page.fields).map(([k, v]) => `${k}: ${v}`), page.body.slice(0, 1500)].map(plain).filter(Boolean).join(". ")
    : "";
  return [
    "Plan the kit of sprites for one place of a 2D side-view platformer: what its two sprite sheets hold.",
    `Place: ${theme}`,
    pageText ? `What the game's design says about it: ${pageText}` : "",
    `The game's look: ${direction.style}`,
    "List 9 structures (big background shapes, each 300-600px tall on a 720px-tall screen where characters are 40px tall) and 9 props (small details, 20-80px tall), each a short name and a one-sentence look (shape, material, color). Everything must belong to THIS place as described: its materials, nature, era and the people or things that live there. Take nothing from other places or a stock fantasy setting, and add nothing the description doesn't suggest; each item should tell the player where they are.",
    "Roles the room composer needs (give each item one):",
    "- structures: 5-7 'standing' (stand on the floor on their own base: big landmarks, masses, buildings, growths), 1-3 'hanging' (hang down from the ceiling or from above), and exactly 1 'span': a bare horizontal beam of this place's own material, long and thin, lying flat with nothing under it, that can rest across two supports;",
    "- props: 1-2 'light' (something that gives off light here), 5-7 'ground' (small details sitting on the ground), at most 1 'hanging' (a small thing hanging from above).",
    "Also give 'ground': what the walkable ground's surface is made of here, in a few words.",
    'Reply with JSON only: {"structures": [{"name", "look", "role": "standing"|"hanging"|"span"}], "props": [{"name", "look", "role": "light"|"ground"|"hanging"}], "ground": "..."}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** One text call: the 9 structures and 9 props (and the ground) that belong to this place. */
export async function planKit(ctx: ArtContext, theme: string, page?: WikiPage): Promise<KitPlan> {
  const plan = await ask(
    ctx,
    KitPlan,
    {
      system: "You are the environment art lead of an original 2D side-view game. You decide what each place is built from so it reads as itself at a glance.",
      content: [{ type: "text", text: kitPlanPrompt(theme, ctx.project().art.direction, page) }],
      maxTokens: 3000,
    },
    "planning the kit",
  );
  ctx.log({ text: `kit plan: ${plan.structures.map((s) => s.name).join(", ")} | ${plan.props.map((p) => p.name).join(", ")}` });
  return plan;
}

export function worldPrompts(theme: string, direction: ArtDirection, feedback?: string, plan?: KitPlan) {
  const extra = feedback?.trim() ? ` Creator's direction: ${feedback.trim()}.` : "";
  const sheet = "Smooth, clean anti-aliased edges and painted detail at full resolution: not pixel art.";
  const structures = plan
    ? `one per cell in reading order: ${enumerate(plan.structures)}.`
    : `made of what this place is made of: six or seven big shapes standing upright on their own bases, one or two that hang down from above, and one bare horizontal beam of the place's own material: ${ROLE_TEXT.span}.`;
  const props = plan
    ? `one per cell in reading order: ${enumerate(plan.props)}.`
    : "that belong to this place: one or two that give off light, small details that sit on the ground, and one small thing that hangs down from above.";
  const ground = plan?.ground ? plan.ground.replace(/[.\s]+$/, "") : "the surface this place's ground is made of";
  return {
    backdrop: `Farthest parallax background layer for a 2D side-scrolling platformer: ${theme}. The setting's distant landscape and shapes fading into atmospheric haze, low contrast, wide horizontal composition with no strong focal point at the left or right edge, nothing in the immediate foreground, no ground plane in front.${extra} ${style(direction)}`,
    structures: `Sprite sheet: a 3x3 grid of nine separate LARGE background structures for a 2D side-view platformer set in ${theme}, ${structures} Each one isolated, upright (the beam lying flat), side view, filling most of its cell, with empty space around it, on a fully transparent background. ${sheet}${extra} ${style(direction)}`,
    props: `Sprite sheet: a 3x3 grid of nine separate small props for a 2D side-view platformer set in ${theme}, ${props} Each prop isolated and centered in its cell with empty space around it, side view, on a fully transparent background. ${sheet}${extra} ${style(direction)}`,
    ground: `Seamless tileable square texture for the solid ground of a 2D platformer set in ${theme}: ${ground}, with subtle surface detail, flat even lighting, no perspective, no objects, no lamps or light sources, no edges or borders.${extra} ${style(direction)}`,
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
  /** What drifts in the biome's air. */
  particles: ParticleKind.optional(),
});

export async function ask<T extends z.ZodType>(ctx: ArtContext, schema: T, request: VisionRequest, label: string): Promise<z.infer<T>> {
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

export function findBiome(project: ProjectSpec, biomeId: string): BiomeAsset {
  const asset = project.art.assets.find((a) => a.id === biomeId);
  if (!asset || asset.kind !== "biome") throw new StageError(`no biome "${biomeId}"`);
  return asset;
}

async function paint(ctx: ArtContext, part: PaintPart, prompt: string, quality: WorldQuality, options: { transparent?: boolean; label?: string } = {}): Promise<Buffer> {
  if (ctx.signal?.aborted) throw new StageError("cancelled");
  const img = await ctx.image.generate({
    prompt,
    aspectRatio: part === "backdrop" || part === "plane" ? "3:2" : "1:1",
    transparent: options.transparent ?? (part === "structures" || part === "props"),
    quality: QUALITY[quality][part],
    signal: ctx.signal,
  });
  ctx.spend(img.usage);
  const file = await ctx.files.put(img.image, img.ext);
  ctx.log({ text: `${options.label ?? part} (${img.model}, ${QUALITY[quality][part]})`, cost: img.usage.cost, file });
  return img.image;
}

/** Share of the top quarter of a PNG that is see-through (1 for a non-PNG we can't read: trust it). */
function topClearShare(png: Buffer): number {
  let pixels;
  try {
    pixels = decodePng(png);
  } catch {
    return 1;
  }
  const rows = Math.max(1, Math.floor(pixels.height / 4));
  let clear = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < pixels.width; x++) if (pixels.data[(y * pixels.width + x) * 4 + 3]! < 32) clear++;
  return clear / (rows * pixels.width);
}

/**
 * Paint the kit's background planes (core PLANE_RECIPE), each made tileable left to right. A
 * silhouette plane that comes back without a see-through sky would hide the planes behind it, so
 * it is left out. Each plane gets at least the blur its enlargement on the biggest screen needs.
 */
async function paintPlanes(ctx: ArtContext, theme: string, direction: ArtDirection, quality: WorldQuality, feedback?: string): Promise<BackgroundPlane[]> {
  const painted = await Promise.all(
    PLANE_RECIPE.map(async (recipe) => ({ recipe, image: await paint(ctx, "plane", planePrompt(recipe, theme, direction, feedback), quality, { transparent: recipe.transparent, label: `${recipe.name} plane` }) })),
  );
  const out: BackgroundPlane[] = [];
  for (const { recipe, image: first } of painted) {
    let image = first;
    if (recipe.transparent && topClearShare(image) < 0.5) {
      // Image models sometimes paint a whole scene, sky and all: ask once more, plainly.
      ctx.log({ text: `the ${recipe.name} plane came back without a see-through sky; painting it again` });
      const again = `${planePrompt(recipe, theme, direction, feedback)} The upper part of the image must be empty and fully transparent (alpha 0): only the silhouettes are painted.`;
      image = await paint(ctx, "plane", again, quality, { transparent: true, label: `${recipe.name} plane, again` });
      if (topClearShare(image) < 0.5) {
        ctx.log({ text: `the ${recipe.name} plane came back without a see-through sky again; leaving it out` });
        continue;
      }
    }
    const tiled = await ctx.renderer.tileableX(image);
    const { width, height } = pngSize(tiled);
    const { transparent: _t, prompt: _p, ...plane } = recipe;
    const drawn: BackgroundPlane = { ...plane, file: await ctx.files.put(tiled, "png"), width, height };
    const [check] = checkPlaneScales([drawn]);
    if (check && !check.ok) drawn.blur = Math.min(16, Math.max(drawn.blur, Math.ceil(check.blurNeeded * 10) / 10));
    out.push(drawn);
  }
  if (!out.some((p) => p.opaque)) throw new StageError("the sky plane came back unusable");
  return out;
}

function planePrompt(recipe: PlaneRecipe, theme: string, direction: ArtDirection, feedback?: string): string {
  const extra = feedback?.trim() ? ` Creator's direction: ${feedback.trim()}.` : "";
  const look = recipe.transparent ? " Seamless left to right, side view, no perspective floor, on a fully transparent background." : " Seamless left to right.";
  return `${recipe.prompt} Setting: ${theme}.${look}${extra} ${style(direction)}`;
}

/**
 * Slice sheets and label their pieces; existing ids are kept per cell so rooms keep working after a
 * repaint. The same call names what drifts in the biome's air (`particles`).
 */
async function piecesFrom(
  ctx: ArtContext,
  sheets: Partial<Record<"structures" | "props", Buffer>>,
  previous: WorldPiece[],
  theme?: string,
  plan?: KitPlan,
): Promise<{ pieces: WorldPiece[]; particles?: ParticleKind }> {
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
      plan
        ? `The sheets were asked to hold, in reading order (a cell may hold something else; name what you see): ${which.map((s) => `${s}: ${plan[s].map((i) => `${i.name} (${i.role})`).join(", ")}`).join("; ")}.`
        : "",
      "For every non-empty cell give: a short name; kind (structure = a big standing shape: building, landmark, mass or growth, decor = small thing on the ground, light = gives off light, hanging = hangs down from the ceiling, span = ONLY a bare horizontal beam, plank, lintel or log with nothing under it, meant to rest across two supports; anything with its own legs, posts or base is a structure); size = its natural on-screen height in px (characters are 40px tall, the room is 720px tall: big structures ~300-600, hand-sized lights ~40-60, small ground details ~20-60); glow = '#rrggbb' light color for anything that glows.",
      theme ? `The biome: ${theme}. Also say what drifts in its air (particles): dust, embers, spores, snow, ash or none.` : "",
      `Reply with JSON only: {"pieces": [{"sheet": "structures"|"props", "cell": 0-8, "name", "kind", "size", "glow"?}]${theme ? ', "particles"' : ""}}`,
    ]
      .filter(Boolean)
      .join("\n"),
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
  // Pieces from the sheets are s<cell>_ / p<cell>_; others (painted for props) are kept through repaints.
  const sheetOf = (id: string) => (/^s\d_/.test(id) ? "structures" : /^p\d_/.test(id) ? "props" : null);
  const out: WorldPiece[] = previous.filter((p) => {
    const sheet = sheetOf(p.id);
    return !sheet || !which.includes(sheet);
  });
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
  return { pieces: out, ...(labels.particles ? { particles: labels.particles } : {}) };
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

  // The planes don't depend on the plan: they paint while it is written.
  const planes = paintPlanes(ctx, theme, project.art.direction, quality, input.feedback);
  planes.catch(() => {}); // awaited below; a plan failure mustn't leave it unhandled
  const plan = await planKit(ctx, theme, placePage(project, name));
  const prompts = worldPrompts(theme, project.art.direction, input.feedback, plan);
  const [backgrounds, [structures, props, ground]] = await Promise.all([
    planes,
    Promise.all((["structures", "props", "ground"] as const).map((part) => paint(ctx, part, prompts[part], quality))),
  ]);
  const { pieces, particles } = await piecesFrom(ctx, { structures: structures!, props: props! }, biome?.kit?.pieces ?? [], theme, plan);
  const kit: BiomeKit = {
    backdrop: backgrounds.find((p) => p.opaque)!.file,
    backgrounds,
    atmosphere: { particles: particles ?? biome?.kit?.atmosphere?.particles ?? "dust" },
    ground: await ctx.files.put(await ctx.renderer.tileableX(ground!, 0.12), "png"),
    pieces,
    quality,
  };
  ctx.log({ text: `kit ready: ${backgrounds.length} background planes, ${pieces.length} pieces, ${kit.atmosphere!.particles} in the air` });
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
  let kit: BiomeKit = biome.kit;
  // Background planes (a layered kit's sky too): repainted together, which also upgrades an old single-backdrop kit.
  if (input.part === "backgrounds" || (input.part === "backdrop" && kit.backgrounds?.length)) {
    const backgrounds = await paintPlanes(ctx, biome.brief, project.art.direction, kit.quality, input.feedback);
    kit = { ...kit, backdrop: backgrounds.find((p) => p.opaque)!.file, backgrounds, atmosphere: kit.atmosphere ?? { particles: "dust" } };
    return { operations: [{ name: "setBiomeKit", input: { assetId: biome.id, kit } }], summary: `repainted ${biome.name}'s background planes` };
  }
  const part = input.part as Exclude<KitPart, "backgrounds">;
  // New piece sheets are planned again, so a repaint follows the place (and the direction) as they are now.
  const plan = part === "structures" || part === "props" ? await planKit(ctx, biome.brief, placePage(project, biome.name)) : undefined;
  const prompt = worldPrompts(biome.brief, project.art.direction, input.feedback, plan)[part];
  const image = await paint(ctx, part, prompt, kit.quality);
  if (part === "backdrop") kit = { ...kit, backdrop: await ctx.files.put(await ctx.renderer.tileableX(image), "png") };
  else if (part === "ground") kit = { ...kit, ground: await ctx.files.put(await ctx.renderer.tileableX(image, 0.12), "png") };
  else kit = { ...kit, pieces: (await piecesFrom(ctx, { [part]: image }, kit.pieces, undefined, plan)).pieces };
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

/**
 * The world room a compose works around, and what happens to its dressing: a new
 * room dresses `dress`; a recompose makes the dressing of `refresh` current again.
 * A biome room that dresses several world rooms isn't reshaped for one of them:
 * that one gets a room of its own.
 */
function composeTarget(ctx: ArtContext, project: ProjectSpec, biome: BiomeAsset, input: WorldComposeInput) {
  const { rooms, playtest } = project.world;
  const fallback = rooms.find((r) => r.id === playtest?.room) ?? rooms[0];
  const none = { existing: undefined, dress: undefined, refresh: undefined };
  if (input.roomId) {
    const existing = biome.rooms.find((r) => r.id === input.roomId);
    if (!existing) throw new StageError(`${biome.name} has no room "${input.roomId}"`);
    const dressed = rooms.filter((r) => r.dressing?.biome === biome.id && r.dressing.room === existing.id);
    const world: WorldRoom | undefined = dressed.find(dressingOutOfDate) ?? dressed[0] ?? fallback;
    if (dressed.length > 1 && world && dressingOutOfDate(world)) {
      ctx.log({ text: `${existing.name} also dresses ${dressed.filter((r) => r !== world).map((r) => r.name).join(", ")}; composing a room of its own for ${world.name}` });
      return { ...none, world, dress: world.id };
    }
    return { ...none, world, existing, refresh: world && dressed.includes(world) ? world.id : undefined };
  }
  if (input.dressRoom) {
    const world = rooms.find((r) => r.id === input.dressRoom);
    if (!world) throw new StageError(`no world room "${input.dressRoom}" to dress`);
    return { ...none, world, dress: world.id };
  }
  return { ...none, world: fallback };
}

export async function worldComposeStage(ctx: ArtContext, input: WorldComposeInput): Promise<StageResult & { roomId: string }> {
  const project = ctx.project();
  const biome = findBiome(project, input.biomeId);
  if (!biome.kit) throw new StageError(`paint ${biome.name}'s kit first`);
  const kit = biome.kit;
  // Composed around a world room's tiles and doors: the one it dresses (recomposing), the one to dress, else the playtest room.
  const { world: target, existing, dress, refresh } = composeTarget(ctx, project, biome, input);
  const grid = target?.grid ?? borderedGrid(50, 23);
  // A suggested layout replaces the tiles, so the doors' places in it are unknown.
  const doors: DoorOpening[] = input.newLayout ? [] : (target?.doors ?? []);
  const { width, height } = gridSize(grid);
  const arenaPlatforms = gridPlatforms(grid, project.world.ledgeThickness);
  const backdrop = await ctx.files.get(kit.backdrop);
  const view = project.world.camera.rows * TILE;
  const schema = input.newLayout ? RoomComposition.extend({ platforms: z.array(PlatformRect).min(1).max(12) }) : RoomComposition;
  const composed = (await ask(
    ctx,
    schema,
    {
      system:
        "You are a level art director for a 2D side-scrolling platformer. You compose beautiful, deep, atmospheric rooms from a kit of sprites by writing scene data. You value negative space, clear silhouettes and a readable play area.",
      content: [
        { type: "image", image: backdrop },
        {
          type: "text",
          text: composePrompt(biome.brief, width, height, kit.pieces, input.newLayout ? null : arenaPlatforms, input.feedback, doors, view, roomContext(project, biome, target, existing?.id)),
        },
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
  // Rest every piece on something, keep doors and passages clear, then look at the room and fix what's wrong.
  const room: SnapRoom = {
    width: Math.max(960, width),
    height: Math.max(360, height),
    // Nothing rests on breakable tiles (a ground pound removes them): gridPlatforms leaves them out.
    platforms: (platforms ?? arenaPlatforms).filter((r) => r.width >= 8 && r.height >= 8).map(({ x, y, width, height }) => ({ x, y, width, height })),
  };
  // Restraint first (sizes and counts per layer), then rest what is left on surfaces.
  const limits: LimitRoom = { width: room.width, height: room.height, view };
  const snapped = snapPlacements(keepWithinLimits(ctx, withPlacementIds(known), kit, limits), kit.pieces, room);
  if (snapped.moved > 0) ctx.log({ text: `snapped ${snapped.moved} piece(s) onto surfaces` });
  const clear = keepPathsClear(ctx, snapped.placements, kit, room, doors);
  const reviewed = await reviewRoom(ctx, { theme: biome.brief, kit, composition: { ...raw, placements: clear }, room, view, doors, feedback: input.feedback });
  // The review's edits are checked again.
  const composition = { ...reviewed.composition, placements: keepPathsClear(ctx, reviewed.composition.placements, kit, room, doors) };
  const verdict = reviewed.score === null ? "" : ` (reviewed ${reviewed.score}/10${reviewed.fixes ? `, ${reviewed.fixes} fix${reviewed.fixes === 1 ? "" : "es"}` : ""})`;
  if (existing) {
    return {
      operations: [
        { name: "setRoomComposition", input: { assetId: biome.id, roomId: existing.id, composition } },
        // Composed around the world room's tiles as they are now: its dressing is current again.
        ...(refresh ? [{ name: "setDressing", input: { worldRoomId: refresh, biomeId: biome.id, roomId: existing.id } }] : []),
      ],
      roomId: existing.id,
      summary: `recomposed ${existing.name}${target ? ` around ${target.name}` : ""}${verdict}`,
    };
  }
  const name = input.name?.trim() || (dress && target ? target.name : `${biome.name} ${biome.rooms.length + 1}`);
  const roomId = newRoomId(biome, name);
  return {
    operations: [
      {
        name: "addRoom",
        input: {
          assetId: biome.id,
          dressRoom: dress ?? null,
          room: { id: roomId, name, composition, layout: platforms ?? null, cost: 0, at: new Date().toISOString() },
        },
      },
    ],
    roomId,
    summary: `composed ${name}${platforms ? " with a suggested layout" : ""}${verdict}`,
  };
}

/** limitComposition (core compositionLimits), logged. */
function keepWithinLimits<P extends Composition["placements"][number]>(ctx: ArtContext, placements: P[], kit: BiomeKit, room: LimitRoom): P[] {
  const limited = limitComposition(placements, kit.pieces, room);
  const said = [
    limited.scaled.length ? `scaled down ${limited.scaled.join(", ")} (too big for their layer)` : "",
    limited.dropped.length ? `dropped ${limited.dropped.join(", ")} (over their layer's budget)` : "",
  ].filter(Boolean);
  if (said.length) ctx.log({ text: `restraint: ${said.join("; ")}` });
  return limited.placements;
}

/** clearPassages, logged. */
function keepPathsClear<P extends Composition["placements"][number]>(ctx: ArtContext, placements: P[], kit: BiomeKit, room: SnapRoom, doors: DoorOpening[]): P[] {
  const cleared = clearPassages(placements, kit.pieces, room, doors);
  const said = [
    cleared.moved.length ? `moved ${cleared.moved.join(", ")} off doorways` : "",
    cleared.scaled.length ? `shortened ${cleared.scaled.join(", ")} (hanging into a passage)` : "",
    cleared.dropped.length ? `dropped ${cleared.dropped.join(", ")} (in a doorway or passage)` : "",
  ].filter(Boolean);
  if (said.length) ctx.log({ text: `paths: ${said.join("; ")}` });
  return cleared.placements;
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
  /** Height (px) of the play camera's view (the composition limits are relative to it). */
  view: number;
  doors: DoorOpening[];
  feedback?: string;
}

/** The doors' openings, for prompts: where to keep clear. */
function doorsText(doors: DoorOpening[], room: Pick<SnapRoom, "width" | "height">): string {
  if (doors.length === 0) return "";
  const where = doors.map((d) => {
    const a = d.offset * TILE;
    const b = (d.offset + d.size) * TILE;
    return d.side === "left" || d.side === "right" ? `${d.side} wall (x ${d.side === "left" ? 0 : room.width}), y ${a}-${b}` : `${d.side} edge, x ${a}-${b}`;
  });
  return `Door openings (the player passes through them; keep them and ${DOOR_APPROACH}px in front of them free of play, front and big back pieces; nothing may hang into them): ${where.join("; ")}.`;
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
  const refs = kitFiles({ ...kit, pieces: kit.pieces.filter((p) => used.has(p.id)) });
  const images = Object.fromEntries(await Promise.all([...new Set(refs)].map(async (ref) => [ref, (await ctx.files.get(ref)).toString("base64")] as const)));
  const scene = { name: "review", width: room.width, height: room.height, backdrop: kit.backdrop, ...(kit.backgrounds ? { backgrounds: kit.backgrounds } : {}), ...(kit.atmosphere ? { atmosphere: kit.atmosphere } : {}), ground: kit.ground, pieces: kit.pieces, platforms: room.platforms, ...composition };
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
    const limited = keepWithinLimits(ctx, applied.composition.placements, input.kit, { width: input.room.width, height: input.room.height, view: input.view });
    const snapped = snapPlacements(limited, input.kit.pieces, input.room);
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
    doorsText(input.doors, room),
    "Layers back to front: mid (distant, fogged, scrolls slower), back (just behind play, scrolls a bit slower), play (the walkable layer), front (near-black silhouettes that scroll faster). Because of parallax, mid/back/front pieces line up with the platforms only when the camera is near them.",
    "Each placement's y is its bottom (its top for hanging pieces). Standing front-layer silhouettes are set below the room's bottom edge on purpose (they rise into view, cut off by it): that is not a mistake.",
    `Placements:\n${rows.join("\n")}`,
    unsupported.length ? `These play pieces stand over nothing (no platform under their x): ${unsupported.join(", ")}.` : "",
    "Look for, most important first:",
    "1. pieces floating in the air, or clipping awkwardly into platforms (standing pieces rest on a surface; hanging ones hang from the top or a ledge's underside);",
    "2. pieces cluttering the walkable path or hiding platform edges; front silhouettes covering the middle of a view;",
    "3. scale mistakes (a small prop as big as a big structure, a big structure tiny beside a small prop) and pieces cut off in ugly ways;",
    "4. crowding: too many or too big pieces, mid-layer structures that read as walls instead of distant shapes, background planes hidden behind pieces, even rows. Empty space is good: prefer removing and shrinking to adding.",
    compositionLimitsText({ width: room.width, height: room.height, view: input.view }),
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
  doors: DoorOpening[] = [],
  /** Height (px) of the play camera's view. */
  view = 14 * TILE,
  /** What this room is (roomContext): its identity and how the look's other dressings already look. */
  context = "",
): string {
  const viewWidth = Math.round((view * 16) / 9);
  const list = pieces.map((p) => `- ${p.id}: ${p.name} (${p.kind}, ${p.size}px tall, ${(p.width / p.height).toFixed(2)} w/h${p.glow ? `, glows ${p.glow}` : ""})`);
  const layout = platforms
    ? `The walkable layout is FIXED (do not output platforms): ${platforms.map((r) => `[x ${r.x}, y ${r.y}, w ${r.width}, h ${r.height}]`).join(", ")}. Platforms outside 0..${width} are walls and can be ignored. Dress around it: props sit ON these surfaces.`
    : `Also design the walkable layout ("platforms"): a floor spanning the whole width (y around ${height - 110}, height 110+) plus 3-5 floating ledges or steps a 40px character could jump between (jumps ~150px high), inside the room and away from the ceiling.`;
  return [
    `The image is this biome's painted backdrop. Biome: ${theme}.`,
    `Compose one room ${width}px wide and ${height}px tall (x right, y DOWN, 0,0 = top-left). The play camera shows about ${viewWidth}x${view}px of it at a time and follows the player both ways${width > viewWidth * 1.2 || height > view * 1.2 ? " (this room is bigger than one view: dress all of it, not just one screen)" : ""}.`,
    layout,
    doorsText(doors, { width, height }),
    "Layers, back to front (the runtime draws them with parallax, fog between them, depth tint and lighting):",
    "  far = the backdrop (already set; don't place pieces there); mid = big distant structures, tinted into the fog; back = decor and structures just behind the play layer; play = the walkable layer; front = near-black silhouettes in front of everything.",
    "For a piece's x, give the room x it is seen at. y is its bottom (on a floor or platform top), or its top for 'hanging' pieces (usually 0).",
    "'span' pieces (beams, lintels, logs) rest across two supports: put one between two structures of the same layer (x midway between them, y at their tops, scaled so its ends reach them) or across a gap between two ledges. Pieces are snapped onto their supports afterwards. One span is plenty (between two structures in the mid or back layer, or over a gap in the play layer).",
    `Kit pieces:\n${list.join("\n")}`,
    "Be minimal: this matters most. The painted background planes behind the room already give it depth and must stay visible; a few well-placed pieces per layer read better than many, and generous empty space is the goal.",
    "  mid: a few small distant shapes on the floor line (far away: they read as distant silhouettes, never as walls), wide gaps between them, some flipped;",
    "  back: a few modest pieces, at the room's ends or between ledges (never behind a ledge), plus a little decor on the floor;",
    "  play: only what sits ON surfaces (floor or ledge tops) or frames the path: a light or two along it, a few small details at the bases of things, maybe one hanging piece;",
    "  front: one or two framing silhouettes at the room's edges (hanging from y 0, or standing at the bottom edge, cut off by it), never in the middle of a view.",
    compositionLimitsText({ width, height, view }),
    "Leave the band between y 120 and the floor open in the mid and back layers so the background planes show through; vary spacing (clusters and gaps, not an even row).",
    "Atmosphere: palette.ambient a mid-dark tint (channels 0x70-0xa0; lights add on top); fog density behind mid/back/play 0.2-0.6 (deeper = foggier); 2-4 soft light shafts from above (rays); dust motes (amount 60-160). Colors must harmonize with the backdrop. Optional extra point lights (pieces of kind 'light' get their own).",
    context,
    feedback?.trim() ? `Creator's direction for this room: ${feedback.trim()}` : "",
    `Reply with JSON only: {"palette": {"ambient", "fog", "light", "shadow"},${platforms ? "" : ' "platforms": [{"x","y","width","height"}],'} "placements": [{"piece","layer","x","y","scale","flip"}], "lights": [{"x","y","color","energy","radius"}], "fog": {"mid","back","play"}, "rays": [{"x","width","angle","alpha"}], "dust": {"color","amount"}}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * What makes this room itself, for the composer: the game room it dresses (name, region, the
 * plan's notes, what it holds) and how the look's other dressings already look, so rooms of one
 * region share a kit without all looking the same.
 */
export function roomContext(project: ProjectSpec, biome: BiomeAsset, target: WorldRoom | undefined, ownDressing?: string): string {
  const lines: string[] = [];
  if (target) {
    const plan = project.architect.rooms.find((r) => r.id === target.id);
    const region = project.progression.regions.find((r) => r.id === (target.regionId ?? plan?.regionId));
    const holds = (plan?.contents ?? []).flatMap((c) => {
      if (c.kind === "enemy") return [c.lockRoom ? "a fight that locks the room" : "enemies"];
      if (c.kind === "pickup") return ["something to pick up"];
      if (c.kind === "save") return ["a save point"];
      if (c.kind === "start") return ["the start of the game"];
      return c.kind === "ending" ? ["the ending"] : [];
    });
    const about = [
      `This dressing is for the game room "${target.name}"${region ? ` in ${region.name}` : ""}.`,
      plan?.notes.trim() ? `The room's notes: ${plan.notes.trim()}` : "",
      holds.length ? `It holds ${[...new Set(holds)].join(", ")}: let the dressing support that moment (a fight wants open space and drama, a rest spot calm and warmth, a start or ending a memorable picture).` : "",
    ];
    lines.push(about.filter(Boolean).join(" "));
  }
  const siblings = biome.rooms.filter((r) => r.id !== ownDressing && r.composition.placements.length > 0);
  if (siblings.length > 0) {
    const names = new Map(biome.kit?.pieces.map((p) => [p.id, p.name]) ?? []);
    const uses = new Map<string, number>();
    const focal = new Map<string, number>();
    for (const room of siblings) {
      for (const p of room.composition.placements) uses.set(p.piece, (uses.get(p.piece) ?? 0) + 1);
      // The room's focal piece: its biggest placement in the mid or back layer.
      const big = room.composition.placements.filter((p) => p.layer === "mid" || p.layer === "back").sort((a, b) => (b.scale ?? 1) - (a.scale ?? 1))[0];
      if (big) focal.set(big.piece, (focal.get(big.piece) ?? 0) + 1);
    }
    const name = (id: string) => names.get(id) ?? id;
    const common = [...uses].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => `${name(id)} (${n}x)`);
    const lightings = siblings.slice(-4).map((r) => `${r.composition.palette.ambient} ambient, ${r.composition.rays.length} light shaft(s)`);
    lines.push(
      [
        `${siblings.length} other room(s) of this look already exist${siblings.length <= 4 ? `: ${siblings.map((r) => r.name).join(", ")}` : ""}.`,
        `Most used there: ${common.join(", ")}.`,
        focal.size ? `Their focal pieces: ${[...focal.keys()].map(name).join(", ")}.` : "",
        `Their lighting: ${lightings.join("; ")}.`,
        "Make this room recognisably different at a glance while staying in the same place: a different focal piece and a different subset of the kit (reuse the most-used pieces sparingly), a different rhythm of clusters and gaps, and its own light (warmer or cooler within the palette, more or less fog, different shafts).",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return lines.join("\n");
}
