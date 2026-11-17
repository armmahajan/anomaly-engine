import { describe, expect, it } from "vitest";
import {
  BiomeKit,
  checkPlaneScales,
  createDefaultProject,
  MAX_SHARP_UPSCALE,
  PAINTED_LANDSCAPE,
  PLANE_RECIPE,
  planeScreenScale,
  ProjectSpec,
  REFERENCE_SCREEN,
  applyOperation,
  DEFAULT_VIEW_ROWS,
  kitFiles,
  type BackgroundPlane,
} from "@anomaly/core";

// Background planes are drawn across the view, so on screen they are `span` of the screen's
// height whatever the room or zoom. On the biggest screen we draw for (1512x945 CSS at DPR 2,
// fullscreen: 3024x1890 physical px), a painted image must not be enlarged past
// MAX_SHARP_UPSCALE unless it is blurred enough that the enlargement reads as distance.

/** The planes a new kit paints, at the size the image model paints them. */
const painted: BackgroundPlane[] = PLANE_RECIPE.map(({ transparent: _t, prompt: _p, ...plane }) => ({
  ...plane,
  file: `${plane.name}.png`,
  // tileableX keeps the height and trims ~18% of the width
  width: Math.round(PAINTED_LANDSCAPE.width * 0.82),
  height: PAINTED_LANDSCAPE.height,
}));

describe("background planes on a 3024x1890 screen", () => {
  it("each layer's effective on-screen scale", () => {
    const scales = Object.fromEntries(painted.map((p) => [p.name, +planeScreenScale(p, REFERENCE_SCREEN.height).toFixed(2)]));
    // sky: 1.12 * 1890 / 1024; far: 0.85 * ...; near: 0.58 * ...
    expect(scales).toEqual({ sky: 2.07, far: 1.57, near: 1.07 });
  });

  it("no sharp layer is upscaled beyond ~1.25x; enlarged ones are blurred for it", () => {
    for (const check of checkPlaneScales(painted, REFERENCE_SCREEN.height)) {
      if (check.sharp) expect(check.scale, `${check.name} is sharp`).toBeLessThanOrEqual(MAX_SHARP_UPSCALE);
      else expect(painted.find((p) => p.name === check.name)!.blur, `${check.name} blur`).toBeGreaterThanOrEqual(check.blurNeeded);
      expect(check.ok).toBe(true);
    }
    expect(checkPlaneScales(painted).filter((c) => c.sharp).map((c) => c.name)).toEqual(["near"]);
  });

  it("distant layers are blurred and hazed by depth", () => {
    const byDepth = [...painted].sort((a, b) => a.depth - b.depth);
    expect(byDepth.map((p) => p.name)).toEqual(["sky", "far", "near"]);
    // nearer = sharper and clearer (the sky is a soft gradient, hazed only a little)
    expect(byDepth[1]!.blur).toBeGreaterThan(byDepth[2]!.blur);
    expect(byDepth[1]!.haze).toBeGreaterThan(byDepth[2]!.haze);
    expect(byDepth[0]!.blur).toBeGreaterThan(byDepth[1]!.blur);
  });

  it("flags a sharp plane that would be enlarged too much (e.g. a smaller image)", () => {
    const small = { ...painted[2]!, height: 512 };
    expect(checkPlaneScales([small])[0]).toMatchObject({ sharp: true, ok: false });
    expect(checkPlaneScales([{ ...small, blur: 3 }])[0]).toMatchObject({ sharp: false, ok: true });
  });
});

describe("kits and the camera setting", () => {
  it("old single-backdrop kits still parse, without planes", () => {
    const ref = (c: string) => `${c.repeat(16)}.png`;
    const old = BiomeKit.parse({ backdrop: ref("b"), ground: ref("c"), pieces: [] });
    expect(old.backgrounds).toBeUndefined();
    expect(kitFiles(old)).toEqual([ref("b"), ref("c")]);
    const layered = BiomeKit.parse({ backdrop: ref("1"), backgrounds: painted.map((p, i) => ({ ...p, file: ref(String(i + 1)) })), atmosphere: { particles: "embers" }, ground: ref("c"), pieces: [] });
    expect(kitFiles(layered)).toEqual([ref("1"), ref("2"), ref("3"), ref("c")]);
  });

  it("the view is 14 tiles tall by default; setCamera changes it", () => {
    const project = createDefaultProject();
    expect(project.world.camera.rows).toBe(DEFAULT_VIEW_ROWS);
    const stored = ProjectSpec.parse({ ...project, world: { ...project.world, camera: undefined } });
    expect(stored.world.camera.rows).toBe(14);
    const changed = applyOperation(project, "setCamera", { rows: 10 });
    expect(changed.ok && changed.project.world.camera.rows).toBe(10);
    expect(applyOperation(project, "setCamera", { rows: 3 }).ok).toBe(false);
    expect(applyOperation(project, "setCamera", {}).ok).toBe(false);
  });
});
