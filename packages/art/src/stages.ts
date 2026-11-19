import { detailLook } from "./dress.ts";
import { attackTiming, checkWeaponClip, fitWeaponClip, gripBones, heldLength, weaponClipBrief, withHandGrip } from "./weapons.ts";
import { z } from "zod";
import {
  attackClipName,
  CLIP_SLOTS,
  wantedWeaponClips,
  type Grip,
  type Weapon,
  type WeaponAttack,
  wantedClipSlots,
  Clip,
  Id,
  Rig,
  rigFiles,
  uniqueId,
  type CharacterAsset,
  type Character,
  type ClipSlot,
  type FileRef,
  type OperationCall,
  type ProjectSpec,
  type RenderRigRequest,
  type RigMode,
} from "@anomaly/core";
import { CutoutPlan, cutCharacter, cutoutRig, isolateFigure, jointPivots, labelParts, partsView, placeCutout, planFromRig, type Cutout } from "./cutout.ts";
import { assemblePuppet, drawnParts, partAnchors, piecesView, PieceMatch, PieceNudge, PuppetPlan, sheetPieces } from "./puppet.ts";
import { fitClips, limitsText, motionLimits } from "./motionLimits.ts";
import { tracedRig } from "./traced.ts";
import { fitBounds, fitFrame, frameForCanvas, pngSize, toCanvasSpace, toRigSpace, type Frame } from "./frame.ts";
import { parseReply } from "./json.ts";
import { decodePng, encodePng, flatten, matchScore, matchValue, type MatchScore, type Pixels } from "./match.ts";
import type { ImageModel, ModelUsage, VisionContent, VisionModel, VisionRequest } from "./models.ts";
import {
  animCritiquePrompt,
  animPrompt,
  animSystemPrompt,
  conceptPrompt,
  cutoutAuthorPrompt,
  cutoutCritiquePrompt,
  cutoutSystemPrompt,
  FACING_PROMPT,
  flatRedrawPrompt,
  partsSheetPrompt,
  PICK_SYSTEM,
  pickPrompt,
  PUPPET_SYSTEM,
  puppetCritiquePrompt,
  puppetMatchPrompt,
  puppetPlanPrompt,
  rigAuthorPrompt,
  rigCritiquePrompt,
  rigSystemPrompt,
  isRigReadySheet,
  weaponAnimPrompt,
} from "./prompts.ts";

/**
 * The art pipeline's stages. Each stage reads the project, calls models,
 * renders and stores files, and returns core operations; the caller commits
 * them as one batch (one undo step). Stages never write the project.
 */

export interface FileStore {
  put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef>;
  get(ref: FileRef): Promise<Buffer>;
}

/** What the pipeline needs from a renderer (the server's BrowserRenderer). */
export interface ArtRenderer {
  renderRig(request: Omit<RenderRigRequest, "requestId">): Promise<{ png: Buffer; warnings: string[] }>;
  crop(image: Buffer, region: { x: number; y: number; width: number; height: number }, maxSize: number): Promise<Buffer>;
  /** World kits: make an image tile left-to-right (narrower by `blend`). */
  tileableX(image: Buffer, blend?: number): Promise<Buffer>;
  /** World kits: cut a sheet into cells trimmed to their visible pixels (empty cells dropped). */
  sliceGrid(image: Buffer, cols: number, rows: number, maxSize?: number): Promise<{ png: Buffer; width: number; height: number; cell: number }[]>;
  /** World rooms: render a scene from several camera x positions (frames stacked vertically), optionally with placement ids written on. */
  renderWorld(request: {
    scene: unknown;
    /** FileRef -> base64 image. */
    images: Record<string, string>;
    cameras: number[];
    width: number;
    height: number;
    labels?: boolean;
  }): Promise<{ png: Buffer; warnings: string[] }>;
  /** Stack images (stretched to width x height) over a background, optionally with a labelled pixel grid. PNG. */
  compose(request: {
    width: number;
    height: number;
    background?: string;
    layers: { image: Buffer; alpha?: number; flipX?: boolean }[];
    grid?: number;
  }): Promise<Buffer>;
}

export interface ArtActivity {
  text: string;
  cost?: number;
  /** An image to show with this step (concept sheet, render). */
  file?: FileRef;
}

export class BudgetExceeded extends Error {}

export interface ArtContext {
  /** The project as it is now (including stages committed earlier in this job). */
  project(): ProjectSpec;
  image: ImageModel;
  vision: VisionModel;
  renderer: ArtRenderer;
  files: FileStore;
  log(activity: ArtActivity): void;
  /** USD left in this job's budget. */
  remaining(): number;
  /** Record spend; throws BudgetExceeded when over budget. */
  spend(usage: ModelUsage): void;
  signal?: AbortSignal;
  /** Critique rounds for rigs (default 3). */
  rigRounds?: number;
  /** Critique rounds for animations (default 1). */
  animRounds?: number;
  /** Look-and-fix rounds for composed rooms (default 1; 0 skips the review). */
  roomRounds?: number;
  /** Rig mode when neither the request nor the art direction picks one (default vector; real backends pass theirs). */
  defaultRigMode?: RigMode;
}

export interface StageResult {
  operations: OperationCall[];
  summary: string;
}

const BACKGROUND = "#d8d6cf";
const FILMSTRIP_FRAMES = 6;
/** Rough cost of one more critique call, to stop loops before blowing the budget. */
const CRITIQUE_RESERVE = 0.02;

// --- helpers -------------------------------------------------------------------

function findCharacter(project: ProjectSpec, characterId: string): Character {
  const character = project.characters.find((c) => c.id === characterId);
  if (!character) throw new StageError(`no character "${characterId}" (known: ${project.characters.map((c) => c.id).join(", ")})`);
  return character;
}

function assetOf(project: ProjectSpec, character: Character): CharacterAsset | null {
  const asset = project.art.assets.find((a) => a.id === character.appearance);
  return asset && asset.kind === "character" ? asset : null;
}

function requireAsset(project: ProjectSpec, character: Character): CharacterAsset {
  const asset = assetOf(project, character);
  if (!asset) throw new StageError(`"${character.id}" has no art yet; generate concepts first`);
  return asset;
}

/** A problem the creator can fix (shown as-is). */
export class StageError extends Error {}

function checkAbort(ctx: ArtContext): void {
  if (ctx.signal?.aborted) throw new StageError("cancelled");
}

/**
 * One vision call that must return JSON matching `schema`. A malformed reply
 * gets one repair round with the problems listed.
 */
export async function askJson<T extends z.ZodType>(
  ctx: ArtContext,
  schema: T,
  request: VisionRequest,
  label: string,
): Promise<z.infer<T>> {
  checkAbort(ctx);
  let reply = await ctx.vision.complete({ ...request, json: true, signal: ctx.signal });
  ctx.spend(reply.usage);
  ctx.log({ text: `${label} (${ctx.vision.id})`, cost: reply.usage.cost });
  let parsed = parseReply(schema, reply.text);
  if (parsed.ok) return parsed.value;

  checkAbort(ctx);
  ctx.log({ text: `${label}: reply had problems, asking for a fix (${parsed.problems.slice(0, 160)})` });
  reply = await ctx.vision.complete({
    ...request,
    json: true,
    signal: ctx.signal,
    history: [...(request.history ?? []), { role: "user", content: request.content }, { role: "assistant", content: reply.text }],
    content: [{ type: "text", text: `That reply was invalid: ${parsed.problems}\nReply again with the complete corrected JSON only.` }],
  });
  ctx.spend(reply.usage);
  ctx.log({ text: `${label}: fix (${ctx.vision.id})`, cost: reply.usage.cost });
  parsed = parseReply(schema, reply.text);
  if (parsed.ok) return parsed.value;
  throw new StageError(`${label}: the model's reply was still invalid (${parsed.problems.slice(0, 300)})`);
}

