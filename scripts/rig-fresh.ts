/**
 * Build and animate a rig from an existing concept image with the real pipeline (rig stage with
 * its critique loop, then the animate stage), with the vision model on the local Claude Code
 * login (free) and no image model (spend $0).
 *   node scripts/rig-fresh.ts <out-dir> <concept.png> "<brief>" [--mode traced|cutout|vector] [--plan plan.json]
 * --plan skips the model's plan and critique: the rig is built from that plan by code alone.
 * Writes <out>/rig.json ({rig, clips}; a cutout rig's source PNG beside it), <out>/plan.json, <out>/log.txt.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBatch, createDefaultProject, type FileRef, type OperationCall, type ProjectSpec, type RigMode } from "@anomaly/core";
import {
  animate,
  buildRig,
  CutoutPlan,
  cutCharacter,
  decodePng,
  fitBounds,
  toRigSpace,
  tracedRig,
  cutoutRig,
  encodePng,
  type ArtContext,
  type ImageModel,
} from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";
import { ClaudeCodeVisionModel } from "../packages/server/src/art/claudeCodeVision.ts";

const args = process.argv.slice(2);
const [out, conceptPath, brief] = args;
if (!out || !conceptPath || !brief) throw new Error('usage: node scripts/rig-fresh.ts <out-dir> <concept.png> "<brief>" [--mode traced|cutout|vector] [--plan plan.json]');
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const mode = (flag("--mode") ?? "traced") as RigMode;
const planPath = flag("--plan");
mkdirSync(out, { recursive: true });

const files = new Map<string, Buffer>();
const store = {
  async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
    const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
    files.set(ref, data);
    return ref;
  },
  async get(ref: FileRef): Promise<Buffer> {
    const data = files.get(ref);
    if (!data) throw new Error(`no file ${ref}`);
    return data;
  },
};
const noImages: ImageModel = {
  id: "none",
  async generate() {
    throw new Error("this script never generates images");
  },
};
let project: ProjectSpec = createDefaultProject();
const character = project.characters.find((c) => c.kind === "enemy")!;
const commit = (operations: OperationCall[]) => {
  const result = applyBatch(project, operations);
  if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
  project = result.project;
};
const concept = readFileSync(conceptPath);
const file = await store.put(concept, "png");
commit([
  { name: "createAsset", input: { asset: { id: "look", name: "Look", kind: "character", brief }, assignTo: character.id } },
  { name: "addConcept", input: { assetId: "look", concept: { file, prompt: brief, model: "given", cost: 0, at: new Date().toISOString() } } },
  { name: "chooseConcept", input: { assetId: "look", sheet: 0, cell: 0, file } },
]);

const log: string[] = [];
let spent = 0;
const renderer = new BrowserRenderer(fileURLToPath(new URL("../apps/studio/public/game", import.meta.url)));
const ctx: ArtContext = {
  project: () => project,
  image: noImages,
  vision: new ClaudeCodeVisionModel(),
  renderer,
  files: store,
  log: (a) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${a.text}${a.cost ? ` ($${a.cost.toFixed(4)})` : ""}`;
    log.push(line);
    console.log(line);
    writeFileSync(join(out, "log.txt"), log.join("\n"));
  },
  remaining: () => 5 - spent,
  spend: (usage) => {
    spent += usage.cost;
  },
  defaultRigMode: mode,
};
const asset = () => project.art.assets.find((a) => a.id === "look") as Extract<ProjectSpec["art"]["assets"][number], { kind: "character" }>;
try {
  if (planPath) {
    // Code only: the given plan, built and framed the way the rig stage does.
    const plan = CutoutPlan.parse(JSON.parse(readFileSync(planPath, "utf8")));
    const cut = cutCharacter(decodePng(concept))!;
    const frame = fitBounds(cut.bounds, character.size);
    const source = encodePng(cut.image);
    const built = mode === "cutout" ? cutoutRig(cut, plan, await store.put(source, "png")) : tracedRig(cut, plan, project.art.direction, { canvasPerGamePx: 1 / frame.scale });
    const preview = await store.put(source, "png");
    commit([{ name: "setRig", input: { assetId: "look", rig: toRigSpace(built.rig, frame), preview: { file: preview, score: 0, notes: "", frame } } }]);
    writeFileSync(join(out, "plan.json"), JSON.stringify({ ...plan, bones: built.bones }, null, 1));
  } else {
    const result = await buildRig(ctx, { characterId: character.id, rigMode: mode });
    commit(result.operations);
    if (result.plan) writeFileSync(join(out, "plan.json"), JSON.stringify(result.plan, null, 1));
    ctx.log({ text: result.summary });
  }
  const result = await animate(ctx, { characterId: character.id });
  commit(result.operations);
  ctx.log({ text: result.summary });
  const a = asset();
  writeFileSync(join(out, "rig.json"), JSON.stringify({ rig: a.rig, clips: a.clips, preview: a.preview }));
  if (a.rig?.source) writeFileSync(join(out, a.rig.source.file), files.get(a.rig.source.file)!);
  ctx.log({ text: `done; spent $${spent.toFixed(4)}` });
} finally {
  await renderer.close();
}
