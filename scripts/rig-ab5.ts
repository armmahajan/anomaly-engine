/**
 * Vision model A/B, round 5: the chosen character pipeline (rig-ready concept -> flat redraw ->
 * vector-loop rig -> detail finish -> walk) with Opus or Haiku as the vision model, and what each
 * would cost a creator at API prices.
 *   node scripts/rig-ab5.ts <round3-dir> <out-dir> --arms opus|haiku[,..] [--subjects player,guard] [--budget 0]
 * Both arms start from round 3's cached rig-ready concept and flat redraw per subject
 * (<round3>/<subject>/{concept-ready,flat}, copied once to <out>/<subject>/; round 3 is only read),
 * so only the model differs. Each arm builds its own vector rig (round 3's vector-loop: limb joints,
 * 4 render-and-compare rounds), idle + walk clips (round 3) and detail finish (round 4's detail arm:
 * 3 look-and-fix rounds), all with its model on the local Claude Code login.
 * Cost: ANOMALY_USAGE_LOG is pointed at <out>/<subject>/<arm>/usage-<stage>.jsonl while that stage
 * runs (claudeCodeVision.ts writes one line per call: tokens and Claude Code's API-price estimate),
 * so run one arm per process. No image calls are expected: the image model answers from the cache
 * (<out>/cache, a copy of round 3's) and refuses a miss unless --budget (USD, default 0) allows it.
 * Writes per subject and arm: concept.png, design.png, still.png, closeup.png, walk.webp,
 * walk-sheet.png, rig.json, rig-plain.json (before the finish), result.json, usage.json, calls.jsonl,
 * log.txt; `node scripts/rig-ab5-page.ts <out>` makes results.json, the cost table and the vote page.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyBatch,
  createDefaultProject,
  newEnemyCharacter,
  rigBounds,
  type Character,
  type CharacterAsset,
  type Clip,
  type FileRef,
  type OperationCall,
  type ProjectSpec,
  type Rig,
} from "@anomaly/core";
import {
  animate,
  buildRig,
  cutCharacter,
  decodePng,
  flatten,
  look,
  matchScore,
  OpenRouterImageModel,
  pngSize,
  sheetMetrics,
  type ArtContext,
  type ImageModel,
  type Pixels,
  type RigInput,
  type StageResult,
  type VisionModel,
} from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";
import { ClaudeCodeVisionModel } from "../packages/server/src/art/claudeCodeVision.ts";
import { PRICES, summarize, type UsageLine } from "./rig-ab5-cost.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

interface Arm {
  id: string;
  what: string;
  model: string;
}

export const ARMS: Arm[] = [
  { id: "opus", what: "Claude Opus 5.5 draws the vector rig, fixes it, animates it and adds the detail finish", model: "claude-opus-5-5" },
  { id: "haiku", what: "Claude Haiku 5.5 draws the vector rig, fixes it, animates it and adds the detail finish", model: "claude-haiku-5-5" },
];

/** Round 3's vector-loop arm, exactly. */
const RIG: Omit<RigInput, "characterId"> = { rigMode: "vector", limbJoints: true, rounds: 4 };
const SLOTS = ["idle", "walk"] as const;
const BACKGROUND = "#d8d6cf";
const STAGES = ["rig", "animation", "detail"] as const;
type Stage = (typeof STAGES)[number];

// --- arguments, environment ---------------------------------------------------------------

const args = process.argv.slice(2);
const round3 = args[0] ?? "";
const out = args[1] ?? "";
if (!round3 || !out || out.startsWith("--")) throw new Error("usage: node scripts/rig-ab5.ts <round3-dir> <out-dir> --arms opus|haiku [--subjects a,b] [--budget 0]");
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const BUDGET = Number(flag("--budget") ?? 0);
const wantedSubjects = flag("--subjects")?.split(",");
const wantedArms = flag("--arms")?.split(",");
if (!wantedArms || wantedArms.length !== 1) throw new Error("--arms: exactly one arm per process (the usage log is per process)");
mkdirSync(out, { recursive: true });
if (!existsSync(join(out, "cache"))) cpSync(join(round3, "cache"), join(out, "cache"), { recursive: true });

const env: Record<string, string | undefined> = { ...process.env };
for (const file of [join(root, ".env"), join(root, "../../../.env")]) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
    break;
  } catch {
    // try the next
  }
}
const apiKey = env.OPENROUTER_API_KEY?.trim();

