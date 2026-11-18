import type { BackgroundPlane } from "./world.ts";

/**
 * How background planes come out on screen. Planes are drawn across the view
 * (world_view.gd `_update_planes`), so their on-screen size depends only on
 * the screen, never on the room or the zoom: a plane spanning `span` of the
 * view's height is `span * screenHeight` physical pixels tall.
 *
 * A painted image enlarged past its own pixels looks soft at best and
 * pixelated at worst. Near planes are kept small enough to stay sharp; far
 * ones are blurred and hazed by depth, so their enlargement reads as distance.
 */

/** The largest screen we draw for: a 1512x945 CSS window at DPR 2 (a fullscreen MacBook). */
export const REFERENCE_SCREEN = { width: 3024, height: 1890 } as const;

/** A sharp (unblurred) plane may be enlarged at most this much on the reference screen. */
export const MAX_SHARP_UPSCALE = 1.25;

/** Blur (image px) that makes a plane soft enough for one more 1x of enlargement past MAX_SHARP_UPSCALE. */
export const BLUR_PER_UPSCALE = 2;

/** Below this blur (image px) a plane counts as sharp. */
export const SHARP_BLUR = 0.5;

/** Size of a painted landscape image (gpt-image-1-mini 3:2), before it is made tileable (narrower). */
export const PAINTED_LANDSCAPE = { width: 1536, height: 1024 } as const;

/** Physical screen px per image px for a plane on a screen `screenHeight` physical px tall. */
export function planeScreenScale(plane: Pick<BackgroundPlane, "span" | "height">, screenHeight: number = REFERENCE_SCREEN.height): number {
  return (plane.span * screenHeight) / plane.height;
}

export interface PlaneScaleCheck {
  name: string;
  /** Physical px per image px. */
  scale: number;
  sharp: boolean;
  /** Blur (image px) the plane needs for its enlargement; 0 if none. */
  blurNeeded: number;
  ok: boolean;
}

/** Each plane's enlargement on a screen, and whether it is sharp enough or blurred enough for it. */
export function checkPlaneScales(planes: BackgroundPlane[], screenHeight: number = REFERENCE_SCREEN.height): PlaneScaleCheck[] {
  return planes.map((plane) => {
    const scale = planeScreenScale(plane, screenHeight);
    const sharp = plane.blur < SHARP_BLUR;
    const blurNeeded = scale <= MAX_SHARP_UPSCALE ? 0 : (scale - 1) * BLUR_PER_UPSCALE;
    return { name: plane.name, scale, sharp, blurNeeded, ok: sharp ? scale <= MAX_SHARP_UPSCALE : plane.blur >= blurNeeded };
  });
}

/** One plane of a new kit, before it is painted. */
export interface PlaneRecipe extends Omit<BackgroundPlane, "file" | "width" | "height"> {
  /** Painted with a transparent background (silhouettes over the planes behind). */
  transparent: boolean;
  /** What to paint, in plain words (the theme and art direction are added). */
  prompt: string;
}

/**
 * The planes a new biome kit paints, back to front: a hazy sky, distant
 * silhouettes and nearer ones. Fog thickens with depth (haze, mist); the far
 * two are blurred, the near one is small enough to stay sharp.
 */
export const PLANE_RECIPE: readonly PlaneRecipe[] = [
  {
    name: "sky",
    depth: 0.04,
    span: 1.12,
    opaque: true,
    blur: 3,
    haze: 0.12,
    mist: 0,
    transparent: false,
    prompt:
      "The farthest background of a 2D side-scrolling platformer, a wide panorama of nothing but the setting's sky (or whatever lies farthest away overhead there): its light, haze, clouds or glow; very low detail, smooth gradients, no strong shapes at the left or right edge. Nothing stands in it: no ground, no horizon line of land, no buildings, no plants, no objects, no lamps or light sources.",
  },
  {
    name: "far",
    depth: 0.14,
    span: 0.85,
    opaque: false,
    blur: 1.6,
    haze: 0.38,
    mist: 0.45,
    transparent: true,
    prompt:
      "A distant parallax layer of a 2D side-scrolling platformer: a wide band of far-away silhouettes of the setting's own landforms and buildings (whatever this place has) rising from the bottom edge to about two thirds of the height, solid down to the bottom edge across the whole width, flat and low contrast, faded by distance. Only landscape and architecture: no figures, no creatures, no lamps or glowing objects. Everything above them fully transparent.",
  },
  {
    name: "near",
    depth: 0.28,
    span: 0.58,
    opaque: false,
    blur: 0,
    haze: 0.16,
    mist: 0.3,
    transparent: true,
    prompt:
      "A middle-distance parallax layer of a 2D side-scrolling platformer: a wide band of nearer silhouettes of the setting's own landforms, growth and buildings (whatever this place has) rising from the bottom edge to about half of the height, solid down to the bottom edge across the whole width, with a varied skyline of gaps and peaks, darker and more detailed than the distance. Only landscape and architecture: no figures, no creatures, no lamps or glowing objects. Everything above them fully transparent.",
  },
];
