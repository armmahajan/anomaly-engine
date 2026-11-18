import { z } from "zod";
import { Color, Id } from "../common.ts";
import { FileRef } from "./fileRef.ts";

/**
 * A rig is a character drawn as data: shapes attached to bones. The runtime
 * draws it (game/scripts/art/), so the AI writes data, never code.
 *
 * Coordinates: px at game scale, rig space, origin at the character's feet
 * (bottom-centre, like spawns), x to the right, y down. The character faces
 * RIGHT (the runtime mirrors it to face left). The collision box spans
 * x in [-width/2, width/2], y in [-height, 0]; art may stick out a little.
 *
 * Everything is authored in the rest pose, in one shared coordinate frame:
 * draw the character, then say which bone moves each part and where the
 * bones pivot. Animations rotate/move/scale bones about their pivots.
 *
 * Three modes. A vector rig (default) draws flat shapes with outlines. A cutout
 * rig draws pieces of an image (`source`, the concept with its background
 * removed): each "image" part shows the source inside its polygon, so the
 * character looks exactly like its concept and still animates on bones. A
 * traced rig is a vector rig made from those pieces (flat colour shapes traced
 * from the concept); the mode only records how it was made.
 *
 * Any vector part may also carry a `texture` (an image painted inside its shape) and may be
 * clipped to another part on the same bone (`clipTo`, for detail shapes kept inside their part).
 */

const Coord = z.number().min(-1000).max(1000);
export const Point = z.tuple([Coord, Coord]).describe("[x, y] in rig space (px, y down, origin at the feet).");
export type Point = z.infer<typeof Point>;

export const Bone = z.strictObject({
  id: Id,
  parent: Id.nullable().describe("Parent bone id; null only for the root bone."),
  pivot: Point.describe("Joint position in the rest pose; the bone rotates and scales about it."),
});
export type Bone = z.infer<typeof Bone>;

const Smooth = z
  .number()
  .min(0)
  .max(1)
  .default(1)
  .describe("0 = straight segments between points, 1 = smooth curve through every point.");

export const Shape = z
  .discriminatedUnion("type", [
    z
      .strictObject({
        type: z.literal("blob"),
        points: z.array(Point).min(3).max(48).describe("Outline, in order around the shape (clockwise or not). Do not cross itself."),
        smooth: Smooth,
        sharp: z
          .array(z.number().int().min(0).max(47))
          .max(48)
          .default([])
          .describe("Indices of points kept as sharp corners (horn tips, claws, cloak hems) on a smooth blob."),
      })
      .describe("Closed filled shape through the points: bodies, heads, shells, horns, cloaks."),
    z
      .strictObject({
        type: z.literal("ellipse"),
        center: Point,
        rx: z.number().min(0.5).max(500),
        ry: z.number().min(0.5).max(500),
        rotation: z.number().min(-360).max(360).default(0).describe("Degrees, clockwise."),
      })
      .describe("Ellipse: eyes, joints, round bodies."),
    z
      .strictObject({
        type: z.literal("stroke"),
        points: z.array(Point).min(2).max(32).describe("Centre line from start to end."),
        width: z.number().min(0.5).max(80).describe("Thickness at the start, px."),
        widthEnd: z.number().min(0).max(80).optional().describe("Thickness at the end (taper); defaults to width."),
        smooth: Smooth,
      })
      .describe("Open tapered line: legs, antennae, tails, whiskers, horns, cracks and detail lines."),
    z
      .strictObject({
        type: z.literal("image"),
        points: z.array(Point).min(3).max(128).describe("Polygon (rig space) cut out of the rig's source image."),
      })
      .describe("Cutout rigs: the rig's source image shown inside this polygon (no fill or outline drawn)."),
  ])
  .describe("Geometry of a part, in rest-pose rig space.");
export type Shape = z.infer<typeof Shape>;

const Rect = z
  .tuple([z.number().min(-4096).max(4096), z.number().min(-4096).max(4096), z.number().positive().max(4096), z.number().positive().max(4096)])
  .describe("[x, y, width, height]");

/**
 * A texture painted inside a part (an image region mapped onto its shape). The image region `uv`
 * (image px) is stretched over the rest-pose rectangle `rect` (rig space) and drawn inside the
 * part's shape, over its fill and under detail parts drawn in front; it moves, turns and scales
 * with the part's bone. Transparent texture pixels show the flat fill. Many parts usually share
 * one small atlas image.
 */