const image = (data: Buffer): VisionContent => ({ type: "image", image: data });
const text = (t: string): VisionContent => ({ type: "text", text: t });

async function renderRest(ctx: ArtContext, rig: Rig, size = 384): Promise<{ png: Buffer; warnings: string[] }> {
  checkAbort(ctx);
  const images = await rigImages(ctx, rig);
  return ctx.renderer.renderRig({
    ...(images ? { images } : {}),
    rig,
    direction: ctx.project().art.direction,
    clips: {},
    frames: [{ clip: null, time: 0 }],
    cellWidth: size,
    cellHeight: size,
    columns: 1,
    background: BACKGROUND,
  });
}

// --- stage: concepts --------------------------------------------------------

export interface ConceptsInput {
  characterId: string;
  /** New/updated brief for the character's look. */
  brief?: string;
  /** What to change this round. */
  feedback?: string;
  /** Use the chosen design as a reference image (variations on it). */
  refine?: boolean;
  /** Designs ready to rig (neutral pose, limbs apart, distinct colours, whole figure in its cell); cut-off cells are never recommended. Default: on for vector rigs. */
  rigReady?: boolean;
  /** The rig the design is for (rigModeFor). */
  rigMode?: RigMode;
}

/**
 * The rig mode a character's stages work towards: the request's, else the art direction's, else
 * the backend's default. Vector is the studio's full pipeline (rig-ready designs, a flat redraw,
 * a vector rig with elbows and knees checked over render-and-compare rounds, detail shapes, then
 * clips that bend at the joints); cutout and traced build from the design's own pieces.
 */
export function rigModeFor(ctx: ArtContext, project: ProjectSpec, requested?: RigMode): RigMode {
  return requested ?? project.art.direction.rigMode ?? ctx.defaultRigMode ?? "vector";
}

/** Rig-ready concept sheets with no whole design are drawn again this many times. */
const RIG_READY_RETRIES = 1;

const WIKI_BRIEF_LIMIT = 600;
const LOOKS = /appear|look|visual|colou?r|cloth|outfit|wear|armou?r|build|silhouette|shape|size/i;

/** A concept brief from the character's wiki page: title, summary, its looks fields, then the body (links as plain text), trimmed. */
export function wikiBrief(project: ProjectSpec, characterId: string): string | undefined {
  const page = project.wiki.pages.find((p) => p.characterId === characterId);
  if (!page) return undefined;
  const looks = Object.entries(page.fields).filter(([k]) => LOOKS.test(k)).map(([k, v]) => `${k}: ${v}`);
  const body = page.body.replace(/\[\[[a-z0-9_]+\|([^\]\n]+)\]\]|\[\[([a-z0-9_]+)\]\]/g, (_, label, id) => label ?? id.replace(/_/g, " ")).replace(/\s+/g, " ");
  const brief = [page.summary ? `${page.title}: ${page.summary}` : page.title, ...looks, body]
    .map((s) => s.trim().replace(/[.\s]+$/, ""))
    .filter(Boolean)
    .join(". ");
  return brief.length > WIKI_BRIEF_LIMIT ? `${brief.slice(0, WIKI_BRIEF_LIMIT - 1).replace(/\s+\S*$/, "")}…` : brief;
}

export async function generateConcepts(ctx: ArtContext, input: ConceptsInput): Promise<StageResult & { assetId: string }> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const operations: OperationCall[] = [];
  let asset = assetOf(project, character);
  let assetId: string;
  // An explicit brief wins, then the asset's own (unless it's only the name), then the character's wiki page.
  const own = asset?.brief && asset.brief !== character.name ? asset.brief : undefined;
  const brief = input.brief?.trim() || own || wikiBrief(project, character.id) || character.name;
  const rigReady = input.rigReady ?? rigModeFor(ctx, project, input.rigMode) === "vector";

  if (!asset) {
    assetId = uniqueId(`${character.id}_look`, project.art.assets.map((a) => a.id));
    operations.push({
      name: "createAsset",
      input: { asset: { id: assetId, name: character.name, kind: "character", brief }, assignTo: character.id },
    });
  } else {
    assetId = asset.id;
    if (input.brief?.trim() && input.brief.trim() !== asset.brief) {
      operations.push({ name: "updateAsset", input: { assetId, changes: { brief } } });
    }
  }

  const reference = input.refine && asset?.chosen ? await ctx.files.get(asset.chosen.file) : null;
  const prompt = conceptPrompt({
    character,
    brief,
    direction: project.art.direction,
    feedback: input.feedback,
    refining: reference !== null,
    rigReady,
  });
  // Rig-ready: cells whose figure runs off the cell's edge are never recommended; a sheet with none whole is drawn again (once).
  let generated: Awaited<ReturnType<ImageModel["generate"]>>;
  let file: FileRef;
  let cells: { cell: number; touchesEdge: boolean; margin: number }[] | null = null;
  for (let attempt = 0; ; attempt++) {
    checkAbort(ctx);
    const asked = attempt === 0 ? prompt : `${prompt}\nThe last sheet drew the figures too big (they ran off their quadrants): draw them clearly smaller this time.`;
    generated = await ctx.image.generate({ prompt: asked, references: reference ? [reference] : undefined, signal: ctx.signal });
    ctx.spend(generated.usage);
    // Rig-ready: a sheet that came back with a transparent background gets a flat one (the cutout needs it).
    if (rigReady) generated = { ...generated, image: await opaque(ctx, generated.image), ext: "png" };
    file = await ctx.files.put(generated.image, generated.ext);
    ctx.log({ text: `concept sheet (${generated.model})`, cost: generated.usage.cost, file });
    if (!rigReady) break;
    cells = [];
    for (let cell = 0; cell < 4; cell++) {
      const figure = isolateFigure(decodePng(await ctx.renderer.crop(generated.image, sheetCell(cell), 512)));
      cells.push({ cell, touchesEdge: figure?.touchesEdge ?? true, margin: figure?.margin ?? 0 });
    }
    const cutOff = cells.filter((c) => c.touchesEdge).map((c) => c.cell);
    if (cutOff.length > 0) ctx.log({ text: `design${cutOff.length > 1 ? "s" : ""} ${cutOff.map((c) => c + 1).join(", ")} run${cutOff.length > 1 ? "" : "s"} off the edge` });
    if (cutOff.length < 4 || attempt >= RIG_READY_RETRIES) break;
    ctx.log({ text: "no design fits its cell: drawing the sheet again" });
  }

  // A cheap second opinion on which design to take forward.
  let recommended: { cell: number; reason: string } | undefined;
  try {
    const cutOff = cells?.filter((c) => c.touchesEdge).map((c) => c.cell);
    recommended = await askJson(
      ctx,
      z.object({ cell: z.number().int().min(0).max(3), reason: z.string().max(500) }),
      { system: PICK_SYSTEM, content: [image(generated.image), text(pickPrompt(brief, project.art.direction, input.feedback, cutOff ? { cutOff } : undefined))], maxTokens: 3000 },
      "picking a design",
    );
    const fits = cells?.filter((c) => !c.touchesEdge) ?? [];
    if (cells?.[recommended.cell]?.touchesEdge && fits.length > 0) {
      const roomiest = fits.sort((a, b) => b.margin - a.margin)[0]!.cell;
      recommended = { cell: roomiest, reason: `design ${recommended.cell + 1} runs off its edge; the roomiest whole design instead` };
    }
    ctx.log({ text: `recommends design ${recommended.cell + 1}: ${recommended.reason}` });
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    ctx.log({ text: `no recommendation (${error instanceof Error ? error.message : String(error)})` });
  }

  operations.push({
    name: "addConcept",
    input: {
      assetId,
      concept: {
        file,
        prompt,
        model: generated.model,
        cost: generated.usage.cost,
        at: new Date().toISOString(),
        ...(input.feedback?.trim() ? { feedback: input.feedback.trim() } : {}),
        ...(recommended ? { recommended } : {}),
      },
    },
  });
  return { operations, assetId, summary: `new concept sheet for ${character.name}` };
}

