import { z } from "zod";
import { Color, Id } from "../common.ts";
import { FileRef } from "./fileRef.ts";

/**
 * World art (prototype): a *biome kit* (one painted backdrop, sliced piece
 * sheets, a ground texture) plus a *scene*: how one room uses the kit. The
 * kit is paid for once per biome; rooms are pure data, so composing more
 * of them costs only a cheap text call (or nothing, if a generator lays
 * them out). Depth comes from parallax layers, fog between them, lights,
 * light shafts and dust, all drawn by the runtime for free.
 *
 * Not part of ProjectSpec yet: this is the proof of concept for worlds.
 */

/** Parallax layers, back to front. The runtime owns the scroll factors. */
export const WORLD_LAYERS = {
  far: "Painted backdrop (scrolls slowest).",
  mid: "Big distant structures, tinted toward the fog.",
  back: "Decor just behind the play layer.",
  play: "Where the characters walk (no parallax).",
  front: "Dark silhouettes in front of everything (scrolls fastest).",
} as const;
export const WorldLayer = z.enum(["far", "mid", "back", "play", "front"]);
export type WorldLayer = z.infer<typeof WorldLayer>;

export const PieceKind = z.enum(["structure", "decor", "light", "hanging", "span"]);

/** One sliced image from a kit sheet. */
export const WorldPiece = z.strictObject({
  id: Id,
  file: FileRef,
  name: z.string().max(80),
  kind: PieceKind.describe(
    "structure: big architecture; decor: small things on the ground; light: emits light; hanging: hangs from the ceiling; span: wide and flat (beam, lintel, log, bridge), rests across two supports.",
  ),
  /** Image size in px. */
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  /** Typical on-screen height in world px at scale 1. */
  size: z.number().min(8).max(1200),
  /** Light color for kind "light" (and glowing decor). */
  glow: Color.optional(),
});
export type WorldPiece = z.infer<typeof WorldPiece>;

const X = z.number().min(-2000).max(20_000);
const Y = z.number().min(-2000).max(4000);

export const WorldScene = z.strictObject({
  name: z.string().max(120),
  width: z.number().min(960).max(20_000),
  height: z.number().min(360).max(4000),
  backdrop: FileRef,
  ground: FileRef,
  pieces: z.array(WorldPiece).max(64),
  palette: z.strictObject({
    ambient: Color.describe("Darkness tint for the whole scene (lights add on top)."),
    fog: Color,
    light: Color.describe("Default warm light color."),
    shadow: Color.describe("Silhouette color for the front layer."),
  }),
  platforms: z
    .array(z.strictObject({ x: X, y: Y, width: z.number().min(8).max(20_000), height: z.number().min(8).max(4000) }))
    .max(64),
  placements: z
    .array(
      z.strictObject({
        /** Stable id for editing (rooms assign them). */
        id: Id.optional(),
        piece: Id,
        layer: WorldLayer,
        /** Room x the piece is seen at (its centre). */
        x: X,
        /** Bottom of the piece (top for hanging pieces), room y. */
        y: Y,
        scale: z.number().min(0.1).max(6).default(1),
        flip: z.boolean().default(false),
      }),
    )
    .max(200),
  lights: z
    .array(
      z.strictObject({
        x: X,
        y: Y,
        color: Color,
        energy: z.number().min(0).max(4).default(1),
        radius: z.number().min(16).max(2000).default(220),
      }),
    )
    .max(64),
  /** Fog density behind each layer (0 = clear, 1 = opaque). */
  fog: z.strictObject({ mid: z.number().min(0).max(1), back: z.number().min(0).max(1), play: z.number().min(0).max(1) }),
  rays: z
    .array(z.strictObject({ x: X, width: z.number().min(10).max(2000), angle: z.number().min(-60).max(60), alpha: z.number().min(0).max(1) }))
    .max(16),
  dust: z.strictObject({ color: Color, amount: z.number().int().min(0).max(400) }),
});
export type WorldScene = z.infer<typeof WorldScene>;

export const PlatformRect = z.strictObject({ x: X, y: Y, width: z.number().min(8).max(20_000), height: z.number().min(8).max(4000) });
export type PlatformRect = z.infer<typeof PlatformRect>;

/** A biome's paid-for images: a seamless backdrop, a ground texture and sliced pieces. */
export const BiomeKit = z.strictObject({
  backdrop: FileRef,
  ground: FileRef,
  pieces: z.array(WorldPiece).max(64),
  /** draft: cheapest images; final: better piece sheets. */
  quality: z.enum(["draft", "final"]).default("draft"),
});
export type BiomeKit = z.infer<typeof BiomeKit>;

/** How a room uses its biome's kit: everything except the layout, kit and size. */
export const RoomComposition = WorldScene.pick({ palette: true, placements: true, lights: true, fog: true, rays: true, dust: true });
export type RoomComposition = z.infer<typeof RoomComposition>;

/**
 * One composed room. It dresses the arena's layout; `layout` is a suggested
 * platform layout (from "suggest layout") that the creator can accept.
 */
export const Room = z.strictObject({
  id: Id,
  name: z.string().min(1).max(80),
  composition: RoomComposition,
  layout: z.array(PlatformRect).max(64).nullable().default(null),
  /** USD spent composing it. */
  cost: z.number().min(0).default(0),
  at: z.string(),
});
export type Room = z.infer<typeof Room>;

/** The arena dressed with a biome room. */
export const Dressing = z.strictObject({ biome: Id, room: Id });
export type Dressing = z.infer<typeof Dressing>;
