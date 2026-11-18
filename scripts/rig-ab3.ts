/**
 * Rig strategy A/B, round 3: concept-to-rig strategies on the same subjects, for a blind vote.
 *   node scripts/rig-ab3.ts <out-dir> [--subjects player,guard,...] [--arms control,ready,...] [--concepts-only] [--budget 1] [--player-project project.json]
 * The player subject's brief is read (read only) from --player-project (default projects/default/project.json, its player_look).
 * Images (concept sheets, flat redraws, parts sheets) are real OpenRouter calls (OPENROUTER_API_KEY
 * from .env, never printed); every call is cached under <out>/cache by prompt and references (a
 * rerun pays nothing) and logged to <out>/costs.jsonl; a call that could take the ledger past
 * --budget (USD, default 1) is refused. Vision (picks, plans, critiques, clips) runs on the local
 * Claude Code login (free). Arms that share a stage share its output: every arm but the control
 * starts from the same rig-ready concept, and the flat arms from the same flat redraw.
 * Writes per subject and arm: <out>/<subject>/<arm>/{concept.png, design.png, still.png, walk.webp,
 * rig.json, log.txt, result.json}; `node scripts/rig-ab3-page.ts <out>` makes results.json and the vote page.
 * Arms: see ARMS. Several processes may run different arms at once (after --concepts-only).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyBatch,
  createDefaultProject,
  newEnemyCharacter,
  rigBounds,
  type Character,
  type CharacterAsset,
  type ClipSlot,
  type FileRef,
  type OperationCall,
  type ProjectSpec,
  type Rig,
} from "@anomaly/core";
import {
  animate,
  buildRig,
  chooseConcept,
  cutCharacter,
  decodePng,
  encodePng,
  flatten,
  generateConcepts,
  matchScore,
  OpenRouterImageModel,
  redrawFlat,
  sheetMetrics,
  type ArtContext,
  type ImageModel,
  type Pixels,
  type RigInput,
  type StageResult,
} from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";
import { ClaudeCodeVisionModel } from "../packages/server/src/art/claudeCodeVision.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// --- subjects and arms -----------------------------------------------------------------

interface Subject {
  id: string;
  name: string;
  brief: string;
  kind: "player" | "enemy";
  size: { width: number; height: number };
}

/** The creator's player brief is read from its project (read only); the others are generic. */
const playerProject = () => JSON.parse(readFileSync(flag("--player-project") ?? join(root, "projects/default/project.json"), "utf8")) as ProjectSpec;
/** Every subject uses the creator's art direction (palette, ink), read from the same project. */
const DIRECTION = (() => {
  try {
    return playerProject().art.direction;
  } catch {
    return createDefaultProject().art.direction;
  }
})();

function subjects(): Subject[] {
  const project = playerProject();
  const look = project.art.assets.find((a) => a.id === "player_look");
  return [
    { id: "player", name: "Player", brief: look?.brief ?? "a young hero", kind: "player", size: { width: 28, height: 44 } },
    {
      id: "guard",
      name: "Guard",
      brief: "a stocky armoured guard in heavy dented plate armour, a round helmet with a visor slit, broad shoulders, thick arms and short sturdy legs",
      kind: "enemy",
      size: { width: 40, height: 46 },
    },
    {
      id: "wanderer",
      name: "Wanderer",
      brief: "a tall, very thin wanderer in a long dark coat that reaches the ankles, a wide-brimmed hat, a pale narrow face and long thin arms",
      kind: "enemy",
      size: { width: 24, height: 54 },
    },
    {
      id: "beast",
      name: "Beast",
      brief: "a lean four-legged beast with a bristly mane along its back, short tusks, long thin legs and a long whip-like tail",
      kind: "enemy",
      size: { width: 58, height: 34 },
    },
  ];
}

type ConceptKind = "default" | "ready";
interface Arm {
  id: string;
  what: string;
  concept: ConceptKind;
  flat: boolean;
  rig: Omit<RigInput, "characterId">;
  limbJoints: boolean;
}