// --- stage: choose ------------------------------------------------------------

export interface ChooseInput {
  characterId: string;
  /** Sheet index; default the latest. */
  sheet?: number;
  /** Cell 0-3; default the AI's recommendation (else 0). */
  cell?: number;
  /** Keep only the main figure (neighbouring designs, sparks and stray bits painted out) and warn when it is cut off. Default: when the sheet was drawn rig-ready. */
  rigReady?: boolean;
  /** The rig the design is for (accepted for symmetry with the other stages; the sheet decides rigReady). */
  rigMode?: RigMode;
}

/** 2x2 sheet cell as a fraction of the image, with a small inset to drop gutters. */
export function sheetCell(cell: number): { x: number; y: number; width: number; height: number } {
  const inset = 0.01;
  return { x: (cell % 2) * 0.5 + inset, y: Math.floor(cell / 2) * 0.5 + inset, width: 0.5 - 2 * inset, height: 0.5 - 2 * inset };
}

export async function chooseConcept(ctx: ArtContext, input: ChooseInput): Promise<StageResult> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const asset = requireAsset(project, character);
  const sheetIndex = input.sheet ?? asset.concepts.length - 1;
  const sheet = asset.concepts[sheetIndex];
  if (!sheet) throw new StageError(`"${asset.id}" has no concept sheet ${sheetIndex}`);
  const cell = input.cell ?? sheet.recommended?.cell ?? 0;
  let cropped = await ctx.renderer.crop(await ctx.files.get(sheet.file), sheetCell(cell), 512);

  // Rigs face right. Image models often ignore "facing right", so check and mirror.
  try {
    const { facing } = await askJson(
      ctx,
      z.object({ facing: z.enum(["left", "right"]) }),
      { system: PICK_SYSTEM, content: [image(cropped), text(FACING_PROMPT)], maxTokens: 2000 },
      "checking which way it faces",
    );
    if (facing === "left") {
      const size = pngSize(cropped);
      cropped = await ctx.renderer.compose({ ...size, layers: [{ image: cropped, flipX: true }] });
      ctx.log({ text: "mirrored the design to face right" });
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    ctx.log({ text: `could not check facing (${error instanceof Error ? error.message : String(error)})` });
  }
  // A design from a rig-ready sheet keeps only its main figure (the sheet says how it was drawn, whatever the picker knows).
  if (input.rigReady ?? isRigReadySheet(sheet.prompt)) cropped = mainFigureOnly(ctx, cropped);

  const file = await ctx.files.put(cropped, "png");
  ctx.log({ text: `chose design ${cell + 1} of sheet ${sheetIndex + 1}`, file });
  return {
    operations: [{ name: "chooseConcept", input: { assetId: asset.id, sheet: sheetIndex, cell, file } }],
    summary: `chose a design for ${character.name}`,
  };
}

/** The design with only its main figure (neighbours, sparks and specks painted out); logs a figure cut off by the edge. */
/** Below this alpha a generated pixel is background; above it, it is the figure's own colour, fully opaque. */
const OPAQUE_ALPHA = 40;
const FLAT_BACKGROUND: [number, number, number] = [226, 224, 219];

/**
 * An image the image model returned with a transparent background (it sometimes does when told
 * "nothing else in the picture"), made opaque on a flat light grey: pixels over OPAQUE_ALPHA keep
 * their colour at full opacity (no speckle where the model left partial alpha inside the figure),
 * the rest become background. PNG; the image as given when it has no transparency.
 */
async function opaque(ctx: ArtContext, image: Buffer): Promise<Buffer> {
  const png = image[0] === 0x89 && image[1] === 0x50 ? image : await ctx.renderer.crop(image, { x: 0, y: 0, width: 1, height: 1 }, 4096);
  const pixels = decodePng(png);
  const { data } = pixels;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) transparent = true;
  if (!transparent) return png;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < OPAQUE_ALPHA) data.set(FLAT_BACKGROUND, i);
    data[i + 3] = 255;
  }
  return encodePng(pixels);
}

function mainFigureOnly(ctx: ArtContext, png: Buffer): Buffer {
  const figure = isolateFigure(decodePng(png));
  if (!figure) return png;
  if (figure.touchesEdge) ctx.log({ text: "the design runs off its edge (part of it may be cut off)" });
  if (figure.dropped === 0) return png;
  ctx.log({ text: `kept only the main figure (${figure.dropped} stray bit${figure.dropped > 1 ? "s" : ""} removed)` });
  return encodePng(figure.image);
}

// --- stage: flat redraw -------------------------------------------------------------

export interface RedrawInput {
  characterId: string;
  /** Image quality for the edit (models with a quality knob; default the model's): a higher one keeps closer to the design. */
  quality?: string;
}

/**
 * The chosen design redrawn as clean flat art by the image model (an edit of the chosen design:
 * same character and pose, solid colours, one clean outline, plain background), so a traced rig
 * gets clean shapes. Becomes the chosen design (same sheet and cell).
 */
export async function redrawFlat(ctx: ArtContext, input: RedrawInput): Promise<StageResult> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const asset = requireAsset(project, character);
  if (!asset.chosen) throw new StageError(`choose a concept design for "${character.name}" first`);
  const chosen = await ctx.files.get(asset.chosen.file);
  checkAbort(ctx);
  const generated = await ctx.image.generate({
    prompt: flatRedrawPrompt(asset.brief),
    references: [chosen],
    signal: ctx.signal,
    ...(input.quality ? { quality: input.quality } : {}),
  });
  ctx.spend(generated.usage);
  ctx.log({ text: `flat redraw (${generated.model})`, cost: generated.usage.cost });
  const size = pngSize(chosen);
  let png = await ctx.renderer.crop(await opaque(ctx, generated.image), { x: 0, y: 0, width: 1, height: 1 }, Math.max(size.width, size.height));
  try {
    const { facing } = await askJson(
      ctx,
      z.object({ facing: z.enum(["left", "right"]) }),
      { system: PICK_SYSTEM, content: [image(png), text(FACING_PROMPT)], maxTokens: 2000 },
      "checking which way it faces",
    );
    if (facing === "left") {
      png = await ctx.renderer.compose({ ...pngSize(png), layers: [{ image: png, flipX: true }] });
      ctx.log({ text: "mirrored the redraw to face right" });
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    ctx.log({ text: `could not check facing (${error instanceof Error ? error.message : String(error)})` });
  }
  png = mainFigureOnly(ctx, png);
  const file = await ctx.files.put(png, "png");
  ctx.log({ text: "the flat redraw is the design now", file });
  return {
    operations: [{ name: "chooseConcept", input: { assetId: asset.id, sheet: asset.chosen.sheet, cell: asset.chosen.cell, file, original: asset.chosen.original ?? asset.chosen.file } }],
    summary: `redrew ${character.name}'s design as flat art`,
  };
}

// --- stage: rig ------------------------------------------------------------------

