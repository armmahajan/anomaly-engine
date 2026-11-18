import { z } from "zod";
import {
  wantedClipSlots,
  Clip,
  Id,
  Rig,
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
import { CutoutPlan, cutCharacter, cutoutRig, partsView, placeCutout, planFromRig, type Cutout } from "./cutout.ts";
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
  PICK_SYSTEM,
  pickPrompt,
  rigAuthorPrompt,
  rigCritiquePrompt,
  rigSystemPrompt,
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
  /** Rig mode when neither the request nor the art direction picks one (default vector; real backends pass cutout). */
  defaultRigMode?: "vector" | "cutout";
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
async function askJson<T extends z.ZodType>(
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
}

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
  });
  checkAbort(ctx);
  const generated = await ctx.image.generate({ prompt, references: reference ? [reference] : undefined, signal: ctx.signal });
  ctx.spend(generated.usage);
  const file = await ctx.files.put(generated.image, generated.ext);
  ctx.log({ text: `concept sheet (${generated.model})`, cost: generated.usage.cost, file });

  // A cheap second opinion on which design to take forward.
  let recommended: { cell: number; reason: string } | undefined;
  try {
    recommended = await askJson(
      ctx,
      z.object({ cell: z.number().int().min(0).max(3), reason: z.string().max(500) }),
      { system: PICK_SYSTEM, content: [image(generated.image), text(pickPrompt(brief, project.art.direction, input.feedback))], maxTokens: 3000 },
      "picking a design",
    );
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

  const file = await ctx.files.put(cropped, "png");
  ctx.log({ text: `chose design ${cell + 1} of sheet ${sheetIndex + 1}`, file });
  return {
    operations: [{ name: "chooseConcept", input: { assetId: asset.id, sheet: sheetIndex, cell, file } }],
    summary: `chose a design for ${character.name}`,
  };
}

// --- stage: rig ------------------------------------------------------------------

export interface RigInput {
  characterId: string;
  /** Revise the existing rig with this direction instead of building from scratch. */
  feedback?: string;
  /** Vector shapes or cutout pieces of the design (default: the art direction's rigMode, else the backend's default). */
  rigMode?: RigMode;
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
}

/** The better attempt: the measured likeness first, the critic's score on a tie (or when nothing was measured). */
function better(best: Attempt | null, next: Attempt): Attempt {
  if (!best) return next;
  if (best.match && next.match && Math.abs(matchValue(next.match) - matchValue(best.match)) > MATCH_TIE) {
    return matchValue(next.match) > matchValue(best.match) ? next : best;
  }
  return next.score > best.score ? next : best;
}

/** A cutout rig's source image for the renderer (base64 by file ref). */
async function rigImages(ctx: ArtContext, rig: Rig): Promise<Record<string, string> | undefined> {
  if (!rig.source) return undefined;
  return { [rig.source.file]: (await ctx.files.get(rig.source.file)).toString("base64") };
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

export async function buildRig(ctx: ArtContext, input: RigInput): Promise<StageResult> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const asset = requireAsset(project, character);
  if (!asset.chosen) throw new StageError(`choose a concept design for "${character.name}" first`);
  const concept = await ctx.files.get(asset.chosen.file);
  const size = pngSize(concept);
  // The design cut out of its background: the cutout rig's image, and what every attempt is measured against.
  const cut = cutCharacter(decodePng(concept));
  const reference = cut ? flatten(placeCutout(cut, size), BACKGROUND) : null;
  const mode = input.rigMode ?? project.art.direction.rigMode ?? ctx.defaultRigMode ?? "vector";
  const best =
    mode === "cutout"
      ? await cutoutAttempts(ctx, { character, asset, concept, size, cut, reference, feedback: input.feedback?.trim() })
      : await vectorAttempts(ctx, { character, asset, concept, size, reference, feedback: input.feedback?.trim() });

  const preview = await ctx.files.put((await renderRest(ctx, best.rig)).png, "png");
  return {
    operations: [
      {
        name: "setRig",
        input: {
          assetId: asset.id,
          rig: best.rig,
          preview: { file: preview, score: best.score, notes: best.notes.slice(0, 2000), frame: best.frame, ...(best.match ? { match: best.match } : {}) },
        },
      },
    ],
    summary: `built ${character.name}'s ${mode} rig (score ${best.score}/10${best.match ? `, ${matchText(best.match)}` : ""})`,
  };
}

