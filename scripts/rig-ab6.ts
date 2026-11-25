/**
 * Rig A/B, round 6: three ways from a concept to an animated rig, compared blind.
 *   node scripts/rig-ab6.ts <out-dir> [--subjects player,troll,turret] [--arms cutout,projected,layered] [--budget 0.5] [--project <dir>]
 * Arms (see ARMS): cutout (today's: pieces of the 512 px design on bones), projected (the vector
 * pipeline's rig wearing the design's own pixels per part, dress.ts projectedLook), layered (part
 * layers at the sheet's full resolution, hidden stretches painted in by one image edit, each layer
 * on a bending triangle mesh).
 * Subjects: the user's player design (read only from <project> (default projects/default): its
 * player_look asset's chosen design and sheet are copied into <out>/player/source), and two new
 * Seedream 5.5 concept sheets (a creature, an object) drawn with the concepts stage. Every arm of a
 * subject starts from the same chosen design; each arm writes its own clips with the same clip
 * requests (idle + walk; the object: idle + fire).
 * Images are real OpenRouter calls (OPENROUTER_API_KEY from .env, never printed) on the art
 * direction's image model (Seedream 5.5; requests it can't take go to gpt-image-1-mini, like the
 * studio), cached under <out>/cache by prompt and references and logged to <out>/costs.jsonl; a
 * call that could take the ledger past --budget (USD, default 0.50) is refused. Vision runs on the
 * local Claude Code login (free).
 * Writes <out>/<subject>/<arm>/{concept.png, closeup.png, still.png, idle.webp, walk.webp|fire.webp,
 * rig.json, result.json, log.txt, atlas/source images}; `node scripts/rig-ab6-page.ts <out>` makes the page.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBatch, createDefaultProject, rigFiles, type CharacterAsset, type Clip, type FileRef, type OperationCall, type ProjectSpec, type Rig } from "@anomaly/core";
import {
  animate,
  buildRig,
  chooseConcept,
  cutCharacter,
  decodePng,
  flatten,
  generateConcepts,
  look,
  nativeDesign,
  matchScore,
  OpenRouterImageModel,
  pngSize,
  type ArtContext,
  type ImageModel,
  type ImageRequest,
  type CutoutPlan,
  type Pixels,
  type VisionModel,
  type VisionRequest,
} from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";
import { ClaudeCodeVisionModel } from "../packages/server/src/art/claudeCodeVision.ts";
import { IMAGE_MODEL_PARAMS } from "../packages/server/src/art/config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

interface Arm {
  id: "cutout" | "projected" | "layered";
  what: string;
}
export const ARMS: Arm[] = [
  { id: "cutout", what: "today's cutout: the 512 px design cut into pieces on bones (the cutout plan and critique), pieces rigid, 2 px overlap at the joints" },
  { id: "projected", what: "the vector pipeline's rig (elbows and knees, render-and-compare rounds; no flat redraw, to keep within the image budget), each part wearing the design's own pixels (dress.ts projectedLook)" },
  { id: "layered", what: "layered: part layers at the sheet's full resolution, hidden stretches painted in by one image edit, each layer on a triangle mesh bending across its joint" },
];

interface Subject {
  id: string;
  name: string;
  brief: string;
  kind: "player" | "creature" | "object";
  /** Clips every arm writes: name -> direction (null: the slot's own). */
  clips: Record<string, string | null>;
}
const SUBJECTS: Subject[] = [
  { id: "player", name: "Player", kind: "player", brief: "", clips: { idle: null, walk: null } },
  { id: "troll", name: "Moss Troll", kind: "creature", brief: "a hulking moss-covered stone troll with a club arm", clips: { idle: null, walk: null } },
  {
    id: "turret",
    name: "Clockwork Turret",
    kind: "object",
    brief: "a brass clockwork turret on a tripod",
    clips: { idle: "idle: gears tick, the barrel sways a little, the tripod stays planted (loops)", fire: "fire: the barrel recoils back hard and returns, the body jolts, the tripod braces (plays once)" },
  },
];