export interface RigInput {
  characterId: string;
  /** Revise the existing rig with this direction instead of building from scratch. */
  feedback?: string;
  /** Vector shapes, cutout pieces of the design, or those pieces traced as vector shapes (default: the art direction's rigMode, else the backend's default). */
  rigMode?: RigMode;
  /** Split arms and legs at elbows and knees (two bones per limb). Default: on for vector rigs. */
  limbJoints?: boolean;
  /** Vector rigs: redraw the design as flat art first when it isn't one yet (default on). */
  redraw?: boolean;
  /** Vector rigs: the detail pass after the build, with the design as drawn as its reference (default on). */
  detail?: boolean;
  /** Traced rigs: the clean tracer (traced.ts `clean`), with the plan's feature points kept. */
  cleanTrace?: boolean;
  /** Traced rigs: the critic also compares the drawn rig with the design and points out lost features. */
  review?: boolean;
  /** Critique rounds for this build (default: the context's). */
  rounds?: number;
  /**
   * Build a puppet (puppet.ts): an image edit draws the character's pieces apart on a parts
   * sheet, each traced as flat shapes and put back on the skeleton planned on the design. A traced rig.
   */
  puppet?: boolean;
  /** Puppet: image quality of the parts sheet (default the model's). */
  sheetQuality?: string;
}

const RigReply = z.object({ rig: Rig, notes: z.string().optional() });
const Critique = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string()).default([]), rig: z.unknown() });
const CutoutCritique = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string()).default([]), plan: z.unknown().optional() });

const GRID = 64;
/** Match values closer than this are a tie (the critic's score decides). */
const MATCH_TIE = 0.02;

/** One rig attempt in the critique loop. */
interface Attempt {
  rig: Rig;
  frame: Frame;
  score: number;
  notes: string;
  match?: MatchScore;
  /** Cutout and traced rigs: the plan it was built from (pivots as built). */
  plan?: CutoutPlan;
}

/** The better attempt: the measured likeness first, the critic's score on a tie (or when nothing was measured). */
function better(best: Attempt | null, next: Attempt): Attempt {
  if (!best) return next;
  if (best.match && next.match && Math.abs(matchValue(next.match) - matchValue(best.match)) > MATCH_TIE) {
    return matchValue(next.match) > matchValue(best.match) ? next : best;
  }
  return next.score > best.score ? next : best;
}

/** The images a rig draws (a cutout's source, part textures) for the renderer (base64 by file ref). */
export async function rigImages(ctx: Pick<ArtContext, "files">, rig: Rig): Promise<Record<string, string> | undefined> {
  const refs = rigFiles(rig);
  if (refs.length === 0) return undefined;
  return Object.fromEntries(await Promise.all(refs.map(async (ref) => [ref, (await ctx.files.get(ref)).toString("base64")] as const)));
}

/**
 * Render a canvas-space rig in the concept's framing: alone (on the pipeline background) and
 * laid over the concept. With a reference (the concept cut out, on the same background), also
 * how closely the render matches it.
 */
async function canvasViews(
  ctx: ArtContext,
  canvasRig: Rig,
  frame: Frame,
  concept: Buffer,
  size: { width: number; height: number },
  reference: Pixels | null,
) {
  checkAbort(ctx);
  const direction = ctx.project().art.direction;
  const images = await rigImages(ctx, canvasRig);
  const drawn = await ctx.renderer.renderRig({
    rig: canvasRig,
    // Outline widths are game px; one canvas px is `scale` game px.
    direction: { ...direction, inkWidth: direction.inkWidth / frame.scale },
    clips: {},
    frames: [{ clip: null, time: 0 }],
    cellWidth: size.width,
    cellHeight: size.height,
    columns: 1,
    background: null,
    fit: false,
    ...(images ? { images } : {}),
  });
  const [render, overlay] = await Promise.all([
    ctx.renderer.compose({ ...size, background: BACKGROUND, layers: [{ image: drawn.png }] }),
    ctx.renderer.compose({ ...size, layers: [{ image: concept }, { image: drawn.png, alpha: 0.6 }], grid: GRID }),
  ]);
  let match: MatchScore | undefined;
  if (reference) {
    const pixels = decodePng(drawn.png);
    if (pixels.width === reference.width && pixels.height === reference.height) match = matchScore(flatten(pixels, BACKGROUND), reference, BACKGROUND);
  }
  return { render, overlay, warnings: drawn.warnings, match };
}

const matchText = (m: MatchScore | undefined) => (m ? `match ${Math.round(m.silhouette * 100)}% shape, ${Math.round(m.color * 100)}% color` : "");

/** The flat redraw's image quality: medium keeps it close to the design (what the creator voted on). */
const FLAT_REDRAW_QUALITY = "medium";
/** Critique rounds of a vector rig on the full pipeline (the voted "vector-loop"). */
const VECTOR_RIG_ROUNDS = 4;

export async function buildRig(ctx: ArtContext, input: RigInput): Promise<StageResult & { plan?: CutoutPlan }> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const asset = requireAsset(project, character);
  if (!asset.chosen) throw new StageError(`choose a concept design for "${character.name}" first`);
  const mode = rigModeFor(ctx, project, input.rigMode);
  // Vector rigs on the full pipeline: built from a flat redraw of the design, with elbows and knees, then detailed.
  const full = mode === "vector" && !input.puppet;
  const revising = Boolean(input.feedback?.trim() && asset.rig);
  const operations: OperationCall[] = [];
  let chosen = asset.chosen;
  if (full && (input.redraw ?? true) && !chosen.original && !revising) {
    const redrawn = await redrawFlat(ctx, { characterId: character.id, quality: FLAT_REDRAW_QUALITY });
    const choice = redrawn.operations[0]!.input as { file: FileRef };
    operations.push(...redrawn.operations);
    chosen = { ...chosen, file: choice.file, original: chosen.file };
  }
  const concept = await ctx.files.get(chosen.file);
  const size = pngSize(concept);
  // The design cut out of its background: the cutout rig's image, and what every attempt is measured against.
  const cut = cutCharacter(decodePng(concept));
  const reference = cut ? flatten(placeCutout(cut, size), BACKGROUND) : null;
  const options = {
    limbJoints: input.limbJoints ?? (full ? true : undefined),
    cleanTrace: input.cleanTrace,
    review: input.review,
    rounds: input.rounds ?? (full && ctx.rigRounds === undefined ? VECTOR_RIG_ROUNDS : undefined),
    sheetQuality: input.sheetQuality,
  };
  const best = input.puppet
    ? await puppetAttempts(ctx, { character, asset, concept, size, cut, reference, feedback: input.feedback?.trim(), ...options })
    : mode === "cutout" || mode === "traced"
      ? await cutoutAttempts(ctx, { character, asset, concept, size, cut, reference, feedback: input.feedback?.trim(), mode, ...options })
      : await vectorAttempts(ctx, { character, asset, concept, size, reference, feedback: input.feedback?.trim(), ...options });

  // The finish: detail shapes (shading, highlights, folds, seams) from the design as drawn, on each part's bone.
  let rig = best.rig;
  let finish = "";
  if (full && (input.detail ?? true) && !revising) {
    try {
      const design = chosen.original ? await ctx.files.get(chosen.original) : concept;
      const dressed = await detailLook(ctx, { rig: best.rig, frame: best.frame, canvas: size, design, brief: asset.brief });
      rig = dressed.rig;
      finish = `, ${dressed.details?.length ?? 0} detail shapes`;
    } catch (error) {
      if (error instanceof BudgetExceeded || ctx.signal?.aborted) throw error;
      ctx.log({ text: `details skipped (${error instanceof Error ? error.message : String(error)})` });
    }
  }
  // Where it holds a weapon: the front hand (placed from the rig before its detail shapes; optional, never fails the build).
  const gripped = withHandGrip(best.rig);
  const hand = gripped.grips?.find((g) => g.id === "hand");
  if (hand) {
    rig = { ...rig, grips: gripped.grips };
    ctx.log({ text: `holds weapons in ${hand.bone} at [${hand.at.join(", ")}]` });
  }

  const preview = await ctx.files.put((await renderRest(ctx, rig)).png, "png");
  operations.push({
    name: "setRig",
    input: {
      assetId: asset.id,
      rig,
      preview: { file: preview, score: best.score, notes: best.notes.slice(0, 2000), frame: best.frame, ...(best.match ? { match: best.match } : {}) },
    },
  });
  return {
    operations,
    ...(best.plan ? { plan: best.plan } : {}),
    summary: `built ${character.name}'s ${input.puppet ? "puppet" : mode} rig (score ${best.score}/10${best.match ? `, ${matchText(best.match)}` : ""}${finish})`,
  };
}

