/**
 * The Architect's eval: pitch -> director (wiki, progression) -> Build game (every Architect stage, the
 * real models, no guidance, no hand-fixing) -> verdict. The bar is 9 of 10 pitches passing.
 *   node scripts/architect-eval.ts <out-dir> [--only 0,3] [--art] [--from <stage>]
 * --from <stage>: rebuild an earlier run's saved design (no new director turns) from that stage, e.g. after a fix.
 * Each pitch runs in <out>/<n>/ (the project folder is <out>/<n>/data); <out>/summary.json collects the verdicts.
 * Pass: beatable, no dead states, every gate holds, every critical-path movement ability needed, lint clean,
 * 4-5 regions, 20-30 rooms, 2-3 guardians, estimated play time inside the target, art under $1.00 (with --art).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProject, estimatePlayTime, verifyStage, type ArchitectStage, type ProjectSpec } from "@anomaly/core";
import { AGENTS, runClaudeCodeTurn, type ChatMessage, type TurnRunner } from "@anomaly/agent";
import { ArtService } from "../packages/server/src/art/service.ts";
import { artOptionsFromEnv } from "../packages/server/src/art/config.ts";
import { ArchitectService, defaultStageRunners, FileStore, modelStageRunners, ProjectStore } from "../packages/server/src/index.ts";

export const PITCHES = [
  "A lantern-bearer descends into a flooded bell tower to relight the great bell.",
  "A moth spirit climbs out of a burned forest toward the moon.",
  "A diver explores a sunken observatory to restart its great lens.",
  "A clockwork knight wakes in a dead city of gears and must wind the heart of the city.",
  "A young beekeeper follows the last queen into a hive that has grown into a mountain.",
  "A ghost ferryman searches the drowned underworld for the coin that will let him rest.",
  "A salt miner tunnels through crystal caverns toward the singing at the bottom of the world.",
  "A paper crane folds itself through a library that rewrites its own shelves at night.",
  "A frost wolf cub crosses a frozen kingdom whose sun was stolen by its own king.",
  "A street cat climbs a tower of stacked houses in a city that keeps growing upward.",
];

const args = process.argv.slice(2);
const out = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only" && args[i - 1] !== "--from");
const from = args.includes("--from") ? (args[args.indexOf("--from") + 1] as ArchitectStage) : undefined;
if (!out) throw new Error("usage: node scripts/architect-eval.ts <out-dir> [--only 0,3] [--art]");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",").map(Number) : PITCHES.map((_, i) => i);
const withArt = args.includes("--art");
const root = fileURLToPath(new URL("..", import.meta.url));
const env: Record<string, string | undefined> = { ...process.env };
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env
}
const model = env.STUDIO_CHAT_MODEL;
const runner: TurnRunner = (request) => runClaudeCodeTurn({ ...request, model, maxTurns: 80 });

async function evaluate(n: number): Promise<Record<string, unknown>> {
  const dir = join(out!, String(n));
  mkdirSync(join(dir, "data"), { recursive: true });
  const store = await ProjectStore.open(join(dir, "data"), createDefaultProject);
  const options = artOptionsFromEnv(env, join(root, "apps/studio/public/game"));
  const art = withArt && options.models ? await ArtService.open(store, { ...options, files: new FileStore(join(dir, "data")) }) : null;
  const history: ChatMessage[] = [];
  const t0 = Date.now();
  const director = async (message: string) => {
    const result = await runner({
      project: store.getState().project,
      history,
      userMessage: message,
      agent: AGENTS.narrative,
      commit: (operations, baseRevision) => store.applyBatch({ operations, baseRevision, author: "ai" }),
    });
    history.push(...result.messages);
    console.log(`[${n}] director ${result.outcome}`);
  };
  if (!from) await director(`Pitch: ${PITCHES[n]}\nDraft the wiki: an overview, a page for each place and each character of the cast. Decide open questions yourself.`);
  if (!from) await director(
    "Now draft the progression: 4 or 5 regions with a start and an ending, 4 to 7 rooms each (20 to 30 in total), 2 or 3 bosses that each guard an ability, at least two movement abilities that gate connections and one key. Give every region its enemies. Then read the progression report and fix every issue. Decide open questions yourself.",
  );

  const architect = new ArchitectService(store, defaultStageRunners({ art, overrides: modelStageRunners(runner) }), { repairPacing: true });
  const started = await architect.start(from ? { from } : {});
  if (!started.ok) throw new Error(started.error.message);
  await architect.idle();
  const state = architect.getState();
  const project: ProjectSpec = store.getState().project;
  const { verdict, issues } = verifyStage(project);
  const estimate = estimatePlayTime(project);
  const guardians = project.world.rooms.flatMap((r) => r.spawns.filter((s) => s.healthBar)).length;
  const artCost = art?.getState().totalCost ?? 0;
  const [lo, hi] = project.architect.target.minutes;
  const checks = {
    beatable: verdict.beatable,
    noDeadStates: verdict.deadStates === 0,
    gatesHold: verdict.gatesHold,
    abilitiesNeeded: verdict.abilitiesNeeded,
    lintClean: verdict.lint.length === 0,
    regions: project.progression.regions.length >= 4 && project.progression.regions.length <= 5,
    rooms: project.architect.rooms.length >= project.architect.target.rooms[0] && project.architect.rooms.length <= project.architect.target.rooms[1],
    guardians: guardians >= 2 && guardians <= 3,
    playTime: estimate.minutes >= lo && estimate.minutes <= hi,
    artBudget: !withArt || artCost <= 1,
  };
  const report = {
    pitch: PITCHES[n],
    pass: Object.values(checks).every(Boolean),
    checks,
    minutes: estimate.minutes,
    regions: project.progression.regions.length,
    rooms: project.architect.rooms.length,
    guardians,
    artCost,
    run: state.last,
    stages: project.architect.stages,
    issues: issues.map((i) => `${i.stage}/${i.code}: ${i.message}`),
    lint: verdict.lint,
    wallMinutes: Math.round((Date.now() - t0) / 6000) / 10,
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1));
  writeFileSync(join(dir, "log.json"), JSON.stringify(state.log, null, 1));
  console.log(`[${n}] ${report.pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
  return report;
}

const reports: Record<string, unknown>[] = [];
for (const n of only) {
  try {
    reports.push(await evaluate(n));
  } catch (e) {
    reports.push({ pitch: PITCHES[n], pass: false, error: e instanceof Error ? e.message : String(e) });
    console.log(`[${n}] ERROR ${e instanceof Error ? e.message : e}`);
  }
  writeFileSync(join(out, "summary.json"), JSON.stringify({ passed: reports.filter((r) => r.pass).length, of: reports.length, reports }, null, 1));
}
console.log(`passed ${reports.filter((r) => r.pass).length} of ${reports.length}`);
