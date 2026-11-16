import { z } from "zod";
import {
  ACTION_CLIP_SLOTS,
  Clip,
  Id,
  PLAYER_CLIP_SLOTS,
  Rig,
  uniqueId,
  type CharacterAsset,
  type Character,
  type ClipSlot,
  type FileRef,
  type OperationCall,
  type ProjectSpec,
  type RenderRigRequest,
} from "@anomaly/core";
import { fitFrame, frameForCanvas, pngSize, toCanvasSpace, toRigSpace, type Frame } from "./frame.ts";
import { parseReply } from "./json.ts";
import type { ImageModel, ModelUsage, VisionContent, VisionModel, VisionRequest } from "./models.ts";
import {
  animCritiquePrompt,
  animPrompt,
  animSystemPrompt,
  conceptPrompt,
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
  return ctx.renderer.renderRig({
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

export async function generateConcepts(ctx: ArtContext, input: ConceptsInput): Promise<StageResult & { assetId: string }> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const operations: OperationCall[] = [];
  let asset = assetOf(project, character);
  let assetId: string;
  const brief = input.brief?.trim() || asset?.brief || character.name;

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
}

const RigReply = z.object({ rig: Rig, notes: z.string().optional() });
const Critique = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string()).default([]), rig: z.unknown() });

const GRID = 64;

/** Render a canvas-space rig in the concept's framing: alone, and laid over the concept. */
async function canvasViews(ctx: ArtContext, canvasRig: Rig, frame: Frame, concept: Buffer, size: { width: number; height: number }) {
  checkAbort(ctx);
  const direction = ctx.project().art.direction;
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
  });
  const [render, overlay] = await Promise.all([
    ctx.renderer.compose({ ...size, background: BACKGROUND, layers: [{ image: drawn.png }] }),
    ctx.renderer.compose({ ...size, layers: [{ image: concept }, { image: drawn.png, alpha: 0.6 }], grid: GRID }),
  ]);
  return { render, overlay, warnings: drawn.warnings };
}

export async function buildRig(ctx: ArtContext, input: RigInput): Promise<StageResult> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const asset = requireAsset(project, character);
  if (!asset.chosen) throw new StageError(`choose a concept design for "${character.name}" first`);
  const concept = await ctx.files.get(asset.chosen.file);
  const size = pngSize(concept);
  const system = rigSystemPrompt(project.art.direction, size);
  const gridded = await ctx.renderer.compose({ ...size, layers: [{ image: concept }], grid: GRID });

  // The model traces in concept pixels ("canvas space"); see frame.ts.
  let canvasRig: Rig;
  if (input.feedback?.trim() && asset.rig) {
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

  // Critique loop: render over the concept, score, revise. Keep the best scored rig.
  const rounds = ctx.rigRounds ?? 3;
  let best: { rig: Rig; score: number; notes: string; frame: Frame } | null = null;
  let feedback = input.feedback?.trim();
  for (let round = 0; round < rounds; round++) {
    const frame = fitFrame(canvasRig, character.size);
    const rig = toRigSpace(canvasRig, frame);
    const views = await canvasViews(ctx, canvasRig, frame, concept, size);
    ctx.log({ text: `render ${round + 1}`, file: await ctx.files.put(views.overlay, "png") });
    if (ctx.remaining() < CRITIQUE_RESERVE) {
      ctx.log({ text: "budget nearly used; stopping the critique loop" });
      if (!best) best = { rig, score: 0, notes: "not reviewed (budget)", frame };
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
    if (!best || critique.score > best.score) best = { rig, score: critique.score, notes, frame };
    if (critique.score >= 8 && round > 0) break;
    const revised = Rig.safeParse(critique.rig);
    if (!revised.success) {
      ctx.log({ text: "the revision was invalid; keeping the best so far" });
      break;
    }
    canvasRig = revised.data;
  }
  if (!best) throw new StageError("no rig was produced");

  const preview = await ctx.files.put((await renderRest(ctx, best.rig)).png, "png");
  return {
    operations: [
      { name: "setRig", input: { assetId: asset.id, rig: best.rig, preview: { file: preview, score: best.score, notes: best.notes.slice(0, 2000), frame: best.frame } } },
    ],
    summary: `built ${character.name}'s rig (score ${best.score}/10)`,
  };
}

// --- stage: animate -----------------------------------------------------------------

export interface AnimateInput {
  characterId: string;
  feedback?: string;
  /** Only these clips (default: every slot the character's characters use). */
  slots?: ClipSlot[];
}

/** Clip slots needed by every character drawn with this asset. */
export function slotsFor(project: ProjectSpec, assetId: string): ClipSlot[] {
  const slots = new Set<ClipSlot>(["idle"]);
  for (const c of project.characters) {
    if (c.appearance !== assetId) continue;
    if (c.kind === "player") {
      PLAYER_CLIP_SLOTS.forEach((s) => slots.add(s));
      continue;
    }
    slots.add("hurt"); // enemies flash and recoil when the sword hits them
    const flying = (c as { movement?: string }).movement === "flying";
    for (const state of Object.values(c.behavior.states)) {
      const slot = ACTION_CLIP_SLOTS[state.action.type]?.[0];
      if (slot) slots.add(flying && (slot === "walk" || slot === "run") ? "fly" : slot);
    }
  }
  return [...slots];
}

const ClipsReply = z.object({ clips: z.record(Id, Clip) });
const AnimCritique = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string()).default([]), clips: z.unknown() });

async function filmstrips(ctx: ArtContext, rig: Rig, clips: Record<string, Clip>, ids: string[]): Promise<Buffer> {
  checkAbort(ctx);
  const frames = ids.flatMap((id) =>
    Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => ({ clip: id, time: (clips[id]!.duration * i) / FILMSTRIP_FRAMES })),
  );
  const image = await ctx.renderer.renderRig({
    rig,
    direction: ctx.project().art.direction,
    clips,
    frames,
    cellWidth: 128,
    cellHeight: 128,
    columns: FILMSTRIP_FRAMES,
    background: BACKGROUND,
  });
  return image.png;
}

export async function animate(ctx: ArtContext, input: AnimateInput): Promise<StageResult> {
  const project = ctx.project();
  const character = findCharacter(project, input.characterId);
  const asset = requireAsset(project, character);
  if (!asset.rig) throw new StageError(`build "${character.name}"'s rig first`);
  const rig = asset.rig;
  const slots = input.slots ?? slotsFor(project, asset.id);
  const rest = asset.preview ? await ctx.files.get(asset.preview.file) : (await renderRest(ctx, rig)).png;
  const system = animSystemPrompt();

  const written = await askJson(
    ctx,
    ClipsReply,
    { system, content: [image(rest), text(animPrompt({ character, brief: asset.brief, rig, slots, feedback: input.feedback }))], maxTokens: 10000 },
    `writing ${slots.join(", ")}`,
  );
  let clips = written.clips;
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
    if (!revised.success || Object.keys(revised.data).length === 0) {
      ctx.log({ text: "the revision was invalid; keeping the clips as written" });
      break;
    }
    clips = revised.data;
    ids = Object.keys(clips);
  }

  const operations: OperationCall[] = [];
  for (const id of ids) {
    const strip = await filmstrips(ctx, rig, clips, [id]);
    const file = await ctx.files.put(strip, "png");
    operations.push({ name: "setClip", input: { assetId: asset.id, clipId: id, clip: clips[id], preview: file } });
  }
  return { operations, summary: `animated ${character.name} (${ids.join(", ")})` };
}
