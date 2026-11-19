import { rigFingerprint } from "./rig.ts";
import { z } from "zod";
import { Color, Id } from "../common.ts";
import type { OperationError, OperationResult } from "../operations.ts";
import { ProjectSpec } from "../schema.ts";
import { ArtDirection, Asset, ConceptSheet, FileRef, Preview, type CharacterAsset } from "./asset.ts";
import { Clip, ClipMarker } from "./clip.ts";
import { objectUses } from "./objects.ts";
import { Part, Rig } from "./rig.ts";
import { undress } from "./worldOperations.ts";

/**
 * Art operations: same contract as ../operations.ts (pure, untrusted input,
 * whole-project validation on success). Kept separate so the art system can
 * grow without touching gameplay operations. Imports from ../operations.ts
 * are type-only to avoid a module cycle.
 */

type Fail = { ok: false; error: OperationError };

function fail(code: OperationError["code"], message: string, issues: OperationError["issues"] = []): Fail {
  return { ok: false, error: { code, message, issues } };
}

const issuesOf = (error: z.ZodError, prefix = "") =>
  error.issues.map((i) => ({ path: prefix + i.path.join("."), message: i.message }));

function parse<T extends z.ZodType>(schema: T, input: unknown, op: string): { ok: true; data: z.infer<T> } | Fail {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, data: parsed.data } : fail("invalid_input", `${op} input is malformed`, issuesOf(parsed.error));
}

function commit(next: ProjectSpec): OperationResult {
  const parsed = ProjectSpec.safeParse({ ...next, revision: next.revision + 1 });
  if (!parsed.success) return fail("invalid_result", "operation would leave the project invalid", issuesOf(parsed.error));
  return { ok: true, project: parsed.data };
}

const list = (ids: string[]) => (ids.length > 0 ? ` (known: ${ids.join(", ")})` : " (none exist)");

function findAsset(project: ProjectSpec, assetId: string): { ok: true; index: number; asset: Asset } | Fail {
  const index = project.art.assets.findIndex((a) => a.id === assetId);
  const asset = project.art.assets[index];
  if (!asset) return fail("not_found", `no asset with id "${assetId}"${list(project.art.assets.map((a) => a.id))}`);
  return { ok: true, index, asset };
}

function findCharacterAsset(project: ProjectSpec, assetId: string): { ok: true; index: number; asset: CharacterAsset } | Fail {
  const found = findAsset(project, assetId);
  if (!found.ok) return found;
  if (found.asset.kind !== "character") return fail("invalid_input", `asset "${assetId}" is a ${found.asset.kind}, not a character`);
  return { ok: true, index: found.index, asset: found.asset };
}

function replaceAsset(project: ProjectSpec, index: number, candidate: unknown, what: string): OperationResult {
  const parsed = Asset.safeParse(candidate);
  if (!parsed.success) return fail("invalid_input", `${what} would be invalid`, issuesOf(parsed.error));
  const assets = project.art.assets.slice();
  assets[index] = parsed.data;
  return commit({ ...project, art: { ...project.art, assets } });
}

// --- direction ---------------------------------------------------------------

export const SetArtDirectionInput = z.strictObject({
  changes: z.strictObject({
    style: z.string().optional(),
    palette: z.array(Color).optional(),
    ink: z.string().optional(),
    inkWidth: z.number().optional(),
    boil: z.number().optional(),
    rigMode: z.enum(["vector", "cutout", "traced"]).optional().describe("How characters are rigged: vector (flat shapes), cutout (pieces of the concept image) or traced (those pieces redrawn as flat shapes)."),
  }),
});

/** Change the project-wide art direction (applies to future generations and to how rigs are drawn). */
export function setArtDirection(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetArtDirectionInput, input, "setArtDirection");
  if (!p.ok) return p;
  const direction = ArtDirection.safeParse({ ...project.art.direction, ...p.data.changes });
  if (!direction.success) return fail("invalid_input", "art direction would be invalid", issuesOf(direction.error, "changes."));
  return commit({ ...project, art: { ...project.art, direction: direction.data } });
}

// --- assets ------------------------------------------------------------------

export const CreateAssetInput = z.strictObject({
  asset: z.strictObject({
    id: Id,
    name: z.string(),
    kind: z.enum(["character", "biome"]),
    subject: z.enum(["character", "object"]).optional(),
    brief: z.string(),
  }),
  assignTo: Id.optional().describe("Character id to draw with this asset right away."),
});

