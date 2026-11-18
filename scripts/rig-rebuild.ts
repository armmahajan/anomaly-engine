/**
 * Rebuild a rig's plan with the current code (no model calls) as a cutout and a traced rig,
 * keep its clips (as written, and fitted to each rig's joint limits), and measure each rig's
 * likeness to the concept the way the rig stage does (rest pose over the concept: silhouette + colour).
 *   node scripts/rig-rebuild.ts <out-dir> <rig.json> <concept.png> [plan.json]
 * Without plan.json the rig must be a cutout rig: its plan is read back from its parts.
 * With it, the frame is rig.json's preview frame.
 * Writes <out>/<variant>/rig.json for cutout, cutout-fit, traced-raw, traced (fitted clips), and <out>/match.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultArtDirection, type Clip, type Rig } from "@anomaly/core";
import {
  CutoutPlan,
  cutCharacter,
  cutoutRig,
  decodePng,
  drawnLineWidth,
  encodePng,
  fitClips,
  flatten,
  matchScore,
  motionLimits,
  placeCutout,
  planFromRig,
  solidMask,
  toCanvasSpace,
  toRigSpace,
  tracedRig,
  type Frame,
} from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";

const [out, rigPath, conceptPath, planPath] = process.argv.slice(2);
if (!out || !rigPath || !conceptPath) throw new Error("usage: node scripts/rig-rebuild.ts <out-dir> <rig.json> <concept.png> [plan.json]");
const BACKGROUND = "#d8d6cf";
const given = JSON.parse(readFileSync(rigPath, "utf8")) as { rig: Rig; clips: Record<string, Clip>; preview?: { frame?: Frame } };
const { rig, clips } = given;
const concept = decodePng(readFileSync(conceptPath));
const cut = cutCharacter(decodePng(readFileSync(conceptPath)))!;
let frame: Frame;
let plan: CutoutPlan;
if (planPath) {
  // The rig stage's scale; the feet where this cut puts them (fitBounds).
  frame = { scale: given.preview!.frame!.scale, anchor: [(cut.bounds.minX + cut.bounds.maxX) / 2, cut.bounds.maxY] };
  plan = CutoutPlan.parse(JSON.parse(readFileSync(planPath, "utf8")));
} else {
  if (!rig.source) throw new Error("not a cutout rig (pass its plan.json)");
  // The rig's frame, from its source placement: source anchor = frame anchor - cutout offset.
  frame = { scale: rig.source.scale, anchor: [rig.source.anchor[0] + cut.offset[0], rig.source.anchor[1] + cut.offset[1]] };
  plan = planFromRig(toCanvasSpace(rig, frame));
}
const direction = defaultArtDirection();
const size = { width: concept.width, height: concept.height };
const reference = flatten(placeCutout(cut, size), BACKGROUND);
const sourcePng = encodePng(cut.image);
const file = rig.source?.file ?? "0000000000000000000000000000000000000000.png";

const renderer = new BrowserRenderer(fileURLToPath(new URL("../apps/studio/public/game", import.meta.url)));
const match: Record<string, unknown> = {};
const save = (variant: string, r: Rig, c: Record<string, Clip>, source = false) => {
  mkdirSync(join(out, variant), { recursive: true });
  writeFileSync(join(out, variant, "rig.json"), JSON.stringify({ rig: r, clips: c, preview: { frame } }));
  if (source) writeFileSync(join(out, variant, file), sourcePng);
};
try {
  const measure = async (canvasRig: Rig, images?: Record<string, string>) => {
    const drawn = await renderer.renderRig({
      rig: canvasRig,
      direction: { ...direction, inkWidth: direction.inkWidth / frame.scale },
      clips: {},
      frames: [{ clip: null, time: 0 }],
      cellWidth: size.width,
      cellHeight: size.height,
      columns: 1,
      background: null,
      fit: false,
      ...(images ? { images } : {}),
    });
    return { score: matchScore(flatten(decodePng(drawn.png), BACKGROUND), reference, BACKGROUND), warnings: drawn.warnings, png: drawn.png };
  };
  const images = { [file]: sourcePng.toString("base64") };

  const cutout = cutoutRig(cut, plan, file);
  const cutoutGame = toRigSpace(cutout.rig, frame);
  save("cutout", cutoutGame, clips, true);
  save("cutout-fit", cutoutGame, fitClips(clips, motionLimits(cutoutGame)), true);
  match.cutout = (await measure(cutout.rig, images)).score;

  const t0 = Date.now();
  const traced = tracedRig(cut, plan, direction, { canvasPerGamePx: 1 / frame.scale });
  const ms = Date.now() - t0;
  const tracedGame = toRigSpace(traced.rig, frame);
  save("traced-raw", tracedGame, clips);
  save("traced", tracedGame, fitClips(clips, motionLimits(tracedGame)));
  const m = await measure(traced.rig);
  writeFileSync(join(out, "traced", "rest.png"), m.png);
  match.traced = {
    ...m.score,
    parts: traced.rig.parts.length,
    ms,
    line: drawnLineWidth(cut.image.data, solidMask(cut.image), cut.image.width, cut.image.height),
    warnings: [...traced.warnings, ...m.warnings],
  };
} finally {
  await renderer.close();
}
writeFileSync(join(out, "match.json"), JSON.stringify(match, null, 1));
console.log(JSON.stringify(match));
