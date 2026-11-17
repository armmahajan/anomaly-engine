/**
 * An agent-built game, end to end, with the real models and no hand-fixing:
 *   node scripts/agent-build.ts <out-dir> [--pitch "<text>"] [--art]
 * 1. The director drafts the wiki and the progression from a pitch.
 * 2. The build assistant builds the game from those documents, region by region, then its screens,
 *    and checks it (checkGame) and fixes what fails.
 * 3. --art: the game-art job draws everything (OpenRouter; costs money).
 * 4. The verdict: lint, the progression report, the logic-aware checker (beatable, dead states), and
 *    for each progression connection gated by a movement ability, whether the far region is reachable
 *    without it (it must not be) and with it (it must be).
 * The creator's messages are scripted below; the agents run as the studio chat runs them (Claude Code login).
 * Writes <out>/project.json, transcript.json and report.json; the project folder is <out>/data.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGame, createDefaultProject, lintProject, MOVEMENT_ABILITIES, progressionReport, type MovementAbility, type ProjectSpec } from "@anomaly/core";
import { AGENTS, runClaudeCodeTurn, type AgentEvent, type ChatMessage } from "@anomaly/agent";
import { ArtService } from "../packages/server/src/art/service.ts";
import { artOptionsFromEnv } from "../packages/server/src/art/config.ts";
import { FileStore, ProjectStore } from "../packages/server/src/index.ts";

const DEFAULT_PITCH =
  "A lantern-bearer descends into a flooded bell tower to relight the great bell. Three regions: the drowned crypt where it starts, the gear halls, and the belfry where it ends. A rusted automaton guards the gear halls.";

const args = process.argv.slice(2);
const outArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--pitch");
if (!outArg) throw new Error('usage: node scripts/agent-build.ts <out-dir> [--pitch "<text>"] [--art]');
const out: string = outArg;
const pitch = args.includes("--pitch") ? args[args.indexOf("--pitch") + 1]! : DEFAULT_PITCH;
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

mkdirSync(join(out, "data"), { recursive: true });
const store = await ProjectStore.open(join(out, "data"), createDefaultProject);
const options = artOptionsFromEnv(env, join(root, "apps/studio/public/game"));
const art = options.models ? await ArtService.open(store, { ...options, files: new FileStore(join(out, "data")) }) : null;
const model = env.STUDIO_CHAT_MODEL;
const transcript: { agent: string; message: string; reply: string; outcome: string; tools: { name: string; ok: boolean }[]; jobs: number }[] = [];
const history: Record<string, ChatMessage[]> = { build: [], narrative: [] };
const project = () => store.getState().project;

async function say(agent: "build" | "narrative", message: string) {
  const tools: { name: string; ok: boolean }[] = [];
  const onEvent = (e: AgentEvent) => {
    if (e.type === "tool_result") tools.push({ name: e.name, ok: e.ok });
  };
  const result = await runClaudeCodeTurn({
    project: project(),
    history: history[agent]!,
    userMessage: message,
    agent: AGENTS[agent],
    artAvailable: false, // art is one job at the end, not per request
    model,
    maxTurns: 60,
    onEvent,
    commit: (operations, baseRevision) => store.applyBatch({ operations, baseRevision, author: "ai" }),
  });
  history[agent]!.push(...result.messages);
  transcript.push({ agent, message, reply: result.reply, outcome: result.outcome, tools, jobs: result.jobs.length });
  writeFileSync(join(out, "transcript.json"), JSON.stringify(transcript, null, 1));
  console.log(`[${agent}] ${result.outcome}, ${tools.length} tool calls (${tools.filter((t) => !t.ok).length} failed): ${message.slice(0, 70)}`);
  return result;
}

// 1. Design.
await say("narrative", `Pitch: ${pitch}\nDraft the wiki: an overview, a page for each place and each character of the cast.`);
await say(
  "narrative",
  "Now draft the progression: the regions from the pitch with a start and an ending, about 2 or 3 rooms each (8 in total), at least one gate that needs a movement ability and one that needs a key, and the guardian as a boss that gives an ability. Then read the progression report and fix every issue.",
);

// 2. Build, region by region in the order the player meets them.
await say("build", "Read the design: getProgression and the wiki pages it points to. Create the enemy characters the cast needs (reuse the existing ones where they fit) and their behaviors.");
const order = (() => {
  const p = project().progression;
  const seen: string[] = p.start ? [p.start] : [];
  for (let i = 0; i < seen.length; i++) for (const c of p.connections) if (c.from === seen[i] && !seen.includes(c.to)) seen.push(c.to);
  return [...seen, ...p.regions.map((r) => r.id).filter((id) => !seen.includes(id))];
})();
for (const regionId of order) {
  const region = project().progression.regions.find((r) => r.id === regionId)!;
  await say(
    "build",
    `Build region "${region.name}" (${region.id}) from the documents: its rooms (about 30x14 tiles each) with regionId ${region.id}, floors and platforms the player can cross, doors to the rooms of the regions it connects to, its enemies, and wherever the progression says this region gives an ability or a key, the pickup or boss handler that gives it. Gate the connections it starts as the progression says, with props, flags and items. Fix every progression warning about this region.`,
  );
}
await say("build", "Set the world start in the start region and the playtest there too. Add a title screen shown on gameStarted, and an ending: touching something in the ending region runs endGame with an ending screen.");
await say("build", "Run checkGame. If the game isn't beatable or has dead states, fix the cause each counterexample shows, and run it again until it passes. Then fix any remaining warnings.");

// 3. Art.
let artCost = 0;
if (args.includes("--art") && art) {
  const started = await art.start({ stage: "gameArt" });
  if (started.ok) {
    await art.idle();
    const job = art.getState().jobs.at(-1)!;
    artCost = job.cost;
    console.log(`[art] ${job.outcome}, $${job.cost.toFixed(3)} ${job.error ?? ""}`);
  }
}

// 4. Verdict.
const final: ProjectSpec = project();
const verdict: Record<string, unknown> = { pitch, rooms: final.world.rooms.length, regions: final.progression.regions.length, artCost };
verdict.lint = lintProject(final).map((w) => `${w.code}: ${w.message}`);
const report = progressionReport(final);
verdict.progression = { finishable: report.finishable, criticalPath: report.criticalPath, issues: report.issues.map((i) => i.message) };
try {
  const check = checkGame(final);
  verdict.check = { hasEnding: check.hasEnding, beatable: check.beatable, deadStates: check.deadStates.map((d) => ({ why: d.why, steps: d.path.length, fromSave: d.fromSave })), stats: check.stats };
  const movement = new Set(Object.keys(MOVEMENT_ABILITIES));
  verdict.gates = final.progression.connections.flatMap((c) => {
    const needs = c.requires
      .map((id) => final.progression.abilities.find((a) => a.id === id)?.mechanic)
      .filter((m): m is MovementAbility => !!m && movement.has(m));
    if (needs.length === 0) return [];
    const far = final.world.rooms.filter((r) => r.regionId === c.to).map((r) => r.id);
    const without = checkGame(final, { withoutAbilities: needs }).reachableRooms;
    const reached = new Set(check.reachableRooms);
    return [{ connection: c.id, needs, holdsWithout: !far.some((r) => without.includes(r)), reachableWith: far.some((r) => reached.has(r)) }];
  });
} catch (e) {
  verdict.check = { error: e instanceof Error ? e.message : String(e) };
}
writeFileSync(join(out, "project.json"), JSON.stringify(final, null, 1));
writeFileSync(join(out, "report.json"), JSON.stringify(verdict, null, 1));
console.log(JSON.stringify(verdict, null, 1).slice(0, 2000));
await options.renderer.close();