interface AttemptInput {
  character: Character;
  asset: CharacterAsset;
  concept: Buffer;
  size: { width: number; height: number };
  reference: Pixels | null;
  feedback?: string;
}

/** Vector rig: the model traces flat shapes; render over the concept, score, revise. Keeps the best attempt. */
async function vectorAttempts(ctx: ArtContext, { character, asset, concept, size, reference, feedback: direction }: AttemptInput): Promise<Attempt> {
  const system = rigSystemPrompt(ctx.project().art.direction, size);
  const gridded = await ctx.renderer.compose({ ...size, layers: [{ image: concept }], grid: GRID });

  // The model traces in concept pixels ("canvas space"); see frame.ts.
  let canvasRig: Rig;
  if (direction && asset.rig && asset.rig.mode !== "cutout") {
    canvasRig = toCanvasSpace(asset.rig, frameForCanvas(asset.rig, size));
    ctx.log({ text: "revising the current rig" });
  } else {
    const authored = await askJson(
      ctx,
      RigReply,
      { system, content: [image(gridded), text(rigAuthorPrompt(character, asset.brief, size))], maxTokens: 12000 },
      "building the rig",
    );
    canvasRig = authored.rig;
  }

  const rounds = ctx.rigRounds ?? 3;
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
 * Cutout rig: the design itself, cut into pieces. The model plans the skeleton and rough part
 * regions; code assigns the pixels and traces the parts (cutout.ts), so the rest pose is the
 * design. The critic sees the split and the bones bent, and may move pivots or regions; an
 * attempt that looks less like the design never wins.
 */
async function cutoutAttempts(ctx: ArtContext, input: AttemptInput & { cut: Cutout | null }): Promise<Attempt> {
  const { character, asset, size, cut, reference } = input;
  if (!cut || !reference) throw new StageError("could not find the character on the design's background (it needs a plain, flat background)");
  const sourcePng = encodePng(cut.image);
  const file = await ctx.files.put(sourcePng, "png");
  const images = { [file]: sourcePng.toString("base64") };
  const gridded = await ctx.renderer.compose({ ...size, layers: [{ image: encodePng(reference) }], grid: GRID });
  const system = cutoutSystemPrompt(size);
  const frame = fitBounds(cut.bounds, character.size);

  let plan: CutoutPlan;
  const previous = asset.rig?.mode === "cutout" && asset.preview?.frame ? toCanvasSpace(asset.rig, asset.preview.frame) : null;
  if (input.feedback && previous) {
    plan = planFromRig(previous);
    ctx.log({ text: "revising the current rig" });
  } else {
    plan = await askJson(
      ctx,
      CutoutPlan,
      { system, content: [image(gridded), text(cutoutAuthorPrompt(character, asset.brief, size))], maxTokens: 8000 },
      "planning the cutout rig",
    );
  }

  const rounds = ctx.rigRounds ?? 3;
  let best: Attempt | null = null;
  let feedback = input.feedback;
  for (let round = 0; round < rounds; round++) {
    const built = cutoutRig(cut, plan, file);
    const rig = toRigSpace(built.rig, frame);
    const views = await canvasViews(ctx, built.rig, frame, input.concept, size, reference);
    for (const w of built.warnings) ctx.log({ text: w });
    const parts = await ctx.renderer.compose({ ...size, layers: [{ image: encodePng(partsView(cut, built.labels, plan, size)) }], grid: GRID });
    ctx.log({ text: `cutout ${round + 1}: ${rig.parts.length} parts (${matchText(views.match)})`, file: await ctx.files.put(parts, "png") });
    if (ctx.remaining() < CRITIQUE_RESERVE) {
      ctx.log({ text: "budget nearly used; stopping the critique loop" });
      best = better(best, { rig, frame, score: 0, notes: "not reviewed (budget)", match: views.match });
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
      images,
    });
    ctx.log({ text: `bones bent ${round + 1}`, file: await ctx.files.put(posed.png, "png") });
    const prompt = cutoutCritiquePrompt({ plan, warnings: [...built.warnings, ...views.warnings], canvas: size });
    const critique = await askJson(
      ctx,
      CutoutCritique,
      { system, content: [image(gridded), image(parts), image(posed.png), text(feedback ? `${prompt}\nCreator's direction: ${feedback}` : prompt)], maxTokens: 8000 },
      `reviewing cutout ${round + 1}`,
    );
    feedback = undefined;
    const notes = critique.issues.join("; ");
    ctx.log({ text: `score ${critique.score}/10${notes ? `: ${notes}` : ""}` });
    best = better(best, { rig, frame, score: critique.score, notes, match: views.match });
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

// --- stage: animate -----------------------------------------------------------------

export interface AnimateInput {
  characterId: string;
  feedback?: string;
  /** Only these clips (default: every slot the character's characters use). */
  slots?: ClipSlot[];
}

/** The clip slots an asset needs (core wantedClipSlots). */
export const slotsFor = wantedClipSlots;

const ClipsReply = z.object({ clips: z.record(Id, Clip) });
const AnimCritique = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string()).default([]), clips: z.unknown() });