export const PartTexture = z.strictObject({
  file: FileRef.describe("PNG/WebP image (usually a per-character atlas of part textures)."),
  rect: Rect.describe("Rest-pose rig-space rectangle the image region covers."),
  uv: Rect.describe("The image region, in image px."),
  opacity: z.number().min(0).max(1).default(1).describe("How strongly the texture covers the fill (1 = fully)."),
});
export type PartTexture = z.infer<typeof PartTexture>;

export const Part = z.strictObject({
  id: Id,
  bone: Id.describe("Bone that moves this part."),
  bendTo: Id.optional().describe(
    "Optional second bone: the part bends smoothly from `bone` (near its pivot) to `bendTo` (near its pivot). Use for cloaks, tails, bodies that flex.",
  ),
  z: z.number().int().min(-100).max(100).describe("Draw order; higher is in front. Far-side legs low, near-side legs high."),
  shape: Shape,
  fill: Color.describe("Fill color (line color for strokes)."),
  shade: z
    .strictObject({
      color: Color,
      angle: z.number().min(-360).max(360).default(90).describe("Direction the shade darkens toward, degrees (90 = down)."),
    })
    .optional()
    .describe("Optional gradient from `fill` to `color`, for simple form shading."),
  ink: z
    .number()
    .min(0)
    .max(3)
    .default(1)
    .describe("Outline thickness multiplier (art direction sets the base width). 0 = no outline (glows, highlights)."),
  glow: z.boolean().default(false).describe("Soft halo in the fill color: glowing eyes, lights, other glowing parts."),
  opacity: z.number().min(0).max(1).default(1),
  texture: PartTexture.optional().describe("Optional image painted inside the shape (not on image parts)."),
  clipTo: Id.optional().describe(
    "Optional: draw this part only where it overlaps that part's shape (shading bands, highlights, patterns kept inside their part). Both parts must move with the same bone(s).",
  ),
});
export type Part = z.infer<typeof Part>;

export const MAX_BONES = 24;
export const MAX_PARTS = 64;

/** A cutout rig's image: where it sits in rig space (rig = (image px - anchor) * scale). */
export const RigSource = z.strictObject({
  file: FileRef.describe("PNG with transparency (the concept, background removed)."),
  scale: z.number().positive(),
  anchor: z.tuple([z.number(), z.number()]).describe("Image px that lands on the rig origin (the feet)."),
});
export type RigSource = z.infer<typeof RigSource>;

/** Where a held weapon attaches: a point on a bone (rig space at rest), and the angle the weapon points at rest. */
export const Grip = z.strictObject({
  id: Id.describe('Usually "hand" (the near, front hand); others for a second hand or a back slot.'),
  bone: Id.describe("The bone it moves with (the forearm or hand)."),
  at: Point.describe("Where the hand closes, rig space at rest."),
  angle: z.number().min(-360).max(360).default(0).describe("Degrees the held weapon points at rest (0 = forward, 90 = down)."),
});
export type Grip = z.infer<typeof Grip>;

export const MAX_GRIPS = 4;

export const RIG_MODES = ["vector", "cutout", "traced"] as const;
export type RigMode = (typeof RIG_MODES)[number];