export const ARMS: Arm[] = [
  { id: "control", what: "today's pipeline: default concept and pick, traced rig", concept: "default", flat: false, rig: { rigMode: "traced" }, limbJoints: false },
  {
    id: "ready",
    what: "rig-ready concept (neutral pose, distinct colours, whole figure, main figure only), elbows and knees (joint-local motion limits), today's tracer",
    concept: "ready",
    flat: false,
    rig: { rigMode: "traced", limbJoints: true },
    limbJoints: true,
  },
  {
    id: "ready-clean",
    what: "rig-ready concept, elbows and knees (joint-local limits), the clean tracer with feature points and a look-and-fix review",
    concept: "ready",
    flat: false,
    rig: { rigMode: "traced", limbJoints: true, cleanTrace: true, review: true },
    limbJoints: true,
  },
  {
    id: "flat-clean",
    what: "rig-ready concept redrawn as flat art (one image edit), elbows and knees (joint-local limits), the clean tracer with review",
    concept: "ready",
    flat: true,
    rig: { rigMode: "traced", limbJoints: true, cleanTrace: true, review: true },
    limbJoints: true,
  },
  {
    id: "puppet",
    what: "rig-ready concept redrawn flat, then a parts sheet (one image edit) traced and assembled on the design's joints (joint-local limits)",
    concept: "ready",
    flat: true,
    rig: { rigMode: "traced", puppet: true, rounds: 3, sheetQuality: "medium" },
    limbJoints: true,
  },
  {
    id: "vector-loop",
    what: "rig-ready concept redrawn flat, Opus draws a vector rig with elbows and knees and fixes it over 4 render-and-compare rounds",
    concept: "ready",
    flat: true,
    rig: { rigMode: "vector", limbJoints: true, rounds: 4 },
    limbJoints: true,
  },
];

const SLOTS: ClipSlot[] = ["idle", "walk"];
/** The flat redraw is an edit of the chosen design: medium quality keeps it closer to the design (low drifts in colour and face). */
const FLAT_QUALITY = "medium";
const BACKGROUND = "#d8d6cf";

// --- arguments, environment ---------------------------------------------------------------

const args = process.argv.slice(2);
const out: string = args[0] ?? "";
if (!out || out.startsWith("--")) throw new Error("usage: node scripts/rig-ab3.ts <out-dir> [--subjects a,b] [--arms a,b] [--concepts-only] [--budget 1]");
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const BUDGET = Number(flag("--budget") ?? 1);
const wantedSubjects = flag("--subjects")?.split(",");
const wantedArms = flag("--arms")?.split(",");
mkdirSync(join(out, "cache"), { recursive: true });

const env: Record<string, string | undefined> = { ...process.env };
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env
}
const apiKey = env.OPENROUTER_API_KEY?.trim();
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (.env)");

// --- the image model: cached, ledgered, capped ------------------------------------------------

const LEDGER = join(out, "costs.jsonl");
/** A generous guess for one more image call (an edit with a reference costs more than a sheet). */
const CALL_RESERVE = 0.03;
const spentSoFar = () =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce((s, l) => s + (JSON.parse(l) as { cost: number }).cost, 0)
    : 0;