async function filmstrips(ctx: ArtContext, rig: Rig, clips: Record<string, Clip>, ids: string[]): Promise<Buffer> {
  checkAbort(ctx);
  const frames = ids.flatMap((id) =>
    Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => ({ clip: id, time: (clips[id]!.duration * i) / FILMSTRIP_FRAMES })),
  );
  const images = await rigImages(ctx, rig);
  const image = await ctx.renderer.renderRig({
    rig,
    direction: ctx.project().art.direction,
    clips,
    frames,
    cellWidth: 128,
    cellHeight: 128,
    columns: FILMSTRIP_FRAMES,
    background: BACKGROUND,
    ...(images ? { images } : {}),
  });
  return image.png;
}

/** Only the wanted slots. */
const pick = (clips: Record<string, Clip>, slots: readonly string[]) => Object.fromEntries(Object.entries(clips).filter(([id]) => slots.includes(id)));

export async function animate(ctx: ArtContext, input: AnimateInput): Promise<StageResult> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const asset = requireAsset(project, character);
  if (!asset.rig) throw new StageError(`build "${character.name}"'s rig first`);
  const rig = asset.rig;
  const slots = input.slots ?? slotsFor(project, asset.id);
  const rest = asset.preview ? await ctx.files.get(asset.preview.file) : (await renderRest(ctx, rig)).png;
  const system = animSystemPrompt();
  const write = async (wanted: ClipSlot[], label: string) =>
    pick(
      (
        await askJson(
          ctx,
          ClipsReply,
          { system, content: [image(rest), text(animPrompt({ character, brief: asset.brief, rig, slots: wanted, feedback: input.feedback }))], maxTokens: 10000 },
          label,
        )
      ).clips,
      wanted,
    );

  let clips = await write(slots, `writing ${slots.join(", ")}`);
  // Exactly the wanted slots: one more call for any the model skipped.
  const missing = slots.filter((s) => !clips[s]);
  if (missing.length > 0 && Object.keys(clips).length > 0) {
    clips = { ...clips, ...(await write(missing, `writing the missing ${missing.join(", ")}`)) };
    const still = slots.filter((s) => !clips[s]);
    if (still.length > 0) ctx.log({ text: `no clip for ${still.join(", ")} (they fall back to other clips)` });
  }
  let ids = Object.keys(clips);
  if (ids.length === 0) throw new StageError("the model wrote no clips");

  for (let round = 0; round < (ctx.animRounds ?? 1); round++) {
    const sheet = await filmstrips(ctx, rig, clips, ids);
    const file = await ctx.files.put(sheet, "png");
    ctx.log({ text: `filmstrips ${round + 1}`, file });
    if (ctx.remaining() < CRITIQUE_RESERVE) break;
    const critique = await askJson(
      ctx,
      AnimCritique,
      {
        system,
        content: [image(sheet), text(animCritiquePrompt({ slots: ids, clipsJson: JSON.stringify(clips), framesPerClip: FILMSTRIP_FRAMES }))],
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
    // A revision that drops a clip keeps the written one.
    clips = { ...clips, ...pick(revised.data, ids) };
  }

  const operations: OperationCall[] = [];
  for (const id of ids) {
    const strip = await filmstrips(ctx, rig, clips, [id]);
    const file = await ctx.files.put(strip, "png");
    operations.push({ name: "setClip", input: { assetId: asset.id, clipId: id, clip: clips[id], preview: file } });
  }
  return { operations, summary: `animated ${character.name} (${ids.join(", ")})` };
}