interface AttemptInput {
  character: Character;
  asset: CharacterAsset;
  concept: Buffer;
  size: { width: number; height: number };
  reference: Pixels | null;
  feedback?: string;
  limbJoints?: boolean;
  cleanTrace?: boolean;
  review?: boolean;
  rounds?: number;
  sheetQuality?: string;
}

/** Vector rig: the model traces flat shapes; render over the concept, score, revise. Keeps the best attempt. */
async function vectorAttempts(ctx: ArtContext, { character, asset, concept, size, reference, feedback: direction, limbJoints, rounds: roundsWanted }: AttemptInput): Promise<Attempt> {
  const system = rigSystemPrompt(ctx.project().art.direction, size);
  const gridded = await ctx.renderer.compose({ ...size, layers: [{ image: concept }], grid: GRID });

  // The model traces in concept pixels ("canvas space"); see frame.ts.
  let canvasRig: Rig;
  if (direction && asset.rig && (asset.rig.mode ?? "vector") === "vector") {
    canvasRig = toCanvasSpace(asset.rig, frameForCanvas(asset.rig, size));
    ctx.log({ text: "revising the current rig" });
  } else {
    const authored = await askJson(
      ctx,
      RigReply,
      { system, content: [image(gridded), text(rigAuthorPrompt(character, asset.brief, size, { limbJoints }))], maxTokens: 12000 },
      "building the rig",
    );
    canvasRig = authored.rig;
  }

  const rounds = roundsWanted ?? ctx.rigRounds ?? 3;
  let best: Attempt | null = null;
  let feedback = direction;
  for (let round = 0; round < rounds; round++) {
    const frame = fitFrame(canvasRig, character.size);
    const rig = toRigSpace(canvasRig, frame);
    const views = await canvasViews(ctx, canvasRig, frame, concept, size, reference);
    ctx.log({ text: `render ${round + 1}${views.match ? ` (${matchText(views.match)})` : ""}`, file: await ctx.files.put(views.overlay, "png") });
    if (ctx.remaining() < CRITIQUE_RESERVE) {
      ctx.log({ text: "budget nearly used; stopping the critique loop" });
      best = better(best, { rig, frame, score: 0, notes: "not reviewed (budget)", match: views.match });
      break;
    }
    const prompt = rigCritiquePrompt({ character, brief: asset.brief, rig: canvasRig, warnings: views.warnings, canvas: size });
    const critique = await askJson(
      ctx,
      Critique,
      {
        system,
        content: [
          image(gridded),
          image(views.render),
          image(views.overlay),
          text(feedback ? `${prompt}\nCreator's direction: ${feedback}` : prompt),
        ],
        maxTokens: 12000,
      },
      `reviewing render ${round + 1}`,
    );
    feedback = undefined; // applied once
    const notes = critique.issues.join("; ");
    ctx.log({ text: `score ${critique.score}/10${notes ? `: ${notes}` : ""}` });
    best = better(best, { rig, frame, score: critique.score, notes, match: views.match });
    if (critique.score >= 8 && round > 0) break;
    const revised = Rig.safeParse(critique.rig);
    if (!revised.success) {
      ctx.log({ text: "the revision was invalid; keeping the best so far" });
      break;
    }
    canvasRig = revised.data;
  }
  if (!best) throw new StageError("no rig was produced");
  return best;
}

/** Every non-root bone bent -25° at t=0 and +25° at t=1 (the critic's puppet check). */
function flexClip(rig: Rig): Clip {
  return Clip.parse({
    duration: 1,
    loop: false,
    tracks: rig.bones.filter((b) => b.parent !== null).map((b) => ({ bone: b.id, property: "rotate", keys: [[0, -25], [1, 25]], ease: "linear" })),
  });
}

/**
 * Cutout and traced rigs: the design itself, cut into pieces. The model plans the skeleton and
 * rough part regions; code assigns the pixels, puts each pivot where its pieces meet and either
 * traces the pieces' outlines (cutout.ts: image parts showing the design) or redraws each piece
 * as flat vector shapes (traced.ts), so the rest pose is the design. The critic sees the split
 * and the bones bent, and may move pivots or regions; an attempt that looks less like the
 * design never wins.
 */
async function cutoutAttempts(ctx: ArtContext, input: AttemptInput & { cut: Cutout | null; mode: "cutout" | "traced" }): Promise<Attempt> {
  const { character, asset, size, cut, reference, mode } = input;
  if (!cut || !reference) throw new StageError("could not find the character on the design's background (it needs a plain, flat background)");
  const frame = fitBounds(cut.bounds, character.size);
  let file = "";
  let images: Record<string, string> | undefined;
  if (mode === "cutout") {
    const sourcePng = encodePng(cut.image);
    file = await ctx.files.put(sourcePng, "png");
    images = { [file]: sourcePng.toString("base64") };
  }
  const direction = ctx.project().art.direction;
  const build = (plan: CutoutPlan) =>
    mode === "cutout" ? cutoutRig(cut, plan, file) : tracedRig(cut, plan, direction, { canvasPerGamePx: 1 / frame.scale, clean: input.cleanTrace });
  const review = input.review === true && mode === "traced";
  const gridded = await ctx.renderer.compose({ ...size, layers: [{ image: encodePng(reference) }], grid: GRID });
  const system = cutoutSystemPrompt(size);

  let plan: CutoutPlan;
  const previous = asset.rig?.mode === mode && asset.preview?.frame ? toCanvasSpace(asset.rig, asset.preview.frame) : null;
  if (input.feedback && previous) {
    plan = planFromRig(previous);
    ctx.log({ text: "revising the current rig" });
  } else {
    plan = await askJson(
      ctx,
      CutoutPlan,
      {
        system,
        content: [image(gridded), text(cutoutAuthorPrompt(character, asset.brief, size, { limbJoints: input.limbJoints, features: input.cleanTrace && mode === "traced" }))],
        maxTokens: 8000,
      },
      "planning the cutout rig",
    );
  }

  const rounds = input.rounds ?? ctx.rigRounds ?? 3;
  let best: Attempt | null = null;
  let feedback = input.feedback;
  for (let round = 0; round < rounds; round++) {
    const built = build(plan);
    const rig = toRigSpace(built.rig, frame);
    const views = await canvasViews(ctx, built.rig, frame, input.concept, size, reference);
    for (const w of built.warnings) ctx.log({ text: w });
    const parts = await ctx.renderer.compose({ ...size, layers: [{ image: encodePng(partsView(cut, built.labels, { ...plan, bones: built.bones }, size)) }], grid: GRID });
    ctx.log({ text: `cutout ${round + 1}: ${rig.parts.length} parts (${matchText(views.match)})`, file: await ctx.files.put(parts, "png") });
    if (ctx.remaining() < CRITIQUE_RESERVE) {
      ctx.log({ text: "budget nearly used; stopping the critique loop" });
      best = better(best, { rig, frame, score: 0, notes: "not reviewed (budget)", match: views.match, plan: { ...plan, bones: built.bones } });
      break;
    }
    const posed = await ctx.renderer.renderRig({
      rig,
      direction: ctx.project().art.direction,
      clips: { flex: flexClip(rig) },
      frames: [{ clip: "flex", time: 0 }, { clip: null, time: 0 }, { clip: "flex", time: 1 }],
      cellWidth: 192,
      cellHeight: 192,
      columns: 3,
      background: BACKGROUND,
      ...(images ? { images } : {}),
    });
    ctx.log({ text: `bones bent ${round + 1}`, file: await ctx.files.put(posed.png, "png") });
    const prompt = cutoutCritiquePrompt({ plan: { ...plan, bones: built.bones }, warnings: [...built.warnings, ...views.warnings], canvas: size, review });
    const critique = await askJson(
      ctx,
      CutoutCritique,
      {
        system,
        content: [
          image(gridded),
          image(parts),
          image(posed.png),
          ...(review ? [image(views.render)] : []),
          text(feedback ? `${prompt}\nCreator's direction: ${feedback}` : prompt),
        ],
        maxTokens: 8000,
      },
      `reviewing cutout ${round + 1}`,
    );
    feedback = undefined;
    const notes = critique.issues.join("; ");
    ctx.log({ text: `score ${critique.score}/10${notes ? `: ${notes}` : ""}` });
    best = better(best, { rig, frame, score: critique.score, notes, match: views.match, plan: { ...plan, bones: built.bones } });
    if ((critique.score >= 8 && round > 0) || critique.plan === undefined || critique.plan === null) break;
    const revised = CutoutPlan.safeParse(critique.plan);
    if (!revised.success) {
      ctx.log({ text: "the revision was invalid; keeping the best so far" });
      break;
    }
    plan = revised.data;
  }
  if (!best) throw new StageError("no rig was produced");
  return best;
}

