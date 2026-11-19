/**
 * A/B test of character rig modes on the same concepts.
 *   node scripts/rig-ab.ts <out-dir> [--opus] [--count N]
 * Real models cost money (reads OPENROUTER_API_KEY from .env; set STUDIO_ART_BACKEND=fake for a dry run).
 * Per brief: one concept sheet and pick, shared by every arm; then per arm a rig and its animations:
 *   vector and cutout (default vision model), vector-opus and cutout-opus (--opus: Claude Opus 5.5 rigs).
 * Writes <out>/results.json, each concept and each arm's rig, clips and renders;
 * `node scripts/rig-ab-page.ts <out-dir>` turns it into the blind voting page.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProject, newEnemyCharacter, type ArtJobRequest, type CharacterAsset } from "@anomaly/core";
import { ClaudeCodeVisionModel } from "../packages/server/src/art/claudeCodeVision.ts";
import { ArtService } from "../packages/server/src/art/service.ts";
import { artOptionsFromEnv } from "../packages/server/src/art/config.ts";
import { FileStore, ProjectStore } from "../packages/server/src/index.ts";

export const BRIEFS = [
  "a squat armored beetle with one curved horn",
  "a tall thin wanderer in a tattered cloak, holding a lantern",
  "a moth-like flyer with broad dusty wings",
  "a hulking stone golem with glowing cracks",
  "a spiky urchin creature on six thin legs",
  "a small knight with a round shield and a long spear",
  "a floating jellyfish spirit with long tendrils",
  "a fat toad with a huge mouth and warty skin",
  "a rat thief with a bushy tail and a dagger",
  "a mantis with scythe arms",
];

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
if (!out) throw new Error("usage: node scripts/rig-ab.ts <out-dir> [--opus] [--count N]");
const count = Number(args[args.indexOf("--count") + 1] ?? BRIEFS.length) || BRIEFS.length;
const root = fileURLToPath(new URL("..", import.meta.url));
// .env, without printing anything from it.
const env: Record<string, string | undefined> = { ...process.env };
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env: the environment must have the key (or STUDIO_ART_BACKEND=fake)
}

const dir = mkdtempSync(join(tmpdir(), "anomaly-rig-ab-"));
const store = await ProjectStore.open(dir, createDefaultProject);
const files = new FileStore(dir);
const options = artOptionsFromEnv(env, join(root, "apps/studio/public/game"));
if (!options.models) throw new Error(options.unavailableReason ?? "no art models");
const arms: { id: string; mode: "vector" | "cutout"; service: ArtService }[] = [
  { id: "vector", mode: "vector", service: await ArtService.open(store, { ...options, files, budget: 1 }) },
  { id: "cutout", mode: "cutout", service: await ArtService.open(store, { ...options, files, budget: 1 }) },
];
if (args.includes("--opus") && env.STUDIO_ART_BACKEND !== "fake") {
  const opus = new ClaudeCodeVisionModel({ model: "claude-opus-5-5" }); // the Claude Code subscription, never OpenRouter
  arms.push({ id: "vector-opus", mode: "vector", service: await ArtService.open(store, { ...options, files, budget: 3, models: { ...options.models, vision: opus } }) });
  arms.push({ id: "cutout-opus", mode: "cutout", service: await ArtService.open(store, { ...options, files, budget: 3, models: { ...options.models, vision: opus } }) });
}

async function job(service: ArtService, request: ArtJobRequest) {
  const started = await service.start(request);
  if (!started.ok) throw new Error(started.error.message);
  await service.idle();
  const last = service.getState().jobs.at(-1)!;
  if (last.outcome !== "committed") throw new Error(`${request.stage} ${request.characterId}: ${last.outcome} (${last.error})`);
  return last.cost;
}
const asset = (characterId: string) => {
  const project = store.getState().project;
  const id = project.characters.find((c) => c.id === characterId)!.appearance;
  return project.art.assets.find((a) => a.id === id) as CharacterAsset;
};

mkdirSync(out, { recursive: true });
const results = [];
try {
  for (const [i, brief] of BRIEFS.slice(0, count).entries()) {
    const id = `subject_${i + 1}`;
    const created = await store.applyOperation({ name: "createCharacter", input: { character: newEnemyCharacter(id, `Subject ${i + 1}`) }, baseRevision: store.getState().project.revision, author: "user" });
    if (!created.ok) throw new Error(created.error.message);
    const base = arms[0]!.service;
    const conceptCost = (await job(base, { stage: "concepts", characterId: id, brief })) + (await job(base, { stage: "choose", characterId: id }));
    const chosen = asset(id).chosen!;
    mkdirSync(join(out, id), { recursive: true });
    writeFileSync(join(out, id, "concept.png"), await files.get(chosen.file));
    const entry: Record<string, unknown> = { id, brief, conceptCost, arms: {} };
    for (const arm of arms) {
      const cost = (await job(arm.service, { stage: "rig", characterId: id, rigMode: arm.mode })) + (await job(arm.service, { stage: "animate", characterId: id }));
      const a = asset(id);
      const clips = Object.keys(a.clips);
      const sheet = await options.renderer.renderRig({
        rig: a.rig!,
        direction: store.getState().project.art.direction,
        clips: a.clips,
        frames: [{ clip: null, time: 0 }, ...clips.flatMap((clip) => Array.from({ length: 6 }, (_, f) => ({ clip, time: (a.clips[clip]!.duration * f) / 6 })))],
        cellWidth: 192,
        cellHeight: 192,
        columns: 6,
        background: "#d8d6cf",
        ...(a.rig!.source && { images: { [a.rig!.source.file]: (await files.get(a.rig!.source.file)).toString("base64") } }),
      });
      mkdirSync(join(out, id, arm.id), { recursive: true });
      writeFileSync(join(out, id, arm.id, "sheet.png"), sheet.png);
      writeFileSync(join(out, id, arm.id, "rig.json"), JSON.stringify({ rig: a.rig, clips: a.clips }, null, 1));
      (entry.arms as Record<string, unknown>)[arm.id] = { cost, match: a.preview?.match ?? null, score: a.preview?.score ?? null, clips };
      console.log(`${id} ${arm.id}: match ${JSON.stringify(a.preview?.match ?? null)}, $${cost.toFixed(4)}`);
    }
    results.push(entry);
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
  }
} finally {
  await options.renderer.close();
}
console.log(`wrote ${results.length} subjects to ${out}`);
