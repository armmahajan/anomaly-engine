import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Clip, defaultArtDirection } from "@anomaly/core";
import { creaturePlan, cutCharacter, cutoutRig, decodePng, drawCreature, encodePng, flatten, matchScore, tracedRig } from "@anomaly/art";
import { BrowserRenderer } from "../src/art/renderer.ts";

/** Cutout rigs drawn by the real runtime (web export in headless Chromium): fidelity and joints. */

const exportDir = fileURLToPath(new URL("../../../apps/studio/public/game", import.meta.url));
const hasExport = existsSync(join(exportDir, "index.html"));
const SIZE = 256;
const BACKGROUND = "#d8d6cf";
/** Joint radius checked (px): the seam itself; further out a turning limb rightly uncovers what it hid. */
const R = 6;
/** The same for traced rigs: their shapes are smoothed outlines, so the concave corner where a limb meets the body (5-6 px out) is part of the outline that a turning limb uncovers. */
const RT = 4;
const FILE = "0123456789abcdef0123456789abcdef.png";

describe.skipIf(!hasExport || process.env.SKIP_BROWSER_TESTS === "1")("cutout rigs in the runtime", () => {
  const renderer = new BrowserRenderer(exportDir);
  afterAll(() => renderer.close());

  const concept = drawCreature(SIZE, SIZE);
  const cut = cutCharacter(concept)!;
  const plan = creaturePlan(SIZE, SIZE);
  const { rig } = cutoutRig(cut, plan, FILE);
  const images = { [FILE]: encodePng(cut.image).toString("base64") };
  // In concept pixels (fit: false), so renders line up with the concept.
  const render = async (clips: Record<string, Clip>, frames: { clip: string | null; time: number }[]) =>
    renderer.renderRig({ rig, direction: defaultArtDirection(), clips, frames, cellWidth: SIZE, cellHeight: SIZE, columns: frames.length, background: null, fit: false, images });

  it("draws the rest pose as the concept itself", async () => {
    const rest = await render({}, [{ clip: null, time: 0 }]);
    expect(rest.warnings).toEqual([]);
    const score = matchScore(flatten(decodePng(rest.png), BACKGROUND), concept, BACKGROUND);
    expect(score.silhouette).toBeGreaterThanOrEqual(0.95);
    expect(score.color).toBeGreaterThanOrEqual(0.9);
  }, 120_000);

  it("opens no gaps at the joints with limbs turned ±30°", async () => {
    const bend = Clip.parse({
      duration: 1,
      loop: false,
      tracks: ["head", "leg_far", "leg_near"].map((bone) => ({ bone, property: "rotate", keys: [[0, -30], [1, 30]], ease: "linear" })),
    });
    // Cells: rest, every joint at -30°, at +30°.
    const posed = decodePng((await render({ bend }, [{ clip: null, time: 0 }, { clip: "bend", time: 0 }, { clip: "bend", time: 1 }])).png);
    const alpha = (frame: number, x: number, y: number) => posed.data[(Math.round(y) * posed.width + Math.round(frame * SIZE + x)) * 4 + 3]!;
    // Inside the silhouette at rest: not on its edge, where a turning limb rightly changes the outline.
    const inside = (x: number, y: number) => [-2, 0, 2].every((dx) => [-2, 0, 2].every((dy) => alpha(0, x + dx, y + dy) >= 200));
    for (const frame of [1, 2]) {
      for (const id of ["head", "leg_far", "leg_near"]) {
        // The joint the rig turns about (the middle of where the pieces meet).
        const [px, py] = rig.bones.find((b) => b.id === id)!.pivot;
        // Every pixel within R px of the joint that was inside the character stays covered.
        const holes: string[] = [];
        let checked = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy > R * R || !inside(px + dx, py + dy)) continue;
            checked++;
            if (alpha(frame, px + dx, py + dy) < 200) holes.push(`${dx},${dy}`);
          }
        }
        expect(checked).toBeGreaterThan(40);
        expect(holes, `${id} at ${frame === 1 ? "-" : "+"}30°`).toEqual([]);
      }
    }
    // The limbs did move: the near leg's foot is somewhere else.
    const foot = rig.bones.find((b) => b.id === "leg_near")!.pivot;
    expect(alpha(0, foot[0], foot[1] + 0.16 * SIZE)).toBeGreaterThanOrEqual(200);
    for (const frame of [1, 2]) expect(alpha(frame, foot[0], foot[1] + 0.16 * SIZE)).toBeLessThan(200);
  }, 120_000);

  it("draws a traced rig close to the concept, and it opens no holes at the joints with limbs turned ±30°", async () => {
    // Rig px = concept px, so the ink is the art direction's width in concept px.
    const traced = tracedRig(cut, plan, defaultArtDirection(), { canvasPerGamePx: 1 }).rig;
    const bend = Clip.parse({
      duration: 1,
      loop: false,
      tracks: ["head", "leg_far", "leg_near"].map((bone) => ({ bone, property: "rotate", keys: [[0, -30], [1, 30]], ease: "linear" })),
    });
    const frames = [{ clip: null, time: 0 }, { clip: "bend", time: 0 }, { clip: "bend", time: 1 }];
    const out = await renderer.renderRig({ rig: traced, direction: defaultArtDirection(), clips: { bend }, frames, cellWidth: SIZE, cellHeight: SIZE, columns: 3, background: null, fit: false });
    expect(out.warnings).toEqual([]);
    const posed = decodePng(out.png);
    const rest: typeof posed = { width: SIZE, height: SIZE, data: new Uint8Array(SIZE * SIZE * 4) };
    for (let y = 0; y < SIZE; y++) rest.data.set(posed.data.subarray(y * posed.width * 4, (y * posed.width + SIZE) * 4), y * SIZE * 4);
    const score = matchScore(flatten(rest, BACKGROUND), concept, BACKGROUND);
    expect(score.silhouette).toBeGreaterThanOrEqual(0.9);
    expect(score.color).toBeGreaterThanOrEqual(0.85);
    const alpha = (frame: number, x: number, y: number) => posed.data[(Math.round(y) * posed.width + Math.round(frame * SIZE + x)) * 4 + 3]!;
    const inside = (x: number, y: number) => [-2, 0, 2].every((dx) => [-2, 0, 2].every((dy) => alpha(0, x + dx, y + dy) >= 200));
    for (const frame of [1, 2]) {
      for (const id of ["head", "leg_far", "leg_near"]) {
        const [px, py] = traced.bones.find((b) => b.id === id)!.pivot;
        const holes: string[] = [];
        for (let dy = -RT; dy <= RT; dy++) {
          for (let dx = -RT; dx <= RT; dx++) {
            if (dx * dx + dy * dy > RT * RT || !inside(px + dx, py + dy)) continue;
            if (alpha(frame, px + dx, py + dy) < 200) holes.push(`${dx},${dy}`);
          }
        }
        expect(holes, `${id} at ${frame === 1 ? "-" : "+"}30°`).toEqual([]);
      }
    }
  }, 120_000);
});