const IMAGE_MODEL = "bytedance-seed/seedream-5-5";
const FALLBACK_MODEL = "openai/gpt-image-1-mini";
const BACKGROUND = "#d8d6cf";

// --- arguments, environment ---------------------------------------------------------------

const args = process.argv.slice(2);
const out = args[0] ?? "";
if (!out || out.startsWith("--")) throw new Error("usage: node scripts/rig-ab6.ts <out-dir> [--subjects a,b] [--arms a,b] [--budget 0.5] [--project <dir>]");
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const BUDGET = Number(flag("--budget") ?? 0.5);
const wantedSubjects = flag("--subjects")?.split(",");
const wantedArms = flag("--arms")?.split(",");
const userProject = flag("--project") ?? join(root, "projects/default");
const from = flag("--from");
mkdirSync(join(out, "cache"), { recursive: true });
mkdirSync(join(out, "files"), { recursive: true });

const env: Record<string, string | undefined> = { ...process.env };
for (const file of [join(root, ".env")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
const apiKey = env.OPENROUTER_API_KEY?.trim();

// --- images: the direction's model (with the studio's fallback), cached, ledgered, capped -----------

const LEDGER = join(out, "costs.jsonl");
/** A generous guess for one more Seedream call (an edit with two references costs ~$0.045). */
const CALL_RESERVE = 0.05;
const spentSoFar = () =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce((s, l) => s + (JSON.parse(l) as { cost: number }).cost, 0)
    : 0;

const seedream = apiKey ? new OpenRouterImageModel({ apiKey }, IMAGE_MODEL, {}, IMAGE_MODEL_PARAMS[IMAGE_MODEL]) : null;
const fallback = apiKey ? new OpenRouterImageModel({ apiKey }, FALLBACK_MODEL, { quality: "low" }, IMAGE_MODEL_PARAMS[FALLBACK_MODEL]) : null;

function cachedImages(label: () => string, spent: (cost: number) => void): ImageModel {
  return {
    id: IMAGE_MODEL,
    accepts: () => true,
    async generate(request: ImageRequest) {
      const model = seedream && (seedream.accepts?.(request) ?? true) ? seedream : fallback;
      const key = createHash("sha256")
        .update(model?.id ?? "none")
        .update(request.prompt)
        .update(request.quality ?? "")
        .update(request.transparent ? "t" : "")
        .update(JSON.stringify(request.references?.map((r) => createHash("sha256").update(r).digest("hex")) ?? []))
        .digest("hex")
        .slice(0, 24);
      const file = join(out, "cache", `${key}.img`);
      const meta = join(out, "cache", `${key}.json`);
      if (existsSync(file) && existsSync(meta)) {
        const m = JSON.parse(readFileSync(meta, "utf8")) as { model: string; ext: "png" | "jpg" | "webp"; cost: number };
        spent(m.cost);
        return { image: readFileSync(file), ext: m.ext, usage: { cost: m.cost, promptTokens: 0, completionTokens: 0 }, model: `${m.model} (cached)` };
      }
      if (!model) throw new Error("OPENROUTER_API_KEY is not set (.env)");
      const before = spentSoFar();
      if (before + CALL_RESERVE > BUDGET) throw new Error(`image budget: $${before.toFixed(4)} spent of $${BUDGET}; refusing another call (${label()})`);
      const t0 = Date.now();
      const result = await model.generate(request);
      writeFileSync(file, result.image);
      writeFileSync(meta, JSON.stringify({ model: result.model, ext: result.ext, cost: result.usage.cost, prompt: request.prompt, references: request.references?.length ?? 0 }));
      appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), what: label(), model: result.model, references: request.references?.length ?? 0, cost: result.usage.cost, ms: Date.now() - t0, key })}\n`);
      console.log(`  image: ${label()} ${result.model} $${result.usage.cost.toFixed(4)} (total $${(before + result.usage.cost).toFixed(4)})`);
      spent(result.usage.cost);
      return result;
    },
  };
}

// --- files, renderer, vision ---------------------------------------------------------------

const store = {
  async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
    const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
    const path = join(out, "files", ref);
    if (!existsSync(path)) writeFileSync(path, data);
    return ref;
  },
  async get(ref: FileRef): Promise<Buffer> {
    return readFileSync(join(out, "files", ref));
  },
};
const renderer = new BrowserRenderer(join(root, "apps/studio/public/game"));
const claude = new ClaudeCodeVisionModel();
mkdirSync(join(out, "vision-cache"), { recursive: true });
/** Vision replies cached by request (text and images), so a rerun takes the same plans (and hits the image cache). */
const vision: VisionModel = {
  id: claude.id,
  async complete(request: VisionRequest) {
    const h = createHash("sha256").update(request.system);
    for (const turn of [...(request.history ?? []).map((t) => (typeof t.content === "string" ? [{ type: "text" as const, text: t.content }] : t.content)), request.content])
      for (const c of turn) h.update(c.type === "text" ? c.text : createHash("sha256").update(c.image).digest("hex"));
    const file = join(out, "vision-cache", `${h.digest("hex").slice(0, 24)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Awaited<ReturnType<VisionModel["complete"]>>;
    const reply = await claude.complete(request);
    writeFileSync(file, JSON.stringify(reply));
    return reply;
  },
};