/** Add an empty asset (no concepts yet), optionally assigning it to a character. */
export function createAsset(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(CreateAssetInput, input, "createAsset");
  if (!p.ok) return p;
  const { asset, assignTo } = p.data;
  if (project.art.assets.some((a) => a.id === asset.id)) return fail("invalid_input", `an asset with id "${asset.id}" already exists`);
  const parsed = Asset.safeParse(asset);
  if (!parsed.success) return fail("invalid_input", "asset is invalid", issuesOf(parsed.error, "asset."));
  let characters = project.characters;
  if (assignTo !== undefined) {
    if (!characters.some((c) => c.id === assignTo)) {
      return fail("not_found", `no character with id "${assignTo}"${list(characters.map((c) => c.id))}`);
    }
    characters = characters.map((c) => (drawnAs(c, assignTo) ? { ...c, appearance: asset.id } : c));
  }
  return commit({ ...project, characters, art: { ...project.art, assets: [...project.art.assets, parsed.data] } });
}

export const UpdateAssetInput = z.strictObject({
  assetId: Id,
  changes: z.strictObject({ name: z.string().optional(), brief: z.string().optional() }),
});

export function updateAsset(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdateAssetInput, input, "updateAsset");
  if (!p.ok) return p;
  const found = findAsset(project, p.data.assetId);
  if (!found.ok) return found;
  return replaceAsset(project, found.index, { ...found.asset, ...p.data.changes }, `asset "${p.data.assetId}"`);
}

export const AssetRef = z.strictObject({ assetId: Id });

/** Delete an asset; characters drawn with it go back to colored boxes. */
export function deleteAsset(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AssetRef, input, "deleteAsset");
  if (!p.ok) return p;
  const found = findAsset(project, p.data.assetId);
  if (!found.ok) return found;
  const uses = objectUses(project).filter((u) => u.object === p.data.assetId);
  if (uses.length > 0) return fail("invalid_input", `object "${p.data.assetId}" is still used by ${[...new Set(uses.map((u) => u.what))].join(", ")}; change those first`);
  const characters = project.characters.map((c) => {
    if (c.appearance !== p.data.assetId) return c;
    const { appearance: _removed, ...rest } = c;
    return rest;
  });
  return commit({
    ...project,
    characters,
    world: undress(project.world, (d) => d.biome === p.data.assetId),
    art: { ...project.art, assets: project.art.assets.filter((a) => a.id !== p.data.assetId) },
  });
}

export const AssignAppearanceInput = z.strictObject({
  characterId: Id,
  assetId: Id.nullable().describe("Character asset to draw it with; null = back to a colored box."),
});

export function assignAppearance(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AssignAppearanceInput, input, "assignAppearance");
  if (!p.ok) return p;
  const { characterId, assetId } = p.data;
  const index = project.characters.findIndex((c) => c.id === characterId);
  const character = project.characters[index];
  if (!character) return fail("not_found", `no character with id "${characterId}"${list(project.characters.map((c) => c.id))}`);
  if (assetId !== null) {
    const found = findCharacterAsset(project, assetId);
    if (!found.ok) return found;
  }
  const characters = project.characters.map((c) => {
    if (!drawnAs(c, characterId)) return c;
    const { appearance: _old, ...rest } = c;
    return assetId === null ? rest : { ...rest, appearance: assetId };
  });
  return commit({ ...project, characters });
}

/** The character itself, or one of its variants (variantOf): variants are drawn like their original. */
const drawnAs = (c: ProjectSpec["characters"][number], characterId: string) => c.id === characterId || (c.kind === "enemy" && c.variantOf === characterId);

// --- concept stage -----------------------------------------------------------

export const AddConceptInput = z.strictObject({ assetId: Id, concept: z.unknown() });

/** Record a generated concept sheet (the image is already in the asset store). */
export function addConcept(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AddConceptInput, input, "addConcept");
  if (!p.ok) return p;
  const found = findAsset(project, p.data.assetId);
  if (!found.ok) return found;
  const concept = ConceptSheet.safeParse(p.data.concept);
  if (!concept.success) return fail("invalid_input", "concept is invalid", issuesOf(concept.error, "concept."));
  return replaceAsset(
    project,
    found.index,
    { ...found.asset, concepts: [...found.asset.concepts, concept.data] },
    `asset "${p.data.assetId}"`,
  );
}

