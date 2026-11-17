import { z } from "zod";
import { Color, Id } from "../common.ts";
import { Clip } from "./clip.ts";
import { Rig, RIG_MODES } from "./rig.ts";
import { FileRef } from "./fileRef.ts";
import { BiomeKit, Room } from "./world.ts";

/**
 * Assets: everything visual the AI makes. Every asset kind shares the
 * concept stage (cheap raster sketches, for inspiration only) and differs in
 * its *representation*: the data the runtime actually draws.
 *
 *   character -> rig + clips    (v1)
 *   later: prop (rig or raster), tile (raster tileset), background (raster
 *   parallax layers), biome kit (pieces + tiles + layers)
 *
 * Binary files (concept images, preview renders) live next to the project
 * under content-hash names and are referenced by FileRef; the project spec
 * stays small JSON.
 */

export { FileRef };

/** One generated concept sheet: a 2x2 grid of design variations. */
export const ConceptSheet = z.strictObject({
  file: FileRef,
  prompt: z.string().max(4000),
  model: z.string().max(200),
  /** USD, as reported by the provider. */
  cost: z.number().min(0),
  at: z.string(),
  /** What the creator asked for when requesting this round, if anything. */
  feedback: z.string().max(1000).optional(),
  /** Index (0-3, reading order) the AI recommends, with its reason. */
  recommended: z.strictObject({ cell: z.number().int().min(0).max(3), reason: z.string().max(500) }).optional(),
});
export type ConceptSheet = z.infer<typeof ConceptSheet>;

/** The chosen concept: one cell of a sheet, cropped to its own file. */
export const ConceptChoice = z.strictObject({
  sheet: z.number().int().min(0),
  cell: z.number().int().min(0).max(3),
  file: FileRef,
});

/** A preview render of the current representation, with the AI's assessment. */
export const Preview = z.strictObject({
  file: FileRef,
  /** 0-10 likeness/quality score from the critic, if one ran. */
  score: z.number().min(0).max(10).optional(),
  notes: z.string().max(2000).optional(),
  /**
   * How the rig sits on the chosen design: rig = (design px - anchor) * scale.
   * Lets the studio draw the design behind the rig, exactly aligned (onion skin).
   */
  frame: z.strictObject({ scale: z.number().positive(), anchor: z.tuple([z.number(), z.number()]) }).optional(),
  /**
   * Measured likeness to the chosen concept (0-1, higher is better): how much the rest-pose
   * silhouettes overlap (intersection over union) and how close the colors are where they do.
   */
  match: z.strictObject({ silhouette: z.number().min(0).max(1), color: z.number().min(0).max(1) }).optional(),
});

const assetBase = {
  id: Id,
  name: z.string().min(1).max(80),
  brief: z.string().max(2000).describe("What it should look like, in plain words. Drives concept prompts."),
  concepts: z.array(ConceptSheet).max(40).default([]),
  chosen: ConceptChoice.nullable().default(null),
};

export const CharacterAsset = z.strictObject({
  ...assetBase,
  kind: z.literal("character"),
  rig: Rig.nullable().default(null),
  /** Rest-pose render of the rig. */
  preview: Preview.nullable().default(null),
  clips: z.record(Id, Clip).default({}).describe("Animation clips by name; slot names (idle, walk...) are used automatically."),
  /** Filmstrip renders of the clips, by clip name. */
  clipPreviews: z.record(Id, FileRef).default({}),
  stateClips: z
    .record(Id, Id)
    .default({})
    .describe("Behavior state id -> clip name, overriding the automatic slot for that state."),
});
export type CharacterAsset = z.infer<typeof CharacterAsset>;

/**
 * A biome: one place's art kit (backdrop, piece sheets, ground) and the rooms
 * composed from it. `brief` is the theme. Rooms dress world rooms' tiles.
 */
export const BiomeAsset = z.strictObject({
  ...assetBase,
  kind: z.literal("biome"),
  kit: BiomeKit.nullable().default(null),
  rooms: z.array(Room).max(32).default([]),
});
export type BiomeAsset = z.infer<typeof BiomeAsset>;

export const Asset = z.discriminatedUnion("kind", [CharacterAsset, BiomeAsset]);
export type Asset = z.infer<typeof Asset>;
export type AssetKind = Asset["kind"];

/** Project-wide look, shared by every asset so they match. */
export const ArtDirection = z.strictObject({
  style: z
    .string()
    .max(1500)
    .describe("The look in plain words: line, shape language, color, mood. Describe traits; don't name other games."),
  palette: z.array(Color).max(16).describe("Preferred colors."),
  ink: Color.describe("Outline color."),
  inkWidth: z.number().min(0).max(12).describe("Base outline width in px."),
  boil: z.number().min(0).max(1).describe("Hand-drawn line wobble, 0 = none (re-drawn ~8 times a second)."),
  rigMode: z.enum(RIG_MODES).optional().describe("How characters are rigged: vector (flat shapes, default) or cutout (pieces of the concept image)."),
});
export type ArtDirection = z.infer<typeof ArtDirection>;

export function defaultArtDirection(): ArtDirection {
  return {
    style:
      "Hand-drawn 2D game art. Bold, readable silhouettes built from simple shapes; thick dark ink outlines; " +
      "flat muted, desaturated colors with a single bright accent (glowing eyes, a lantern); pale masks against dark bodies. " +
      "Melancholy, gloomy underground insect-kingdom mood. Minimal interior detail; charm comes from shape and proportion.",
    palette: ["#e8e3d3", "#2a2a33", "#4a5470", "#6b7f8c", "#8a6f5a", "#5f6b4e", "#b8c4c8", "#ffd27a"],
    ink: "#15151c",
    inkWidth: 1.6,
    boil: 0.35,
  };
}

export const ArtSection = z.strictObject({
  direction: ArtDirection,
  assets: z.array(Asset).max(500),
});
export type ArtSection = z.infer<typeof ArtSection>;

export function defaultArtSection(): ArtSection {
  return { direction: defaultArtDirection(), assets: [] };
}