const PuppetMatches = z.object({ parts: z.array(PieceMatch) });
const PuppetCritique = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string()).default([]), nudges: z.array(PieceNudge).default([]) });

/**
 * Puppet rigs: plan the skeleton and parts on the design (with each piece's description), have
 * the image model draw those pieces apart on a parts sheet (one edit of the design), find each
 * part's piece and two anchor points on it (vision), then put the traced pieces back on the
 * design's joints (puppet.ts); the critic nudges misplaced pieces. Parts without a usable piece
 * are traced from the design itself. The attempt that looks most like the design wins.
 */
async function puppetAttempts(ctx: ArtContext, input: AttemptInput & { cut: Cutout | null }): Promise<Attempt> {
  const { character, asset, concept, size, cut, reference } = input;
  if (!cut || !reference) throw new StageError("could not find the character on the design's background (it needs a plain, flat background)");
  const frame = fitBounds(cut.bounds, character.size);
  const direction = ctx.project().art.direction;
  const gridded = await ctx.renderer.compose({ ...size, layers: [{ image: encodePng(reference) }], grid: GRID });
  const plan = await askJson(
    ctx,
    PuppetPlan,
    { system: cutoutSystemPrompt(size), content: [image(gridded), text(puppetPlanPrompt(character, asset.brief, size))], maxTokens: 8000 },
    "planning the puppet",
  );
  const cutPlan: CutoutPlan = { bones: plan.bones, parts: plan.parts.map(({ id, bone, z, region }) => ({ id, bone, z, region })) };
  const labels = labelParts(cut, cutPlan);
  const bones = jointPivots(cut, cutPlan, labels);
  const canvasPerGamePx = 1 / frame.scale;
  // The design traced as it is: parts without a usable piece keep these shapes.
  const conceptRig = tracedRig(cut, { ...cutPlan, bones }, direction, { canvasPerGamePx, clean: true }).rig;
  const anchors = partAnchors(plan, bones, labels, cut);
  const drawn = drawnParts(plan);

  checkAbort(ctx);
  const generated = await ctx.image.generate({
    prompt: partsSheetPrompt(asset.brief, drawn.map((p) => p.piece)),
    references: [concept],
    signal: ctx.signal,
    ...(input.sheetQuality ? { quality: input.sheetQuality } : {}),
  });
  ctx.spend(generated.usage);
  const sheetPng = await ctx.renderer.crop(await opaque(ctx, generated.image), { x: 0, y: 0, width: 1, height: 1 }, 1024);
  ctx.log({ text: `parts sheet (${generated.model})`, cost: generated.usage.cost, file: await ctx.files.put(sheetPng, "png") });
  const sheetPixels = decodePng(sheetPng);
  const sheet = sheetPieces(sheetPixels);
  if (!sheet || sheet.pieces.length === 0) throw new StageError("the parts sheet has no pieces on a plain background");
  const sheetSize = { width: sheetPixels.width, height: sheetPixels.height };
  const boxed = await ctx.renderer.compose({ ...sheetSize, layers: [{ image: encodePng(piecesView(sheetPixels, sheet.pieces)) }], grid: GRID });
  const split = await ctx.renderer.compose({ ...size, layers: [{ image: encodePng(partsView(cut, labels, { ...cutPlan, bones }, size)) }], grid: GRID });
  const describe = (a: { label: string }) => a.label;
  const wanted = drawn.flatMap((p) => {
    const anchor = anchors.get(p.id);
    return anchor ? [{ id: p.id, piece: p.piece, a: describe(anchor[0]), b: describe(anchor[1]) }] : [];
  });
  const { parts: matches } = await askJson(
    ctx,
    PuppetMatches,
    { system: PUPPET_SYSTEM, content: [image(gridded), image(split), image(boxed), text(puppetMatchPrompt({ parts: wanted, pieces: sheet.pieces, sheet: sheetSize }))], maxTokens: 6000 },
    "finding the pieces",
  );
  ctx.log({ text: `${sheet.pieces.length} pieces on the sheet; ${matches.filter((m) => m.piece !== null).length} of ${wanted.length} parts found` });

  const rounds = input.rounds ?? ctx.rigRounds ?? 3;
  let best: Attempt | null = null;
  let nudges: PieceNudge[] = [];
  for (let round = 0; round < rounds; round++) {
    const built = assemblePuppet({ plan, bones, anchors, sheet, matches, nudges, conceptRig, direction, canvasPerGamePx });
    for (const w of built.warnings) ctx.log({ text: w });
    const rig = toRigSpace(built.rig, frame);
    const views = await canvasViews(ctx, built.rig, frame, concept, size, reference);
    ctx.log({
      text: `puppet ${round + 1}: ${rig.parts.length} shapes${built.fallback.length > 0 ? `, ${built.fallback.join(", ")} from the design` : ""} (${matchText(views.match)})`,
      file: await ctx.files.put(views.overlay, "png"),
    });
    if (ctx.remaining() < CRITIQUE_RESERVE) {
      best = better(best, { rig, frame, score: 0, notes: "not reviewed (budget)", match: views.match });
      break;
    }
    const posed = await ctx.renderer.renderRig({
      rig,
      direction,
      clips: { flex: flexClip(rig) },
      frames: [{ clip: "flex", time: 0 }, { clip: null, time: 0 }, { clip: "flex", time: 1 }],
      cellWidth: 192,
      cellHeight: 192,
      columns: 3,
      background: BACKGROUND,
    });
    const critique = await askJson(
      ctx,
      PuppetCritique,
      {
        system: PUPPET_SYSTEM,
        content: [image(gridded), image(views.overlay), image(posed.png), text(puppetCritiquePrompt({ parts: plan.parts.map((p) => p.id), fallback: built.fallback, canvas: size }))],
        maxTokens: 4000,
      },
      `reviewing puppet ${round + 1}`,
    );
    const notes = critique.issues.join("; ");
    ctx.log({ text: `score ${critique.score}/10${notes ? `: ${notes}` : ""}` });
    best = better(best, { rig, frame, score: critique.score, notes, match: views.match });
    if ((critique.score >= 8 && round > 0) || critique.nudges.length === 0) break;
    nudges = critique.nudges;
  }
  if (!best) throw new StageError("no rig was produced");
  return best;
}