/** A project holder with a log and image spend, for one subject's setup or one arm. */
function context(start: ProjectSpec, logPath: string, what: () => string) {
  let project = start;
  const lines: string[] = [];
  let images = 0;
  const ctx: ArtContext = {
    project: () => project,
    image: cachedImages(what, (c) => (images += c)),
    vision,
    renderer,
    files: store,
    log: (a) => {
      lines.push(`${new Date().toISOString().slice(11, 19)} ${a.text}${a.cost ? ` ($${a.cost.toFixed(4)})` : ""}${a.file ? ` [${a.file}]` : ""}`);
      writeFileSync(logPath, lines.join("\n"));
    },
    remaining: () => 5,
    spend: () => {},
  };
  const commit = (operations: OperationCall[]) => {
    const result = applyBatch(project, operations);
    if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues).slice(0, 600)}`);
    project = result.project;
  };
  return { ctx, commit, project: () => project, images: () => images };
}

/** The user's art direction (read only), so every subject is drawn in the project's look. */
function userDirection() {
  const p = JSON.parse(readFileSync(join(userProject, "project.json"), "utf8")) as { spec?: ProjectSpec } & ProjectSpec;
  const spec = (p.spec ?? p) as ProjectSpec;
  return spec;
}

const ref = (s: Subject) => (s.kind === "object" ? { objectId: s.id } : { characterId: s.kind === "player" ? "player" : "charger" });
const assetOf = (project: ProjectSpec, s: Subject): CharacterAsset => {
  const id = s.kind === "object" ? s.id : project.characters.find((c) => c.id === ref(s).characterId)!.appearance!;
  return project.art.assets.find((a) => a.id === id) as CharacterAsset;
};

/** Each subject's starting project (its chosen design), made once and kept in <out>/<subject>/base.json. */
async function baseFor(s: Subject): Promise<{ project: ProjectSpec; cost: number }> {
  const dir = join(out, s.id);
  mkdirSync(dir, { recursive: true });
  const saved = join(dir, "base.json");
  if (existsSync(saved)) return JSON.parse(readFileSync(saved, "utf8")) as { project: ProjectSpec; cost: number };
  const user = userDirection();
  let start = createDefaultProject();
  start = { ...start, art: { ...start.art, direction: { ...user.art.direction, imageModel: IMAGE_MODEL } } };
  const h = context(start, join(dir, "setup-log.txt"), () => `${s.id} concept`);
  if (s.kind === "player") {
    const asset = user.art.assets.find((a) => a.id === "player_look") as CharacterAsset;
    const chosen = asset.chosen!;
    const sheet = asset.concepts[chosen.sheet]!;
    mkdirSync(join(dir, "source"), { recursive: true });
    for (const f of [sheet.file, chosen.original ?? chosen.file]) copyFileSync(join(userProject, "files", f), join(dir, "source", f));
    const sheetRef = await store.put(readFileSync(join(dir, "source", sheet.file)), "png");
    const chosenRef = await store.put(readFileSync(join(dir, "source", chosen.original ?? chosen.file)), "png");
    s.brief = asset.brief;
    h.commit([
      { name: "createAsset", input: { asset: { id: "player_look", name: "Player", kind: "character", brief: asset.brief }, assignTo: "player" } },
      { name: "addConcept", input: { assetId: "player_look", concept: { file: sheetRef, prompt: sheet.prompt, model: sheet.model, cost: sheet.cost, at: sheet.at } } },
      { name: "chooseConcept", input: { assetId: "player_look", sheet: 0, cell: chosen.cell, file: chosenRef } },
    ]);
  } else {
    if (s.kind === "object") h.commit([{ name: "createObject", input: { id: s.id, name: s.name, brief: s.brief } }]);
    h.commit((await generateConcepts(h.ctx, { ...ref(s), brief: s.brief, rigReady: true })).operations);
    h.commit((await chooseConcept(h.ctx, ref(s))).operations);
  }
  const base = { project: h.project(), cost: h.images() };
  writeFileSync(saved, JSON.stringify(base));
  return base;
}

async function runArm(s: Subject, arm: Arm, base: { project: ProjectSpec }) {
  const dir = join(out, s.id, arm.id);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const h = context(base.project, join(dir, "log.txt"), () => `${s.id} ${arm.id}`);
  const subject = ref(s);
  const start = assetOf(h.project(), s);
  let reuseClips: Record<string, Clip> | null = null;
  const design = await store.get(start.chosen!.original ?? start.chosen!.file);
  writeFileSync(join(dir, "concept.png"), design);
  if (arm.id === "cutout") h.commit((await buildRig(h.ctx, { ...subject, rigMode: "cutout" })).operations);
  else if (arm.id === "layered") {
    // --from <dir>: the plan (and clips) an earlier run settled on, built again without the critique.
    const earlier = from ? join(from, s.id, arm.id) : null;
    const plan = earlier && existsSync(join(earlier, "plan.json")) ? (JSON.parse(readFileSync(join(earlier, "plan.json"), "utf8")) as CutoutPlan) : undefined;
    const built = await buildRig(h.ctx, { ...subject, rigMode: "layered", ...(plan ? { plan } : {}) });
    if (built.plan) writeFileSync(join(dir, "plan.json"), JSON.stringify(built.plan, null, 1));
    h.commit(built.operations);
    if (earlier && plan) reuseClips = (JSON.parse(readFileSync(join(earlier, "rig.json"), "utf8")) as { clips: Record<string, Clip> }).clips;
  }
  else {
    h.commit((await buildRig(h.ctx, { ...subject, rigMode: "vector", detail: false, redraw: false })).operations);
    const asset = assetOf(h.project(), s);
    const canvas = pngSize(await store.get(asset.chosen!.file));
    const dressed = await look(h.ctx, { rig: asset.rig!, frame: asset.preview!.frame!, canvas, design, brief: asset.brief, ...(s.kind === "object" ? { object: true } : {}) }, { look: "projected" });
    h.commit([{ name: "setRig", input: { assetId: asset.id, rig: dressed.rig } }]);
  }
  const built = assetOf(h.project(), s);
  const rigSeconds = Math.round((Date.now() - t0) / 1000);
  // The same clip requests on every arm (or the earlier run's clips, on the same bones).
  if (reuseClips) {
    const id = assetOf(h.project(), s).id;
    h.commit(Object.entries(reuseClips).map(([name, clip]) => ({ name: "setClip", input: { assetId: id, clipId: name, clip } })));
  } else
    for (const [name, direction] of Object.entries(s.clips)) {
      h.commit((await animate(h.ctx, { ...subject, clips: [name], ...(direction ? { direction } : {}) })).operations);
    }
  const asset = assetOf(h.project(), s);
  const rig = asset.rig!;
  const clips = Object.fromEntries(Object.keys(s.clips).filter((n) => asset.clips[n]).map((n) => [n, asset.clips[n]!])) as Record<string, Clip>;
  writeFileSync(join(dir, "rig.json"), JSON.stringify({ rig, clips, preview: built.preview }, null, 1));
  const refs = rigFiles(rig);
  for (const r of refs) copyFileSync(join(out, "files", r), join(dir, r));
  const images = refs.length ? Object.fromEntries(await Promise.all(refs.map(async (r) => [r, (await store.get(r)).toString("base64")] as const))) : undefined;
  const direction = h.project().art.direction;
  const media = await renderMedia(dir, rig, clips, images, direction);
  const likeness = await likenessTo(rig, decodePng(design), images, direction);
  // Against the design at the sheet's own resolution too (the 512 px pick favours rigs cut from that very image).
  const native = await nativeDesign(h.ctx, start, decodePng(design));
  const likenessFull = native.k > 1 ? await likenessTo(rig, native.image, images, direction) : likeness;
  const atlas = rig.mode === "layered" ? decodePng(await store.get(rig.parts[0]!.texture!.file)) : null;
  const result = {
    subject: s.id,
    arm: arm.id,
    what: arm.what,
    seconds: Math.round((Date.now() - t0) / 1000),
    rigSeconds,
    cost: { images: Math.round(h.images() * 1e4) / 1e4 },
    likeness,
    likenessFull,
    nativeSize: native.image.width,
    pipelineMatch: built.preview?.match ?? null,
    score: built.preview?.score ?? null,
    counts: { bones: rig.bones.length, parts: rig.parts.length, textured: rig.parts.filter((p) => p.texture).length, meshes: rig.parts.filter((p) => p.shape.type === "mesh").length },
    atlas: atlas ? { width: atlas.width, height: atlas.height } : null,
    clips: Object.keys(clips),
    ...media,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
  console.log(`${s.id} ${arm.id}: likeness ${JSON.stringify(likeness)} full ${JSON.stringify(likenessFull)} pipeline ${JSON.stringify(result.pipelineMatch)} parts ${rig.parts.length} $${result.cost.images.toFixed(4)} ${result.seconds}s`);
}

const FRAMES = 16;
const CELL = 320;
const CLOSE = 512;

/** Close-up still, a smaller still, and each clip as an animated WebP. */
async function renderMedia(dir: string, rig: Rig, clips: Record<string, Clip>, images: Record<string, string> | undefined, direction: ProjectSpec["art"]["direction"]) {
  const extra = images ? { images } : {};
  const close = await renderer.renderRig({ rig, direction, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: CLOSE, cellHeight: CLOSE, columns: 1, background: BACKGROUND, ...extra });
  const m = Math.round(CLOSE * 0.12);
  writeFileSync(join(dir, "closeup.png"), await renderer.crop(close.png, { x: m / CLOSE, y: m / CLOSE, width: (CLOSE - 2 * m) / CLOSE, height: (CLOSE - 2 * m) / CLOSE }, CLOSE));
  const still = await renderer.renderRig({ rig, direction, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: CELL, cellHeight: CELL, columns: 1, background: BACKGROUND, ...extra });
  writeFileSync(join(dir, "still.png"), still.png);
  const warnings = [...close.warnings];
  for (const [name, clip] of Object.entries(clips)) {
    // The rig's rest-pose framing for every frame (a clip that moves the body stays in frame).
    const sheet = await renderer.renderRig({
      rig,
      direction,
      clips,
      frames: Array.from({ length: FRAMES }, (_, i) => ({ clip: name, time: clip.loop ? (clip.duration * i) / FRAMES : (clip.duration * i) / (FRAMES - 1) })),
      cellWidth: CELL,
      cellHeight: CELL,
      columns: FRAMES,
      background: BACKGROUND,
      ...extra,
    });
    warnings.push(...sheet.warnings);
    writeFileSync(join(dir, `${name}-sheet.png`), sheet.png);
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
          "frames[0].save(dst, save_all=True, append_images=frames[1:], duration=ms, loop=0, quality=88, method=6)",
        ].join("\n"),
        join(dir, `${name}-sheet.png`),
        join(dir, `${name}.webp`),
        String(FRAMES),
        String(CELL),
        String(Math.max(40, Math.round((clip.duration * 1000) / FRAMES))),
      ],
      { encoding: "utf8" },
    );
    if (webp.status !== 0) throw new Error(`webp: ${webp.stderr}`);
  }
  return { warnings: [...new Set(warnings)] };
}

/**
 * Likeness to the design (round 3/4's measure): the rest pose drawn at 512 px and the design's
 * figure, each cut to its box and scaled to the same height, compared by match.ts (silhouette IoU,
 * colour where both are drawn); plus `detail`, the interior colour gradient of the rig over the
 * design's (1 = as crisp and busy as the design; lower = blurrier or flatter), at full height.
 */
async function likenessTo(rig: Rig, designPixels: Pixels, images: Record<string, string> | undefined, direction: ProjectSpec["art"]["direction"]) {
  const rest = await renderer.renderRig({ rig, direction, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: 512, cellHeight: 512, columns: 1, background: null, ...(images ? { images } : {}) });
  const drawn = cropOpaque(decodePng(rest.png));
  const cut = cutCharacter(designPixels);
  if (!drawn || !cut) return null;
  const figure = cropOpaque(cut.image)!;
  const at = (H: number) => {
    const W = Math.max(8, Math.round((figure.width / figure.height) * H));
    return { a: flatten(resize(drawn, W, H), BACKGROUND), b: flatten(resize(figure, W, H), BACKGROUND) };
  };
  const small = at(256);
  const m = matchScore(small.a, small.b, BACKGROUND);
  const big = at(Math.min(drawn.height, figure.height));
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    silhouette: r3(m.silhouette),
    color: r3(m.color),
    detail: r3(gradient(big.a) / Math.max(1e-6, gradient(big.b))),
    drawnHeight: drawn.height,
  };
}

function gradient(img: Pixels): number {
  const bg = [0xd8, 0xd6, 0xcf];
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
  const list = SUBJECTS.filter((s) => !wantedSubjects || wantedSubjects.includes(s.id));
  const arms = ARMS.filter((a) => !wantedArms || wantedArms.includes(a.id));
  writeFileSync(join(out, "arms.json"), JSON.stringify(ARMS.map(({ id, what }) => ({ id, what })), null, 1));
  const setups: Record<string, number> = {};
  for (const s of list) {
    let base: { project: ProjectSpec; cost: number };
    try {
      base = await baseFor(s);
      setups[s.id] = base.cost;
      if (s.kind === "player") s.brief = assetOf(base.project, s).brief;
    } catch (error) {
      console.error(`${s.id} setup failed: ${error instanceof Error ? error.stack : String(error)}`);
      continue;
    }
    // The arms of a subject side by side (vision calls overlap; renders share the page pool).
    await Promise.all(
      arms
        .filter((arm) => !existsSync(join(out, s.id, arm.id, "result.json")))
        .map(async (arm) => {
          try {
            await runArm(s, arm, base);
          } catch (error) {
            console.error(`${s.id} ${arm.id} failed: ${error instanceof Error ? error.stack : String(error)}`);
            mkdirSync(join(out, s.id, arm.id), { recursive: true });
            writeFileSync(join(out, s.id, arm.id, "error.txt"), error instanceof Error ? (error.stack ?? error.message) : String(error));
          }
        }),
    );
  }
  // Subjects set up in earlier runs keep their concept cost.
  for (const s of SUBJECTS) {
    const saved = join(out, s.id, "base.json");
    if (setups[s.id] === undefined && existsSync(saved)) {
      const base = JSON.parse(readFileSync(saved, "utf8")) as { project: ProjectSpec; cost: number };
      setups[s.id] = base.cost;
      if (s.kind === "player") s.brief = assetOf(base.project, s).brief;
    }
  }
  writeFileSync(
    join(out, "subjects.json"),
    JSON.stringify(SUBJECTS.map(({ id, name, brief, kind, clips }) => ({ id, name, brief, kind, clips: Object.keys(clips), conceptCost: setups[id] ?? null })), null, 1),
  );
} finally {
  await renderer.close();
}
console.log(`image spend so far: $${spentSoFar().toFixed(4)} of $${BUDGET}`);
