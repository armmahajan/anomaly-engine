import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Clip, defaultArtDirection } from "@anomaly/core";
import { creaturePlan, cutCharacter, cutoutRig, decodePng, drawCreature, encodePng, flatten, matchScore } from "@anomaly/art";
import { BrowserRenderer } from "../src/art/renderer.ts";

/** Cutout rigs drawn by the real runtime (web export in headless Chromium): fidelity and joints. */

const exportDir = fileURLToPath(new URL("../../../apps/studio/public/game", import.meta.url));
const hasExport = existsSync(join(exportDir, "index.html"));
const SIZE = 256;
const BACKGROUND = "#d8d6cf";
/** Joint radius checked (px): the seam itself; further out a turning limb rightly uncovers what it hid. */
const R = 6;
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
        const [px, py] = plan.bones.find((b) => b.id === id)!.pivot;
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
    const foot = plan.bones.find((b) => b.id === "leg_near")!.pivot;
    expect(alpha(0, foot[0], foot[1] + 0.16 * SIZE)).toBeGreaterThanOrEqual(200);
    for (const frame of [1, 2]) expect(alpha(frame, foot[0], foot[1] + 0.16 * SIZE)).toBeLessThan(200);
  }, 120_000);
});