const real = new OpenRouterImageModel({ apiKey }, env.STUDIO_ART_IMAGE_MODEL ?? "openai/gpt-image-1-mini", { quality: env.STUDIO_ART_IMAGE_QUALITY ?? "low" });
function cachedImages(label: () => string): ImageModel {
  return {
    id: real.id,
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
        // Cached: paid for once (that call is in the ledger); the stage still reports what it costs a creator.
        return { image: readFileSync(file), ext: m.ext, usage: { cost: m.cost, promptTokens: 0, completionTokens: 0 }, model: `${m.model} (cached)` };
      }
      const spent = spentSoFar();
      if (spent + CALL_RESERVE > BUDGET) throw new Error(`image budget: $${spent.toFixed(4)} spent of $${BUDGET}; refusing another call (${label()})`);
      const t0 = Date.now();
      const result = await real.generate(request);
      writeFileSync(file, result.image);
      writeFileSync(meta, JSON.stringify({ model: result.model, ext: result.ext, cost: result.usage.cost, prompt: request.prompt, references: request.references?.length ?? 0 }));
      appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), what: label(), model: result.model, references: request.references?.length ?? 0, cost: result.usage.cost, ms: Date.now() - t0, key })}\n`);
      console.log(`  image: ${label()} $${result.usage.cost.toFixed(4)} (total $${(spent + result.usage.cost).toFixed(4)})`);
      return result;
    },
  };
}

// --- an in-memory project per run -------------------------------------------------------------

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
const vision = new ClaudeCodeVisionModel();

function characterFor(subject: Subject): Character {
  const base = createDefaultProject();
  if (subject.kind === "player") return { ...base.characters.find((c) => c.kind === "player")!, size: subject.size };
  return { ...newEnemyCharacter(subject.id, subject.name), size: subject.size };
}

/** A project holding just this subject's character, and a context logging to `logPath`. */
function session(subject: Subject, logPath: string, what: () => string) {
  let project: ProjectSpec = createDefaultProject();
  project = { ...project, art: { ...project.art, direction: DIRECTION } };
  const character = characterFor(subject);
  project = { ...project, characters: [...project.characters.filter((c) => c.id !== character.id), character] };
  const lines: string[] = [];
  let spent = 0;
  const ctx: ArtContext = {
    project: () => project,
    image: cachedImages(what),
    vision,
    renderer,
    files: store,
    log: (a) => {
      const line = `${new Date().toISOString().slice(11, 19)} ${a.text}${a.cost ? ` ($${a.cost.toFixed(4)})` : ""}`;
      lines.push(line);
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
  return { ctx, commit, asset, character, spent: () => spent, project: () => project };
}

// --- shared stages (cached on disk) --------------------------------------------------------------

/** The subject's concept sheet and chosen design for a concept kind (made once). */
async function concept(subject: Subject, kind: ConceptKind): Promise<{ sheet: Buffer; chosen: Buffer; cost: number }> {
  const dir = join(out, subject.id, `concept-${kind}`);
  mkdirSync(dir, { recursive: true });
  const done = join(dir, "meta.json");
  if (existsSync(done)) {
    return { sheet: readFileSync(join(dir, "sheet.png")), chosen: readFileSync(join(dir, "chosen.png")), cost: (JSON.parse(readFileSync(done, "utf8")) as { cost: number }).cost };
  }
  const s = session(subject, join(dir, "log.txt"), () => `${subject.id} concept sheet (${kind})`);
  const rigReady = kind === "ready";
  s.commit(await generateConcepts(s.ctx, { characterId: s.character.id, brief: subject.brief, rigReady }));
  s.commit(await chooseConcept(s.ctx, { characterId: s.character.id, rigReady }));
  const a = s.asset()!;
  const sheet = await store.get(a.concepts.at(-1)!.file);
  const chosen = await store.get(a.chosen!.file);
  writeFileSync(join(dir, "sheet.png"), sheet);
  writeFileSync(join(dir, "chosen.png"), chosen);
  writeFileSync(done, JSON.stringify({ cost: s.spent(), cell: a.chosen!.cell, recommended: a.concepts.at(-1)!.recommended ?? null, prompt: a.concepts.at(-1)!.prompt }, null, 1));
  console.log(`${subject.id}: ${kind} concept, cell ${a.chosen!.cell}, $${s.spent().toFixed(4)}`);
  return { sheet, chosen, cost: s.spent() };
}

/** The rig-ready design redrawn as flat art (made once). */
async function flat(subject: Subject): Promise<{ design: Buffer; cost: number }> {
  const dir = join(out, subject.id, "flat");
  mkdirSync(dir, { recursive: true });
  const done = join(dir, "meta.json");
  if (existsSync(done)) return { design: readFileSync(join(dir, "design.png")), cost: (JSON.parse(readFileSync(done, "utf8")) as { cost: number }).cost };
  const ready = await concept(subject, "ready");
  const s = session(subject, join(dir, "log.txt"), () => `${subject.id} flat redraw`);
  await seed(s, ready.sheet, ready.chosen, subject.brief);
  s.commit(await redrawFlat(s.ctx, { characterId: s.character.id, quality: FLAT_QUALITY }));
  const design = await store.get(s.asset()!.chosen!.file);
  writeFileSync(join(dir, "design.png"), design);
  writeFileSync(done, JSON.stringify({ cost: s.spent() }, null, 1));
  console.log(`${subject.id}: flat redraw, $${s.spent().toFixed(4)}`);
  return { design, cost: s.spent() };
}

/** Give the session's character an asset whose chosen design is `chosen`. */
async function seed(s: ReturnType<typeof session>, sheet: Buffer, chosen: Buffer, b: string) {
  const sheetRef = await store.put(sheet, "png");
  const chosenRef = await store.put(chosen, "png");
  s.commit({
    operations: [
      { name: "createAsset", input: { asset: { id: "look", name: "Look", kind: "character", brief: b }, assignTo: s.character.id } },
      { name: "addConcept", input: { assetId: "look", concept: { file: sheetRef, prompt: b, model: "given", cost: 0, at: new Date().toISOString() } } },
      { name: "chooseConcept", input: { assetId: "look", sheet: 0, cell: 0, file: chosenRef } },
    ],
    summary: "seeded the design",
  });
}

// --- one arm ---------------------------------------------------------------------------------------

async function runArm(subject: Subject, arm: Arm) {
  const dir = join(out, subject.id, arm.id);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, "result.json"))) {
    console.log(`${subject.id} ${arm.id}: done already`);
    return;
  }
  const t0 = Date.now();
  const c = await concept(subject, arm.concept);
  const f = arm.flat ? await flat(subject) : null;
  const s = session(subject, join(dir, "log.txt"), () => `${subject.id} ${arm.id}`);
  await seed(s, c.sheet, f ? f.design : c.chosen, subject.brief);
  writeFileSync(join(dir, "concept.png"), c.chosen);
  writeFileSync(join(dir, "design.png"), f ? f.design : c.chosen);
  const built = await buildRig(s.ctx, { characterId: s.character.id, ...arm.rig });
  s.commit(built);
  if (built.plan) writeFileSync(join(dir, "plan.json"), JSON.stringify(built.plan, null, 1));
  s.commit(await animate(s.ctx, { characterId: s.character.id, slots: SLOTS, limbJoints: arm.limbJoints, jointLimits: arm.limbJoints }));
  const a = s.asset()!;
  writeFileSync(join(dir, "rig.json"), JSON.stringify({ rig: a.rig, clips: a.clips, preview: a.preview }, null, 1));
  const media = await renderMedia(dir, a.rig!, a.clips, s.project().art.direction);
  const likeness = await likenessTo(a.rig!, c.chosen, s.project().art.direction);
  const sharedCost = c.cost + (f?.cost ?? 0);
  const result = {
    subject: subject.id,
    arm: arm.id,
    what: arm.what,
    seconds: Math.round((Date.now() - t0) / 1000),
    cost: { shared: round4(sharedCost), arm: round4(s.spent()), total: round4(sharedCost + s.spent()) },
    match: a.preview?.match ?? null,
    likeness,
    score: a.preview?.score ?? null,
    notes: a.preview?.notes ?? "",
    counts: counts(a.rig!),
    clips: Object.keys(a.clips),
    ...media,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
  console.log(`${subject.id} ${arm.id}: match ${JSON.stringify(result.match)} likeness ${JSON.stringify(likeness)} ${result.counts.pieces} pieces ${result.counts.details} details, ${result.seconds}s`);
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const round3 = (n: number) => Math.round(n * 1e3) / 1e3;

/** Bones, pieces (base shapes), colour details, outline points. */
function counts(rig: Rig) {
  const detail = (id: string) => /_d\d+$/.test(id);
  const ink = (id: string) => /_ink$/.test(id);
  const pieces = rig.mode === "traced" ? rig.parts.filter((p) => !detail(p.id) && !ink(p.id)).length : rig.parts.length;
  const points = rig.parts.reduce((s, p) => s + ("points" in p.shape ? p.shape.points.length : 0), 0);
  return { bones: rig.bones.length, parts: rig.parts.length, pieces, details: rig.parts.filter((p) => detail(p.id)).length, points };
}

/** An invisible box a little larger than the rest pose, so every frame is fitted the same and moves stay in view. */
function framed(rig: Rig): Rig {
  const b = rigBounds(rig);
  const [cx, cy, hw, hh] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0.62 * (b.maxX - b.minX), 0.54 * (b.maxY - b.minY)];
  const half = Math.max(hw, hh * 0.75);
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
const CELL = 320;
const METRIC_FRAMES = 12;
const METRIC_CELL = 384;

/** Still (rest pose), the walk (or idle) loop as an animated WebP, and animation metrics. */
async function renderMedia(dir: string, rig: Rig, clips: Record<string, import("@anomaly/core").Clip>, direction: ProjectSpec["art"]["direction"]) {
  const shown = framed(rig);
  const clip = clips.walk ? "walk" : clips.idle ? "idle" : Object.keys(clips)[0]!;
  const still = await renderer.renderRig({ rig: shown, direction, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: CELL, cellHeight: CELL, columns: 1, background: BACKGROUND });
  writeFileSync(join(dir, "still.png"), still.png);
  const duration = clips[clip]!.duration;
  const sheet = await renderer.renderRig({
    rig: shown,
    direction,
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
  // Metrics (rig-anim-metrics): holes, seams, debris and slivers per frame against the rest pose, per mille.
  const ids = Object.keys(clips);
  const at = (id: string) =>
    Array.from({ length: METRIC_FRAMES }, (_, i) => ({ clip: id, time: clips[id]!.loop ? (clips[id]!.duration * i) / METRIC_FRAMES : (clips[id]!.duration * i) / (METRIC_FRAMES - 1) }));
  const metricSheet = await renderer.renderRig({
    rig: shown,
    direction,
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

/**
 * Likeness to the concept the arm started from, fair across arms whose rig was built on another
 * image (a flat redraw): the rest pose and the concept's figure, each cut to its own box and
 * scaled to the same size, compared by match.ts (silhouette overlap, colour where both are drawn).
 */
async function likenessTo(rig: Rig, conceptPng: Buffer, direction: ProjectSpec["art"]["direction"]) {
  const rest = await renderer.renderRig({ rig, direction, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: 512, cellHeight: 512, columns: 1, background: null });
  const drawn = cropOpaque(decodePng(rest.png));
  const cut = cutCharacter(decodePng(conceptPng));
  if (!drawn || !cut) return null;
  const figure = cropOpaque(cut.image)!;
  const H = 256;
  const W = Math.max(8, Math.round((figure.width / figure.height) * H));
  const a = flatten(resize(drawn, W, H), BACKGROUND);
  const b = flatten(resize(figure, W, H), BACKGROUND);
  const m = matchScore(a, b, BACKGROUND);
  return { silhouette: round3(m.silhouette), color: round3(m.color), aspect: round3(drawn.width / drawn.height / (figure.width / figure.height)) };
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

/** Bilinear resize (premultiplied alpha). */
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
  const list = subjects().filter((s) => !wantedSubjects || wantedSubjects.includes(s.id));
  const arms = ARMS.filter((a) => !wantedArms || wantedArms.includes(a.id));
  writeFileSync(join(out, "arms.json"), JSON.stringify(ARMS.map(({ id, what }) => ({ id, what })), null, 1));
  writeFileSync(join(out, "subjects.json"), JSON.stringify(subjects(), null, 1));
  if (args.includes("--media-only")) {
    // Re-render the still, the loop and the metrics of finished arms from their saved rigs (no model calls).
    for (const s of list) {
      for (const arm of arms) {
        const dir = join(out, s.id, arm.id);
        if (!existsSync(join(dir, "result.json"))) continue;
        const saved = JSON.parse(readFileSync(join(dir, "rig.json"), "utf8")) as { rig: Rig; clips: Record<string, import("@anomaly/core").Clip> };
        const direction = DIRECTION;
        const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Record<string, unknown>;
        const media = await renderMedia(dir, saved.rig, saved.clips, direction);
        const likeness = await likenessTo(saved.rig, readFileSync(join(dir, "concept.png")), direction);
        writeFileSync(join(dir, "result.json"), JSON.stringify({ ...result, ...media, likeness, counts: counts(saved.rig) }, null, 1));
        console.log(`${s.id} ${arm.id}: media again`);
      }
    }
  } else if (args.includes("--concepts-only")) {
    for (const s of list) {
      if (arms.some((a) => a.concept === "default")) await concept(s, "default");
      if (arms.some((a) => a.concept === "ready")) await concept(s, "ready");
      if (arms.some((a) => a.flat)) await flat(s);
    }
  } else {
    for (const s of list) {
      for (const arm of arms) {
        try {
          await runArm(s, arm);
        } catch (error) {
          console.error(`${s.id} ${arm.id} failed: ${error instanceof Error ? error.stack : String(error)}`);
          writeFileSync(join(out, s.id, arm.id, "error.txt"), error instanceof Error ? (error.stack ?? error.message) : String(error));
        }
      }
    }
  }
} finally {
  await renderer.close();
}
console.log(`image spend so far: $${spentSoFar().toFixed(4)} of $${BUDGET}`);