// --- stage: animate -----------------------------------------------------------------

export interface AnimateInput {
  characterId: string;
  feedback?: string;
  /** Only these clips (default: every slot the character's characters use, and their weapons' attack clips). */
  slots?: ClipSlot[];
  /**
   * Only these clips, by name: clip slots, weapon attack clips, or any other name (written from its
   * direction). Redoes them; `feedback` is kept as each one's direction (else a clip's stored
   * direction is used again).
   */
  clips?: string[];
  /** One clip by name (the same as `clips: [clip]`). */
  clip?: string;
  /** What the named clips should be (the creator's words, kept on Clip.direction); else `feedback`. */
  direction?: string;
  /** Only this weapon's attack clips (one per attack). */
  weaponId?: string;
  /** The rig has elbows and knees: ask for them to bend. Default: on for vector rigs (built with them). */
  limbJoints?: boolean;
  /** Rigs cut from the drawing: limit each joint by the overlap around the joint only (motionLimits `joint`). */
  jointLimits?: boolean;
}

/** The clip slots an asset needs (core wantedClipSlots). */
export const slotsFor = wantedClipSlots;

const ClipsReply = z.object({ clips: z.record(Id, Clip) });
const AnimCritique = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string()).default([]), clips: z.unknown() });

/** A weapon held in renders: the weapon, the attack whose phases follow the clip time, its sprite. */
interface Held {
  weapon: Weapon;
  attack?: string;
}

/** The most frames one render request takes (core protocol RenderRigRequest). */
const MAX_RENDER_FRAMES = 96;

/** One row of FILMSTRIP_FRAMES frames per clip, rendered in requests of at most MAX_RENDER_FRAMES and stacked into one sheet. */
async function filmstrips(ctx: ArtContext, rig: Rig, clips: Record<string, Clip>, ids: string[], held?: Held): Promise<Buffer> {
  const perRequest = Math.max(1, Math.floor(MAX_RENDER_FRAMES / FILMSTRIP_FRAMES));
  if (ids.length <= perRequest) return filmstripSheet(ctx, rig, clips, ids, held);
  const parts: Pixels[] = [];
  for (let i = 0; i < ids.length; i += perRequest) parts.push(decodePng(await filmstripSheet(ctx, rig, clips, ids.slice(i, i + perRequest), held)));
  const width = parts[0]!.width;
  const height = parts.reduce((h, p) => h + p.height, 0);
  const data = new Uint8Array(width * height * 4);
  let offset = 0;
  for (const p of parts) {
    data.set(p.data.subarray(0, p.width * p.height * 4), offset);
    offset += p.width * p.height * 4;
  }
  return encodePng({ width, height, data } as Pixels);
}

async function filmstripSheet(ctx: ArtContext, rig: Rig, clips: Record<string, Clip>, ids: string[], held?: Held): Promise<Buffer> {
  checkAbort(ctx);
  const frames = ids.flatMap((id) =>
    Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => ({ clip: id, time: (clips[id]!.duration * i) / FILMSTRIP_FRAMES })),
  );
  const images = { ...(await rigImages(ctx, rig)), ...(held ? await weaponImages(ctx, held.weapon) : {}) };
  const image = await ctx.renderer.renderRig({
    rig,
    direction: ctx.project().art.direction,
    clips,
    frames,
    cellWidth: 128,
    cellHeight: 128,
    columns: FILMSTRIP_FRAMES,
    background: BACKGROUND,
    ...(Object.keys(images).length ? { images } : {}),
    ...(held ? { weapon: { weapon: held.weapon, attack: held.attack ?? null } } : {}),
  });
  return image.png;
}

/** A weapon's sprite for the renderer (base64 by file ref), if it has one. */
async function weaponImages(ctx: Pick<ArtContext, "files">, weapon: Weapon): Promise<Record<string, string>> {
  return weapon.art.sprite ? { [weapon.art.sprite]: (await ctx.files.get(weapon.art.sprite)).toString("base64") } : {};
}

/** Only the wanted clips. */
const pick = (clips: Record<string, Clip>, names: readonly string[]) => Object.fromEntries(Object.entries(clips).filter(([id]) => names.includes(id)));

const isSlot = (name: string): name is ClipSlot => Object.hasOwn(CLIP_SLOTS, name);

/** A weapon attack clip to write. */
interface WeaponJob {
  clip: string;
  weapon: Weapon;
  attack: WeaponAttack;
}