export const ChooseConceptInput = z.strictObject({
  assetId: Id,
  sheet: z.number().int().min(0).describe("Index into the asset's concept sheets."),
  cell: z.number().int().min(0).max(3).describe("Design in the 2x2 sheet, reading order (0 top-left, 3 bottom-right)."),
  file: FileRef.describe("The cropped cell image."),
  original: FileRef.optional().describe("The design as drawn, when `file` is a redraw of it."),
});

/** Pick the design the rig will be built from. */
export function chooseConcept(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ChooseConceptInput, input, "chooseConcept");
  if (!p.ok) return p;
  const { assetId, sheet, cell, file, original } = p.data;
  const found = findAsset(project, assetId);
  if (!found.ok) return found;
  if (!found.asset.concepts[sheet]) {
    return fail("not_found", `asset "${assetId}" has ${found.asset.concepts.length} concept sheet(s); no sheet ${sheet}`);
  }
  return replaceAsset(project, found.index, { ...found.asset, chosen: { sheet, cell, file, ...(original ? { original } : {}) } }, `asset "${assetId}"`);
}

// --- rig stage ---------------------------------------------------------------

export const SetRigInput = z.strictObject({
  assetId: Id,
  rig: z.unknown().describe("The whole rig."),
  preview: Preview.nullable().optional().describe("A render of it (set by the pipeline)."),
});

/** Replace a character asset's rig. Clips that refer to missing bones are kept (lint warns; the runtime ignores them). */
export function setRig(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetRigInput, input, "setRig");
  if (!p.ok) return p;
  const found = findCharacterAsset(project, p.data.assetId);
  if (!found.ok) return found;
  const rig = Rig.safeParse(p.data.rig);
  if (!rig.success) return fail("invalid_input", "rig is invalid", issuesOf(rig.error, "rig."));
  const next = {
    ...found.asset,
    rig: rig.data,
    ...(p.data.preview !== undefined && { preview: p.data.preview }),
    // What it was built from: the design chosen now (a redraw saved in the same batch is chosen by then).
    ...(found.asset.chosen ? { rigFrom: found.asset.chosen.file } : {}),
  };
  return replaceAsset(project, found.index, next, `asset "${p.data.assetId}"`);
}

export const UpdatePartInput = z.strictObject({
  assetId: Id,
  partId: Id,
  changes: z
    .record(z.string(), z.unknown())
    .describe("Part fields to replace, e.g. {\"fill\": \"#aa3322\"} or {\"z\": 5}. `shape` replaces the whole shape."),
});

/** Targeted edit of one rig part (color, draw order, outline, shape). */
export function updatePart(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdatePartInput, input, "updatePart");
  if (!p.ok) return p;
  const { assetId, partId, changes } = p.data;
  const found = findCharacterAsset(project, assetId);
  if (!found.ok) return found;
  const rig = found.asset.rig;
  if (!rig) return fail("not_found", `asset "${assetId}" has no rig yet`);
  const index = rig.parts.findIndex((part) => part.id === partId);
  if (index < 0) return fail("not_found", `rig of "${assetId}" has no part "${partId}"${list(rig.parts.map((part) => part.id))}`);
  const part = Part.safeParse({ ...rig.parts[index], ...changes, id: partId });
  if (!part.success) return fail("invalid_input", `part "${partId}" would be invalid`, issuesOf(part.error, "changes."));
  const parts = rig.parts.slice();
  parts[index] = part.data;
  const checked = Rig.safeParse({ ...rig, parts });
  if (!checked.success) return fail("invalid_input", "rig would be invalid", issuesOf(checked.error));
  return replaceAsset(project, found.index, { ...found.asset, rig: checked.data }, `asset "${assetId}"`);
}

// --- animation stage ---------------------------------------------------------

export const SetClipInput = z.strictObject({
  assetId: Id,
  clipId: Id.describe("Clip name; use a slot name (idle, walk, run, windup, attack, hurt, jump, fall, fly) to have it used automatically."),
  clip: z.unknown().nullable().describe("The clip; null deletes it."),
  preview: FileRef.nullable().optional().describe("Filmstrip render (set by the pipeline)."),
});