export const Rig = z
  .strictObject({
    /** Absent = vector. */
    mode: z.enum(RIG_MODES).optional(),
    /** Cutout rigs: the image their "image" parts show. */
    source: RigSource.optional(),
    bones: z.array(Bone).min(1).max(MAX_BONES).describe("Skeleton. Exactly one root (parent null), usually at the feet/body."),
    parts: z.array(Part).min(1).max(MAX_PARTS),
    /** Where weapons are held (absent = none yet: the runtime holds a weapon at the front of the body). */
    grips: z.array(Grip).max(MAX_GRIPS).optional(),
  })
  .superRefine((rig, ctx) => {
    const boneIds = new Set<string>();
    let roots = 0;
    rig.bones.forEach((b, i) => {
      if (boneIds.has(b.id)) ctx.addIssue({ code: "custom", path: ["bones", i, "id"], message: `duplicate bone id "${b.id}"` });
      boneIds.add(b.id);
      if (b.parent === null) roots++;
    });
    if (roots !== 1) ctx.addIssue({ code: "custom", path: ["bones"], message: `a rig needs exactly one root bone (found ${roots})` });
    rig.grips?.forEach((g, i) => {
      if (!boneIds.has(g.bone)) ctx.addIssue({ code: "custom", path: ["grips", i, "bone"], message: `grip "${g.id}" is on unknown bone "${g.bone}"` });
    });
    rig.bones.forEach((b, i) => {
      if (b.parent !== null && !boneIds.has(b.parent)) {
        ctx.addIssue({ code: "custom", path: ["bones", i, "parent"], message: `unknown parent bone "${b.parent}" (bones: ${[...boneIds].join(", ")})` });
      }
    });
    // Parents must not loop.
    const parentOf = new Map(rig.bones.map((b) => [b.id, b.parent]));
    for (const b of rig.bones) {
      const seen = new Set<string>();
      let at: string | null = b.id;
      while (at !== null && parentOf.has(at)) {
        if (seen.has(at)) {
          ctx.addIssue({ code: "custom", path: ["bones"], message: `bone "${b.id}" has a parent loop` });
          break;
        }
        seen.add(at);
        at = parentOf.get(at) ?? null;
      }
    }
    if (rig.mode === "cutout" && !rig.source) ctx.addIssue({ code: "custom", path: ["source"], message: "a cutout rig needs a source image" });
    const partIds = new Set<string>();
    rig.parts.forEach((p, i) => {
      if (p.shape.type === "image" && !rig.source) ctx.addIssue({ code: "custom", path: ["parts", i, "shape"], message: `image part "${p.id}" needs the rig's source image` });
      if (partIds.has(p.id)) ctx.addIssue({ code: "custom", path: ["parts", i, "id"], message: `duplicate part id "${p.id}"` });
      partIds.add(p.id);
      for (const key of ["bone", "bendTo"] as const) {
        const id = p[key];
        if (id !== undefined && !boneIds.has(id)) {
          ctx.addIssue({ code: "custom", path: ["parts", i, key], message: `unknown bone "${id}" (bones: ${[...boneIds].join(", ")})` });
        }
      }
      if (p.texture && p.shape.type === "image") ctx.addIssue({ code: "custom", path: ["parts", i, "texture"], message: `image part "${p.id}" can't have a texture (it shows the source)` });
      if (p.clipTo !== undefined) {
        const target = rig.parts.find((q) => q.id === p.clipTo);
        const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["parts", i, "clipTo"], message });
        if (!target) issue(`unknown part "${p.clipTo}" to clip to (parts: ${rig.parts.map((q) => q.id).join(", ")})`);
        else if (target.id === p.id) issue(`part "${p.id}" can't clip to itself`);
        else if (target.clipTo !== undefined) issue(`part "${p.id}" clips to "${target.id}", which is clipped itself: clip to "${target.clipTo}" instead`);
        else if (target.shape.type === "image") issue(`part "${p.id}" can't clip to image part "${target.id}"`);
        else if (target.bone !== p.bone || target.bendTo !== p.bendTo) issue(`part "${p.id}" clips to "${target.id}", which moves with other bones: both need the same bone and bendTo`);
      }
      if (p.shape.type === "blob") {
        const n = p.shape.points.length;
        p.shape.sharp.forEach((s, j) => {
          if (s >= n) ctx.addIssue({ code: "custom", path: ["parts", i, "shape", "sharp", j], message: `sharp index ${s} is past the last point (${n - 1})` });
        });
      }
    });
  });
export type Rig = z.infer<typeof Rig>;

/** Axis-aligned bounds of a rig's rest pose (ignores outlines and stroke width). */
/** Image files a rig draws (a cutout's source, part textures), once each. */
export function rigFiles(rig: Rig): FileRef[] {
  return [...new Set([...(rig.source ? [rig.source.file] : []), ...rig.parts.flatMap((p) => (p.texture ? [p.texture.file] : []))])];
}

export function rigBounds(rig: Rig): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = ([x, y]: readonly [number, number]) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const part of rig.parts) {
    const s = part.shape;
    if (s.type === "ellipse") {
      const r = Math.max(s.rx, s.ry);
      add([s.center[0] - r, s.center[1] - r]);
      add([s.center[0] + r, s.center[1] + r]);
    } else {
      s.points.forEach(add);
    }
  }
  return { minX, minY, maxX, maxY };
}