export async function animate(ctx: ArtContext, input: AnimateInput): Promise<StageResult> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const asset = requireAsset(project, character);
  if (!asset.rig) throw new StageError(`build "${character.name}"'s rig first`);
  const rig = asset.rig;

  // What to write: slots, weapon attack clips and clips by any other name.
  const attackOf = (weaponId: string, attackId: string): WeaponJob | null => {
    const weapon = project.weapons.list.find((w) => w.id === weaponId);
    const attack = weapon?.attacks.find((a) => a.id === attackId);
    return weapon && attack ? { clip: attackClipName(weapon, attack), weapon, attack } : null;
  };
  const allAttackClips = project.weapons.list.flatMap((w) => w.attacks.map((a) => attackOf(w.id, a.id)!));
  const named = input.clips ?? (input.clip ? [input.clip] : undefined);
  const explicit = Boolean(named || input.slots || input.weaponId);
  const said = input.direction?.trim() || input.feedback?.trim();
  let slots: ClipSlot[];
  const jobs = new Map<string, WeaponJob>();
  const custom: string[] = [];
  if (!explicit) {
    slots = slotsFor(project, asset.id);
    for (const w of wantedWeaponClips(project, asset.id)) {
      const job = attackOf(w.weaponId, w.attackId);
      if (job) jobs.set(job.clip, job);
    }
  } else {
    slots = [...new Set([...(input.slots ?? []), ...(named ?? []).filter(isSlot)])];
    if (input.weaponId) {
      const weapon = project.weapons.list.find((w) => w.id === input.weaponId);
      if (!weapon) throw new StageError(`no weapon "${input.weaponId}"`);
      if (weapon.attacks.length === 0) throw new StageError(`${weapon.name} has no attacks to animate yet`);
      for (const a of weapon.attacks) jobs.set(attackClipName(weapon, a), attackOf(weapon.id, a.id)!);
    }
    for (const name of named ?? []) {
      if (isSlot(name) || jobs.has(name)) continue;
      const job = allAttackClips.find((j) => j.clip === name);
      if (job) jobs.set(name, job);
      else custom.push(name);
    }
  }
  // The creator's direction for each clip written: the new one for clips named here, else the clip's own.
  const direction = (name: string): string | undefined =>
    ((explicit && said) || asset.clips[name]?.direction || undefined)?.slice(0, 600);
  const wanted = [...slots, ...custom];

  const rest = asset.preview ? await ctx.files.get(asset.preview.file) : (await renderRest(ctx, rig)).png;
  const system = animSystemPrompt();
  const limbJoints = input.limbJoints ?? (rig.mode ?? "vector") === "vector";
  // Rigs cut from the drawing come apart past their joints' overlap: their clips are fitted to per-bone limits.
  const limits = rig.mode === "cutout" || rig.mode === "traced" ? motionLimits(rig, { joint: input.jointLimits }) : null;
  const fit = (clips: Record<string, Clip>) => (limits ? fitClips(clips, limits) : clips);
  const limitsLine = limits && limits.size > 0 ? limitsText(limits) : undefined;
  const directions = Object.fromEntries(slots.flatMap((s) => (direction(s) && direction(s) !== input.feedback?.trim() ? [[s, direction(s)!]] : [])));
  const write = async (names: string[], label: string) =>
    fit(
      pick(
        (
          await askJson(
            ctx,
            ClipsReply,
            {
              system,
              content: [
                image(rest),
                text(
                  animPrompt({
                    character,
                    brief: asset.brief,
                    rig,
                    slots: names.filter(isSlot),
                    custom: names.filter((n) => !isSlot(n)).map((name) => ({ name, direction: direction(name) ?? "" })),
                    directions,
                    feedback: input.feedback,
                    limits: limitsLine,
                    limbJoints,
                  }),
                ),
              ],
              maxTokens: 10000,
            },
            label,
          )
        ).clips,
        names,
      ),
    );

  let clips: Record<string, Clip> = {};
  if (wanted.length > 0) {
    clips = await write(wanted, `writing ${wanted.join(", ")}`);
    // Exactly the wanted clips: one more call for any the model skipped.
    const missing = wanted.filter((s) => !clips[s]);
    if (missing.length > 0 && Object.keys(clips).length > 0) {
      clips = { ...clips, ...(await write(missing, `writing the missing ${missing.join(", ")}`)) };
      const still = wanted.filter((s) => !clips[s]);
      if (still.length > 0) ctx.log({ text: `no clip for ${still.join(", ")} (they fall back to other clips)` });
    }
  }

  // Weapon attack clips: written with the attack's shape and timing, then held to them.
  const grip = rig.grips?.find((g) => g.id === "hand") ?? null;
  const settle = (raw: Record<string, Clip>) => settleWeaponClips(ctx, rig, grip, [...jobs.values()], raw, fit);
  if (jobs.size > 0) {
    const briefs = [...jobs.values()].map((j) => weaponClipBrief(j.weapon, j.attack, j.clip, grip?.angle ?? 0, direction(j.clip)));
    let written: Record<string, Clip> = {};
    try {
      written = (
        await askJson(
          ctx,
          ClipsReply,
          {
            system,
            content: [
              image(rest),
              text(weaponAnimPrompt({ brief: asset.brief, rig, grip: grip ? { ...grip, at: [grip.at[0], grip.at[1]], path: gripBones(rig, grip) } : null, clips: briefs, limits: limitsLine, limbJoints })),
            ],
            maxTokens: 10000,
          },
          `writing ${[...jobs.keys()].join(", ")}`,
        )
      ).clips;
    } catch (error) {
      if (error instanceof BudgetExceeded || ctx.signal?.aborted) throw error;
      ctx.log({ text: `the attack clips came back invalid (${error instanceof Error ? error.message : String(error)}); moving the weapon by its attack alone` });
    }
    clips = { ...clips, ...settle(written) };
  }
  let ids = Object.keys(clips);
  if (ids.length === 0) throw new StageError("the model wrote no clips");

  for (let round = 0; round < (ctx.animRounds ?? 1); round++) {
    const sheet = await filmstrips(ctx, rig, clips, ids, heldFor(project, [...jobs.values()]));
    const file = await ctx.files.put(sheet, "png");
    ctx.log({ text: `filmstrips ${round + 1}`, file });
    if (ctx.remaining() < CRITIQUE_RESERVE) break;
    const critique = await askJson(
      ctx,
      AnimCritique,
      {
        system,
        content: [image(sheet), text(animCritiquePrompt({ slots: ids, clipsJson: JSON.stringify(clips), framesPerClip: FILMSTRIP_FRAMES, limits: limitsLine }))],
        maxTokens: 10000,
      },
      `reviewing animation ${round + 1}`,
    );
    ctx.log({ text: `score ${critique.score}/10${critique.issues.length ? `: ${critique.issues.join("; ")}` : ""}` });
    if (critique.score >= 8) break;
    const revised = z.record(Id, Clip).safeParse(critique.clips);
    if (!revised.success || Object.keys(pick(revised.data, ids)).length === 0) {
      ctx.log({ text: "the revision was invalid; keeping the clips as written" });
      break;
    }
    // A revision that drops a clip keeps the written one; revised attack clips are held to their attacks again.
    const picked = pick(revised.data, ids);
    const weaponRevised = Object.fromEntries(Object.entries(picked).filter(([id]) => jobs.has(id)));
    clips = { ...clips, ...fit(Object.fromEntries(Object.entries(picked).filter(([id]) => !jobs.has(id)))), ...settle(weaponRevised) };
    ids = Object.keys(clips);
  }

  const operations: OperationCall[] = [];
  for (const id of ids) {
    const job = jobs.get(id);
    const strip = await filmstrips(ctx, rig, clips, [id], job ? { weapon: job.weapon, attack: job.attack.id } : undefined);
    const file = await ctx.files.put(strip, "png");
    const said = direction(id);
    const clip: Clip = { ...clips[id]! };
    delete clip.direction;
    operations.push({ name: "setClip", input: { assetId: asset.id, clipId: id, clip: { ...clip, ...(said ? { direction: said } : {}) }, preview: file } });
  }
  // An attack without a named clip is pointed at the one written for it (the runtime plays it during the attack).
  for (const job of jobs.values()) {
    if (job.attack.clip === null && clips[job.clip]) operations.push({ name: "setWeaponAttack", input: { weaponId: job.weapon.id, attack: { ...job.attack, clip: job.clip } } });
  }
  return { operations, summary: `animated ${character.name} (${ids.join(", ")})` };
}

/** The weapon to show in a filmstrip of several clips: the one weapon all the attack clips use, if they share one. */
function heldFor(project: ProjectSpec, jobs: WeaponJob[]): Held | undefined {
  const weapons = [...new Set(jobs.map((j) => j.weapon.id))];
  return weapons.length === 1 ? { weapon: project.weapons.list.find((w) => w.id === weapons[0])! } : undefined;
}

/**
 * Attack clips held to their attacks: each plays once over the attack's windup, active and recovery
 * (its duration), and on a rig with a hand the held weapon must move fastest inside the active
 * window and point where the attack does (checkWeaponClip); a clip that misses has its arm turned
 * to the attack (fitWeaponClip). A clip the model did not write is made from the attack alone.
 */
function settleWeaponClips(
  ctx: ArtContext,
  rig: Rig,
  grip: Grip | null,
  jobs: WeaponJob[],
  written: Record<string, Clip>,
  fit: (clips: Record<string, Clip>) => Record<string, Clip>,
): Record<string, Clip> {
  const out: Record<string, Clip> = {};
  for (const job of jobs) {
    const raw = written[job.clip];
    if (!raw && !grip) continue;
    const { duration } = attackTiming(job.attack);
    let clip: Clip = fit({ c: Clip.parse({ ...(raw ?? { tracks: [], motions: [] }), duration, loop: false }) }).c!;
    if (!grip) {
      out[job.clip] = clip;
      continue;
    }
    const length = heldLength(job.weapon);
    const before = raw ? checkWeaponClip(rig, grip, job.attack, clip, length) : null;
    if (!before?.ok) {
      clip = fitWeaponClip(rig, grip, job.attack, clip);
      const after = checkWeaponClip(rig, grip, job.attack, clip, length);
      ctx.log({
        text: `${job.clip}: ${raw ? `${before!.problems.join("; ")}: turned the arm to the attack` : "made from the attack's shape and timing"}${after.ok ? "" : ` (still: ${after.problems.join("; ")})`}`,
      });
    }
    out[job.clip] = clip;
  }
  return out;
}