export function setClip(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetClipInput, input, "setClip");
  if (!p.ok) return p;
  const { assetId, clipId, preview } = p.data;
  const found = findCharacterAsset(project, assetId);
  if (!found.ok) return found;
  const clips = { ...found.asset.clips };
  const clipPreviews = { ...found.asset.clipPreviews };
  if (p.data.clip === null) {
    if (!clips[clipId]) return fail("not_found", `asset "${assetId}" has no clip "${clipId}"${list(Object.keys(clips))}`);
    delete clips[clipId];
    delete clipPreviews[clipId];
  } else {
    const clip = Clip.safeParse(p.data.clip);
    if (!clip.success) return fail("invalid_input", `clip "${clipId}" is invalid`, issuesOf(clip.error, "clip."));
    clips[clipId] = clip.data;
    if (preview === null) delete clipPreviews[clipId];
    else if (preview !== undefined) clipPreviews[clipId] = preview;
  }
  const stateClips = Object.fromEntries(Object.entries(found.asset.stateClips).filter(([, c]) => clips[c] !== undefined));
  // Writing a clip records the rig it was written for (artStaleness).
  const clipsFor = p.data.clip !== null && found.asset.rig ? rigFingerprint(found.asset.rig) : found.asset.clipsFor;
  return replaceAsset(project, found.index, { ...found.asset, clips, clipPreviews, stateClips, ...(clipsFor ? { clipsFor } : {}) }, `asset "${assetId}"`);
}

export const SetStateClipInput = z.strictObject({
  assetId: Id,
  stateId: Id.describe("Behavior state id of a character drawn with this asset."),
  clipId: Id.nullable().describe("Clip to play in that state; null = use the automatic slot."),
});

export function setStateClip(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetStateClipInput, input, "setStateClip");
  if (!p.ok) return p;
  const { assetId, stateId, clipId } = p.data;
  const found = findCharacterAsset(project, assetId);
  if (!found.ok) return found;
  const stateClips = { ...found.asset.stateClips };
  if (clipId === null) delete stateClips[stateId];
  else {
    if (!found.asset.clips[clipId]) {
      return fail("not_found", `asset "${assetId}" has no clip "${clipId}"${list(Object.keys(found.asset.clips))}`);
    }
    stateClips[stateId] = clipId;
  }
  return replaceAsset(project, found.index, { ...found.asset, stateClips }, `asset "${assetId}"`);
}

// --- objects ---------------------------------------------------------------

export const CreateObjectInput = z.strictObject({
  id: Id,
  name: z.string().min(1).max(80),
  brief: z.string().max(2000).describe("What it is and looks like, in plain words (a rusted floor lever; a crackling shockwave ring)."),
});

/** Add an object asset (subject object): a rigged, animated thing props, effects and projectiles draw with. Drawn by its art job. */
export function createObject(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(CreateObjectInput, input, "createObject");
  if (!p.ok) return p;
  return createAsset(project, { asset: { id: p.data.id, name: p.data.name, kind: "character", subject: "object", brief: p.data.brief } });
}

export const SetClipMarkersInput = z.strictObject({
  assetId: Id,
  clipId: Id,
  markers: z.array(ClipMarker).max(16).describe("Replaces the clip's markers (normalized time 0..1)."),
});

/** Set a clip's markers (named moments that fire marker events in play). */
export function setClipMarkers(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetClipMarkersInput, input, "setClipMarkers");
  if (!p.ok) return p;
  const { assetId, clipId } = p.data;
  const found = findCharacterAsset(project, assetId);
  if (!found.ok) return found;
  const clip = found.asset.clips[clipId];
  if (!clip) return fail("not_found", `asset "${assetId}" has no clip "${clipId}"${list(Object.keys(found.asset.clips))}`);
  const markers = [...p.data.markers].sort((a, b) => a.t - b.t);
  return replaceAsset(project, found.index, { ...found.asset, clips: { ...found.asset.clips, [clipId]: { ...clip, markers } } }, `asset "${assetId}"`);
}

export const artOperations = {
  setArtDirection,
  createAsset,
  updateAsset,
  deleteAsset,
  assignAppearance,
  addConcept,
  chooseConcept,
  setRig,
  updatePart,
  setClip,
  setStateClip,
  createObject,
  setClipMarkers,
} satisfies Record<string, (project: ProjectSpec, input: unknown) => OperationResult>;
