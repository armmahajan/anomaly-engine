import { rigFingerprint } from "./rig.ts";
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
  /** The design as drawn, when `file` is a redraw of it (the flat redraw a vector rig is built from): the finish looks to it. */
  original: FileRef.optional(),
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
  subject: z
    .enum(["character", "object"])
    .default("character")
    .describe("character: drawn for a game character (appearance). object: an animated thing on its own (a lever, a trap, an effect, a projectile) that props, effects and projectiles use."),
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
  /** The design the rig was built from (setRig records the chosen design's file): choosing another makes the rig out of date. */
  rigFrom: FileRef.optional(),
  /** The rig the clips were written for (setClip records rigFingerprint): rebuilding or editing the bones makes them out of date. */
  clipsFor: z.string().max(64).optional(),
});
export type CharacterAsset = z.infer<typeof CharacterAsset>;

/**
 * Which later steps of a character's art no longer match an earlier one: a rig built from a design
 * that is no longer the chosen one, clips written for a rig whose bones have changed since. Assets
 * from before these were recorded count as up to date.
 */
export function artStaleness(asset: Pick<CharacterAsset, "chosen" | "rig" | "rigFrom" | "clips" | "clipsFor">): { rigStale: boolean; clipsStale: boolean } {
  const rigStale = Boolean(asset.rig && asset.rigFrom && asset.chosen && asset.rigFrom !== asset.chosen.file);
  const clipsStale = Boolean(asset.rig && asset.clipsFor && Object.keys(asset.clips).length > 0 && asset.clipsFor !== rigFingerprint(asset.rig));
  return { rigStale, clipsStale };
}

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

/** An object asset: a rigged, animated thing that isn't a game character (props, effects, projectiles draw with it). */
export const isObjectAsset = (asset: { kind: string; subject?: string } | undefined): asset is CharacterAsset => asset?.kind === "character" && asset.subject === "object";
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
  rigMode: z.enum(RIG_MODES).optional().describe("How characters are rigged: cutout (pieces of the concept image, default) or vector (flat shapes)."),
  conceptModel: z.string().max(120).optional().describe("Image model for concept sheets (one the studio offers, ArtState.models.concept); unset = the studio's default."),
});
export type ArtDirection = z.infer<typeof ArtDirection>;

/**
 * The starting look: how the art is made, never what it shows. No setting,
 * creatures or mood: those come from the creator's design (the art direction
 * step writes a direction from the wiki while a default is in place).
 */
export function defaultArtDirection(): ArtDirection {
  return {
    style:
      "Hand-drawn 2D game art. Bold, readable silhouettes built from simple shapes; clean, consistent outlines; " +
      "flat color with soft shading and a clear value contrast between foreground and background. " +
      "Minimal interior detail; character comes from shape and proportion.",
    palette: ["#f2efe6", "#26262b", "#5b6170", "#8c95a3", "#a8826a", "#6f8a6a", "#c9ccd1", "#e0a95a"],
    ink: "#1b1b20",
    inkWidth: 1.6,
    boil: 0.35,
  };
}

/** Default styles of earlier versions: stored projects keep them, and they still count as "not chosen yet". */
export const LEGACY_DEFAULT_STYLES: readonly string[] = [
  "Hand-drawn 2D game art. Bold, readable silhouettes built from simple shapes; thick dark ink outlines; " +
    "flat muted, desaturated colors with a single bright accent (glowing eyes, a lantern); pale masks against dark bodies. " +
    "Melancholy, gloomy underground insect-kingdom mood. Minimal interior detail; charm comes from shape and proportion.",
];

/** True while the style is a default (today's or an earlier one): nobody has chosen the look yet. */
export function isDefaultArtDirection(direction: Pick<ArtDirection, "style">): boolean {
  const style = direction.style.trim();
  return style === defaultArtDirection().style || LEGACY_DEFAULT_STYLES.includes(style);
}

export const ArtSection = z.strictObject({
  direction: ArtDirection,
  assets: z.array(Asset).max(500),
});
export type ArtSection = z.infer<typeof ArtSection>;

export function defaultArtSection(): ArtSection {
  return { direction: defaultArtDirection(), assets: [] };
}