// --- the image model: cache first, a miss only within --budget -----------------------------------

const LEDGER = join(out, "costs.jsonl");
const CALL_RESERVE = 0.03;
const spentSoFar = () =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce((s, l) => s + (JSON.parse(l) as { cost: number }).cost, 0)
    : 0;
const real = apiKey ? new OpenRouterImageModel({ apiKey }, env.STUDIO_ART_IMAGE_MODEL ?? "openai/gpt-image-1-mini", { quality: env.STUDIO_ART_IMAGE_QUALITY ?? "low" }) : null;
function cachedImages(label: () => string): ImageModel {
  return {
    id: real?.id ?? "none",
    async generate(request) {
      const key = createHash("sha256")
        .update(request.prompt)
        .update(request.quality ?? "")
        .update(JSON.stringify(request.references?.map((r) => createHash("sha256").update(r).digest("hex")) ?? []))
        .digest("hex")
        .slice(0, 24);
      const file = join(out, "cache", `${key}.png`);
      const meta = join(out, "cache", `${key}.json`);
      if (existsSync(file) && existsSync(meta)) {
        const m = JSON.parse(readFileSync(meta, "utf8")) as { model: string; ext: "png" | "jpg" | "webp"; cost: number };
        return { image: readFileSync(file), ext: m.ext, usage: { cost: m.cost, promptTokens: 0, completionTokens: 0 }, model: `${m.model} (cached)` };
      }
      if (!real) throw new Error("OPENROUTER_API_KEY is not set (.env)");
      const spent = spentSoFar();
      if (spent + CALL_RESERVE > BUDGET) throw new Error(`image budget: $${spent.toFixed(4)} spent of $${BUDGET}; refusing an image call this round should not need (${label()})`);
      const t0 = Date.now();
      const result = await real.generate(request);
      writeFileSync(file, result.image);
      writeFileSync(meta, JSON.stringify({ model: result.model, ext: result.ext, cost: result.usage.cost, prompt: request.prompt, references: request.references?.length ?? 0 }));
      appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), what: label(), model: result.model, cost: result.usage.cost, ms: Date.now() - t0, key })}\n`);
      return result;
    },
  };
}

// --- vision: the arm's model, every call counted per stage --------------------------------------

let stage: Stage = "rig";
let callLog = "";
function counted(inner: VisionModel): VisionModel {
  return {
    id: inner.id,
    async complete(request) {
      const t0 = Date.now();
      const repair = (request.history?.length ?? 0) > 0;
      try {
        const reply = await inner.complete(request);
        appendFileSync(callLog, `${JSON.stringify({ stage, ok: true, repair, ms: Date.now() - t0 })}\n`);
        return reply;
      } catch (error) {
        appendFileSync(callLog, `${JSON.stringify({ stage, ok: false, repair, ms: Date.now() - t0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) })}\n`);
        throw error;
      }
    },
  };
}

// --- files, renderer, one in-memory project per run ---------------------------------------------

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
const renderer = new BrowserRenderer(join(root, "apps/studio/public/game"));
/** Round 4's direction (its plain arm drew exactly what round 3 drew). */
const DIRECTION = createDefaultProject().art.direction;

interface Subject {
  id: string;
  name: string;
  brief: string;
  kind: "player" | "enemy";
  size: { width: number; height: number };
}

function characterFor(subject: Subject): Character {
  const base = createDefaultProject();
  if (subject.kind === "player") return { ...base.characters.find((c) => c.kind === "player")!, size: subject.size };
  return { ...newEnemyCharacter(subject.id, subject.name), size: subject.size };
}

function session(subject: Subject, vision: VisionModel, logPath: string) {
  let project: ProjectSpec = createDefaultProject();
  project = { ...project, art: { ...project.art, direction: DIRECTION } };
  const character = characterFor(subject);
  project = { ...project, characters: [...project.characters.filter((c) => c.id !== character.id), character] };
  const lines: string[] = [];
  let spent = 0;
  const ctx: ArtContext = {
    project: () => project,
    image: cachedImages(() => `${subject.id} ${stage}`),
    vision,
    renderer,
    files: store,
    log: (a) => {
      lines.push(`${new Date().toISOString().slice(11, 19)} [${stage}] ${a.text}${a.cost ? ` ($${a.cost.toFixed(4)})` : ""}`);
      writeFileSync(logPath, lines.join("\n"));
    },
    remaining: () => 5 - spent,
    spend: (usage) => {
      spent += usage.cost;
    },
  };
  const commit = (result: StageResult) => {
    const applied = applyBatch(project, result.operations as OperationCall[]);
    if (!applied.ok) throw new Error(`${applied.error.message} ${JSON.stringify(applied.error.issues)}`);
    project = applied.project;
    ctx.log({ text: result.summary });
  };
  const asset = () => {
    const id = project.characters.find((c) => c.id === character.id)!.appearance;
    return project.art.assets.find((a) => a.id === id) as CharacterAsset | undefined;
  };
  return { ctx, commit, asset, character, spent: () => spent };
}

/** Round 3's shared stages for a subject, copied once into <out>/<subject>/. */
function shared(subject: Subject) {
  for (const d of ["concept-ready", "flat"]) {
    const to = join(out, subject.id, d);
    if (!existsSync(join(to, "meta.json"))) cpSync(join(round3, subject.id, d), to, { recursive: true });
  }
  const meta = (d: string) => JSON.parse(readFileSync(join(out, subject.id, d, "meta.json"), "utf8")) as { cost: number };
  return {
    sheet: readFileSync(join(out, subject.id, "concept-ready", "sheet.png")),
    chosen: readFileSync(join(out, subject.id, "concept-ready", "chosen.png")),
    design: readFileSync(join(out, subject.id, "flat", "design.png")),
    imageCost: meta("concept-ready").cost + meta("flat").cost,
  };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const round3n = (n: number) => Math.round(n * 1e3) / 1e3;

async function runArm(subject: Subject, arm: Arm) {
  const dir = join(out, subject.id, arm.id);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, "result.json"))) {
    console.log(`${subject.id} ${arm.id}: done already`);
    return;
  }
  // A rerun starts the arm over: its usage and call logs too.
  for (const f of readdirSync(dir)) if (/^usage-.*\.jsonl$|^calls\.jsonl$/.test(f)) writeFileSync(join(dir, f), "");
  callLog = join(dir, "calls.jsonl");
  const vision = counted(new ClaudeCodeVisionModel({ model: arm.model }));
  const c = shared(subject);
  const s = session(subject, vision, join(dir, "log.txt"));
  writeFileSync(join(dir, "concept.png"), c.chosen);
  writeFileSync(join(dir, "design.png"), c.design);
  const sheetRef = await store.put(c.sheet, "png");
  const designRef = await store.put(c.design, "png");
  s.commit({
    operations: [
      { name: "createAsset", input: { asset: { id: "look", name: "Look", kind: "character", brief: subject.brief }, assignTo: s.character.id } },
      { name: "addConcept", input: { assetId: "look", concept: { file: sheetRef, prompt: subject.brief, model: "given", cost: 0, at: new Date().toISOString() } } },
      { name: "chooseConcept", input: { assetId: "look", sheet: 0, cell: 0, file: designRef } },
    ],
    summary: "seeded the flat redraw of the rig-ready design (round 3)",
  });

  const seconds: Record<Stage, number> = { rig: 0, animation: 0, detail: 0 };
  const run = async <T>(st: Stage, f: () => Promise<T>): Promise<T> => {
    stage = st;
    process.env.ANOMALY_USAGE_LOG = join(dir, `usage-${st}.jsonl`);
    const t0 = Date.now();
    try {
      return await f();
    } finally {
      seconds[st] += Math.round((Date.now() - t0) / 100) / 10;
      delete process.env.ANOMALY_USAGE_LOG;
    }
  };

  // Rig and walk: round 3's vector-loop arm.
  const built = await run("rig", () => buildRig(s.ctx, { characterId: s.character.id, ...RIG }));
  s.commit(built);
  if (built.plan) writeFileSync(join(dir, "plan.json"), JSON.stringify(built.plan, null, 1));
  s.commit(await run("animation", () => animate(s.ctx, { characterId: s.character.id, slots: [...SLOTS], limbJoints: true, jointLimits: true })));
  const a = s.asset()!;
  const plain = a.rig!;
  const clips = a.clips as Record<string, Clip>;
  writeFileSync(join(dir, "rig-plain.json"), JSON.stringify({ rig: plain, clips, preview: a.preview }, null, 1));
  // The finish: round 4's detail arm, on this arm's own rig.
  const finished = await run("detail", () =>
    look(s.ctx, { rig: plain, frame: a.preview!.frame!, canvas: pngSize(c.design), design: c.chosen, brief: subject.brief }, { look: "detail" }),
  );
  const rig = finished.rig;
  writeFileSync(join(dir, "rig.json"), JSON.stringify({ rig, clips, preview: a.preview }, null, 1));

  const media = await renderMedia(dir, rig, clips, plain);
  const likeness = await likenessTo(rig, c.chosen);
  const likenessPlain = await likenessTo(plain, c.chosen);
  const usage = usageOf(dir, arm.model);
  writeFileSync(join(dir, "usage.json"), JSON.stringify(usage, null, 1));
  const calls = readFileSync(callLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { stage: Stage; ok: boolean; repair: boolean; ms: number; error?: string });
  const total = seconds.rig + seconds.animation + seconds.detail;
  const result = {
    subject: subject.id,
    arm: arm.id,
    model: arm.model,
    what: arm.what,
    seconds: { ...seconds, total: Math.round(total * 10) / 10 },
    cost: { sharedImages: round4(c.imageCost), extraImages: round4(s.spent()), vision: usage.total, visionByStage: usage.stages },
    calls: {
      total: calls.length,
      failed: calls.filter((x) => !x.ok).length,
      repairs: calls.filter((x) => x.repair).length,
      byStage: Object.fromEntries(STAGES.map((st) => [st, calls.filter((x) => x.stage === st).length])),
      errors: calls.filter((x) => !x.ok).map((x) => `${x.stage}: ${x.error}`),
    },
    match: a.preview?.match ?? null,
    rigScore: a.preview?.score ?? null,
    rigNotes: a.preview?.notes ?? "",
    likeness,
    likenessBeforeFinish: likenessPlain,
    counts: counts(rig, plain),
    detailScore: finished.score ?? null,
    detailNotes: finished.notes ?? null,
    clips: Object.keys(clips),
    ...media,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
  console.log(
    `${subject.id} ${arm.id}: ${result.seconds.total}s (rig ${seconds.rig}, anim ${seconds.animation}, detail ${seconds.detail}) $${usage.total.apiCostUsd.toFixed(4)} API-price, match ${JSON.stringify(result.match)} likeness ${JSON.stringify(likeness)} parts ${result.counts.parts} (+${result.counts.added}), calls ${calls.length} (${result.calls.failed} failed, ${result.calls.repairs} repairs)`,
  );
}

function usageOf(dir: string, model: string) {
  const read = (st: Stage): UsageLine[] => {
    const f = join(dir, `usage-${st}.jsonl`);
    return existsSync(f)
      ? readFileSync(f, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as UsageLine)
      : [];
  };
  const stages = Object.fromEntries(STAGES.map((st) => [st, summarize(read(st), model)])) as Record<Stage, ReturnType<typeof summarize>>;
  return { model, prices: PRICES[model] ?? null, stages, total: summarize(STAGES.flatMap(read), model) };
}

/** Parts, how many the finish added, clipped parts. */
function counts(rig: Rig, plain: Rig) {
  return { bones: rig.bones.length, parts: rig.parts.length, plainParts: plain.parts.length, added: rig.parts.length - plain.parts.length, clipped: rig.parts.filter((p) => p.clipTo).length };
}

/** Round 4's framing: an invisible box a little larger than the unfinished rig's rest pose. */
function framed(rig: Rig, plain: Rig, close = false): Rig {
  const b = rigBounds(plain);
  const [cx, cy, hw, hh] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (close ? 0.53 : 0.62) * (b.maxX - b.minX), (close ? 0.53 : 0.54) * (b.maxY - b.minY)];
  const half = close ? hw : Math.max(hw, hh * 0.75);
  const rootBone = rig.bones.find((bone) => bone.parent === null)!.id;
  return {
    ...rig,
    parts: [
      ...rig.parts,
      {
        id: "ab_frame",
        bone: rootBone,
        z: -100,
        shape: { type: "blob", points: [[cx - half, cy - hh], [cx + half, cy - hh], [cx + half, cy + hh], [cx - half, cy + hh]], smooth: 0, sharp: [] },
        fill: "#000000",
        ink: 0,
        glow: false,
        opacity: 0,
      },
    ],
  };
}

const WALK_FRAMES = 16;
const CLOSE = 560;
const CELL = 320;
const METRIC_FRAMES = 12;
const METRIC_CELL = 384;

/** Round 4's media: still, close up, the walk as an animated WebP, animation metrics. */
async function renderMedia(dir: string, rig: Rig, clips: Record<string, Clip>, plain: Rig) {
  const shown = framed(rig, plain);
  const clip = clips.walk ? "walk" : clips.idle ? "idle" : Object.keys(clips)[0]!;
  const still = await renderer.renderRig({ rig: shown, direction: DIRECTION, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: CELL, cellHeight: CELL, columns: 1, background: BACKGROUND });
  writeFileSync(join(dir, "still.png"), still.png);
  const close = await renderer.renderRig({ rig: framed(rig, plain, true), direction: DIRECTION, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: CLOSE, cellHeight: CLOSE, columns: 1, background: BACKGROUND });
  const m = Math.round(CLOSE * 0.16);
  writeFileSync(join(dir, "closeup.png"), await renderer.crop(close.png, { x: m / CLOSE, y: m / CLOSE, width: (CLOSE - 2 * m) / CLOSE, height: (CLOSE - 2 * m) / CLOSE }, CLOSE));
  const duration = clips[clip]!.duration;
  const sheet = await renderer.renderRig({
    rig: shown,
    direction: DIRECTION,
    clips,
    frames: Array.from({ length: WALK_FRAMES }, (_, i) => ({ clip, time: (duration * i) / WALK_FRAMES })),
    cellWidth: CELL,
    cellHeight: CELL,
    columns: WALK_FRAMES,
    background: BACKGROUND,
  });
  writeFileSync(join(dir, "walk-sheet.png"), sheet.png);
  const webp = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      [
        "import sys",
        "from PIL import Image",
        "src, dst, n, cell, ms = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])",
        "img = Image.open(src).convert('RGB')",
        "frames = [img.crop((i * cell, 0, (i + 1) * cell, cell)) for i in range(n)]",
        "frames[0].save(dst, save_all=True, append_images=frames[1:], duration=ms, loop=0, quality=82, method=6)",
      ].join("\n"),
      join(dir, "walk-sheet.png"),
      join(dir, "walk.webp"),
      String(WALK_FRAMES),
      String(CELL),
      String(Math.round((duration * 1000) / WALK_FRAMES)),
    ],
    { encoding: "utf8" },
  );
  if (webp.status !== 0) throw new Error(`webp: ${webp.stderr}`);
  const ids = Object.keys(clips);
  const at = (id: string) =>
    Array.from({ length: METRIC_FRAMES }, (_, i) => ({ clip: id, time: clips[id]!.loop ? (clips[id]!.duration * i) / METRIC_FRAMES : (clips[id]!.duration * i) / (METRIC_FRAMES - 1) }));
  const metricSheet = await renderer.renderRig({
    rig: shown,
    direction: DIRECTION,
    clips,
    frames: [{ clip: null, time: 0 }, ...ids.flatMap(at)],
    cellWidth: METRIC_CELL,
    cellHeight: METRIC_CELL,
    columns: METRIC_FRAMES,
    background: null,
  });
  const metrics = sheetMetrics(decodePng(metricSheet.png), { width: METRIC_CELL, height: METRIC_CELL }, METRIC_FRAMES, ids, METRIC_FRAMES);
  return { animated: clip, animDuration: duration, anim: metrics, warnings: [...still.warnings, ...sheet.warnings] };
}

/** Round 4's likeness to the concept: silhouette, colour, interior detail, blurred colour; plus round 3's aspect. */
async function likenessTo(rig: Rig, conceptPng: Buffer) {
  const rest = await renderer.renderRig({ rig, direction: DIRECTION, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: 512, cellHeight: 512, columns: 1, background: null });
  const drawn = cropOpaque(decodePng(rest.png));
  const cut = cutCharacter(decodePng(conceptPng));
  if (!drawn || !cut) return null;
  const figure = cropOpaque(cut.image)!;
  const H = 256;
  const W = Math.max(8, Math.round((figure.width / figure.height) * H));
  const a = flatten(resize(drawn, W, H), BACKGROUND);
  const b = flatten(resize(figure, W, H), BACKGROUND);
  const m = matchScore(a, b, BACKGROUND);
  return {
    silhouette: round3n(m.silhouette),
    color: round3n(m.color),
    detail: round3n(gradient(a, BACKGROUND) / Math.max(1e-6, gradient(b, BACKGROUND))),
    colorBlurred: round3n(matchScore(blur(a, 4), blur(b, 4), BACKGROUND).color),
    aspect: round3n(drawn.width / drawn.height / (figure.width / figure.height)),
  };
}

function gradient(img: Pixels, background: string): number {
  const bg = [parseInt(background.slice(1, 3), 16), parseInt(background.slice(3, 5), 16), parseInt(background.slice(5, 7), 16)];
  const solid = (i: number) => Math.hypot(img.data[i * 4]! - bg[0]!, img.data[i * 4 + 1]! - bg[1]!, img.data[i * 4 + 2]! - bg[2]!) > 24;
  let sum = 0;
  let n = 0;
  for (let y = 1; y < img.height - 1; y++)
    for (let x = 1; x < img.width - 1; x++) {
      const i = y * img.width + x;
      if (!solid(i) || !solid(i + 1) || !solid(i + img.width)) continue;
      let g = 0;
      for (let c = 0; c < 3; c++) g += Math.abs(img.data[(i + 1) * 4 + c]! - img.data[i * 4 + c]!) + Math.abs(img.data[(i + img.width) * 4 + c]! - img.data[i * 4 + c]!);
      sum += g;
      n++;
    }
  return n ? sum / n : 0;
}

function blur(img: Pixels, r: number): Pixels {
  const data = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const nx = Math.min(img.width - 1, Math.max(0, x + dx));
          const ny = Math.min(img.height - 1, Math.max(0, y + dy));
          for (let c = 0; c < 4; c++) acc[c]! += img.data[(ny * img.width + nx) * 4 + c]!;
          n++;
        }
      for (let c = 0; c < 4; c++) data[(y * img.width + x) * 4 + c] = Math.round(acc[c]! / n);
    }
  return { width: img.width, height: img.height, data };
}

function cropOpaque(img: Pixels): Pixels | null {
  let [x0, y0, x1, y1] = [img.width, img.height, -1, -1];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]! >= 128) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  if (x1 < 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data };
}

function resize(img: Pixels, W: number, H: number): Pixels {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1.001, Math.max(0, ((x + 0.5) * img.width) / W - 0.5));
      const sy = Math.min(img.height - 1.001, Math.max(0, ((y + 0.5) * img.height) / H - 0.5));
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const acc = [0, 0, 0, 0];
      for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]] as const) {
        const o = ((iy + dy) * img.width + ix + dx) * 4;
        const al = img.data[o + 3]! / 255;
        for (let c = 0; c < 3; c++) acc[c]! += w * img.data[o + c]! * al;
        acc[3]! += w * al;
      }
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = acc[3]! > 0 ? Math.round(acc[c]! / acc[3]!) : 0;
      data[o + 3] = Math.round(acc[3]! * 255);
    }
  }
  return { width: W, height: H, data };
}

// --- main ---------------------------------------------------------------------------------------------

try {
  const all = JSON.parse(readFileSync(join(round3, "subjects.json"), "utf8")) as Subject[];
  const list = all.filter((s) => !wantedSubjects || wantedSubjects.includes(s.id));
  const arms = ARMS.filter((a) => wantedArms.includes(a.id));
  if (arms.length !== 1) throw new Error(`no arm ${wantedArms.join(",")}`);
  writeFileSync(join(out, "arms.json"), JSON.stringify(ARMS.map(({ id, what, model }) => ({ id, what, model })), null, 1));
  writeFileSync(join(out, "subjects.json"), JSON.stringify(all, null, 1));
  for (const s of list) {
    for (const arm of arms) {
      try {
        await runArm(s, arm);
      } catch (error) {
        console.error(`${s.id} ${arm.id} failed: ${error instanceof Error ? error.stack : String(error)}`);
        mkdirSync(join(out, s.id, arm.id), { recursive: true });
        writeFileSync(join(out, s.id, arm.id, "error.txt"), error instanceof Error ? (error.stack ?? error.message) : String(error));
      }
    }
  }
} finally {
  await renderer.close();
}
