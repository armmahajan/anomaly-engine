/**
 * Rig look A/B, round 4: the same vector rigs and clips (round 3's vector-loop winner), dressed five ways.
 *   node scripts/rig-ab4.ts <round3-dir> <out-dir> [--subjects player,guard] [--arms plain,detail,...] [--budget 0.25]
 * Reads <round3>/<subject>/vector-loop/{rig.json, concept.png, design.png} and <round3>/subjects.json (read only).
 * Arms (see ARMS): plain (unchanged), detail (Opus adds vector detail shapes over look-and-fix rounds),
 * projected (the design's own pixels per part), paintover (one image edit paints over the exploded rest
 * pose), combo (detail shapes over a paint-over of the detailed rig at partial strength).
 * Images are real OpenRouter calls (OPENROUTER_API_KEY from .env, never printed), cached under <out>/cache
 * by prompt and references and logged to <out>/costs.jsonl; a call that could take the ledger past --budget
 * (USD, default 0.25) is refused. Vision runs on the local Claude Code login (free).
 * Writes per subject and arm: <out>/<subject>/<arm>/{concept.png, still.png, walk.webp, walk-sheet.png, rig.json,
 * result.json, log.txt, atlas.png?, exploded.png?, painted.png?}; `node scripts/rig-ab4-page.ts <out>` makes the page.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProject, rigBounds, rigFiles, type Clip, type FileRef, type ProjectSpec, type Rig } from "@anomaly/core";
import {
  cutCharacter,
  decodePng,
  flatten,
  look,
  matchScore,
  OpenRouterImageModel,
  paintOverLook,
  pngSize,
  sheetMetrics,
  type ArtContext,
  type Frame,
  type ImageModel,
  type Look,
  type LookResult,
  type Pixels,
} from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";
import { ClaudeCodeVisionModel } from "../packages/server/src/art/claudeCodeVision.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

interface Arm {
  id: string;
  what: string;
  /** null: the rig as it is. combo starts from the detail arm's shapes. */
  look: Look | null;
}

export const ARMS: Arm[] = [
  { id: "plain", what: "round 3's vector-loop rig, unchanged (control)", look: null },
  { id: "detail", what: "Opus adds vector detail shapes per part from the design (shading bands, highlights, folds, seams, patterns, accessories), clipped to their part, over 3 look-and-fix rounds", look: "detail" },
  { id: "projected", what: "each part textured with the design's own pixels for it (design lined up with the rig, each part fitted on its own), flat fill where the design shows nothing, fills retinted to their texture", look: "projected" },
  { id: "paintover", what: "the rest pose with bone groups pulled apart, painted over by one gpt-image-1-mini edit in the design's style, mapped back onto each part", look: "paintover" },
  { id: "combo", what: "the detail arm's shapes over a paint-over of the detailed rig at 60% strength", look: "combo" },
];

const COMBO_OPACITY = 0.6;
const BACKGROUND = "#d8d6cf";

// --- arguments, environment ---------------------------------------------------------------

const args = process.argv.slice(2);
const round3 = args[0] ?? "";
const out = args[1] ?? "";
if (!round3 || !out || out.startsWith("--")) throw new Error("usage: node scripts/rig-ab4.ts <round3-dir> <out-dir> [--subjects a,b] [--arms a,b] [--budget 0.25]");
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const BUDGET = Number(flag("--budget") ?? 0.25);
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
  // no .env here: the main checkout's
  try {
    for (const line of readFileSync(join(root, "../../../.env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {
    // none
  }
}
const apiKey = env.OPENROUTER_API_KEY?.trim();

// --- the image model: cached, ledgered, capped ------------------------------------------------

const LEDGER = join(out, "costs.jsonl");
/** A generous guess for one more image call (a medium edit with two references). */
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
      if (spent + CALL_RESERVE > BUDGET) throw new Error(`image budget: $${spent.toFixed(4)} spent of $${BUDGET}; refusing another call (${label()})`);
      const t0 = Date.now();
      const result = await real.generate(request);
      writeFileSync(file, result.image);
      writeFileSync(meta, JSON.stringify({ model: result.model, ext: result.ext, cost: result.usage.cost, prompt: request.prompt, references: request.references?.length ?? 0 }));
      appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), what: label(), model: result.model, references: request.references?.length ?? 0, quality: request.quality ?? null, cost: result.usage.cost, ms: Date.now() - t0, key })}\n`);
      console.log(`  image: ${label()} $${result.usage.cost.toFixed(4)} (total $${(spent + result.usage.cost).toFixed(4)})`);
      return result;
    },
  };
}

// --- files, renderer, vision ---------------------------------------------------------------

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
const DIRECTION = createDefaultProject().art.direction;

interface Subject {
  id: string;
  name: string;
  brief: string;
}

function context(logPath: string, what: () => string): { ctx: ArtContext; spent: () => number } {
  const project: ProjectSpec = createDefaultProject();
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
  return { ctx, spent: () => spent };
}

interface Saved {
  rig: Rig;
  clips: Record<string, Clip>;
  preview: { frame: Frame };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const round3n = (n: number) => Math.round(n * 1e3) / 1e3;

/** Look results are kept so arms that build on another (combo on detail) and reruns reuse them. */
async function lookFor(subject: Subject, arm: Arm, saved: Saved, dir: string): Promise<{ result: LookResult; cost: number; seconds: number }> {
  const cache = join(dir, "look.json");
  if (existsSync(cache)) {
    const c = JSON.parse(readFileSync(cache, "utf8")) as { result: LookResult; cost: number; seconds: number; files: string[] };
    for (const f of c.files) files.set(f, readFileSync(join(dir, f)));
    return c;
  }
  const t0 = Date.now();
  const concept = readFileSync(join(round3, subject.id, "vector-loop", "concept.png"));
  const designPng = readFileSync(join(round3, subject.id, "vector-loop", "design.png"));
  const { ctx, spent } = context(join(dir, "log.txt"), () => `${subject.id} ${arm.id}`);
  const base = { rig: saved.rig, frame: saved.preview.frame, canvas: pngSize(designPng), design: concept, brief: subject.brief };
  let result: LookResult;
  if (arm.look === "combo") {
    // The detail arm's shapes, painted over (no second detail pass: only the paint differs from that arm).
    const detail = await lookFor(subject, ARMS.find((a) => a.id === "detail")!, saved, join(out, subject.id, "detail"));
    const painted = await paintOverLook(ctx, { ...base, rig: detail.result.rig }, { opacity: COMBO_OPACITY });
    result = { ...painted, details: detail.result.details, score: detail.result.score, notes: detail.result.notes };
  } else {
    result = await look(ctx, base, { look: arm.look! });
  }
  const refs = rigFiles(result.rig);
  for (const ref of refs) writeFileSync(join(dir, ref), files.get(ref)!);
  if (result.exploded) writeFileSync(join(dir, "exploded.png"), result.exploded);
  if (result.painted) writeFileSync(join(dir, "painted.png"), result.painted);
  const { exploded: _e, painted: _p, ...kept } = result;
  const c = { result: kept as LookResult, cost: spent(), seconds: Math.round((Date.now() - t0) / 1000), files: refs };
  writeFileSync(cache, JSON.stringify(c, null, 1));
  return c;
}

async function runArm(subject: Subject, arm: Arm) {
  const dir = join(out, subject.id, arm.id);
  mkdirSync(dir, { recursive: true });
  const src = join(round3, subject.id, "vector-loop");
  const saved = JSON.parse(readFileSync(join(src, "rig.json"), "utf8")) as Saved;
  const concept = readFileSync(join(src, "concept.png"));
  writeFileSync(join(dir, "concept.png"), concept);
  let rig = saved.rig;
  let lookResult: LookResult | null = null;
  let cost = 0;
  let seconds = 0;
  if (arm.look) {
    const done = await lookFor(subject, arm, saved, dir);
    lookResult = done.result;
    rig = done.result.rig;
    cost = done.cost;
    seconds = done.seconds;
  }
  writeFileSync(join(dir, "rig.json"), JSON.stringify({ rig, clips: saved.clips }, null, 1));
  const images = await imagesFor(rig);
  const media = await renderMedia(dir, rig, saved.clips, images, saved.rig);
  const likeness = await likenessTo(rig, concept, images);
  // The plain arm must draw exactly what round 3 drew.
  const sameAsRound3 = arm.id === "plain" ? identical(readFileSync(join(dir, "still.png")), readFileSync(join(src, "still.png"))) : undefined;
  const atlas = lookResult?.atlas;
  const result = {
    subject: subject.id,
    arm: arm.id,
    what: arm.what,
    seconds,
    cost: { images: round4(cost) },
    likeness,
    counts: counts(rig, saved.rig),
    texture: atlas ? { width: atlas.width, height: atlas.height, pngBytes: atlas.bytes, webpBytes: webpSize(join(dir, atlas.file)), packScale: atlas.scale } : null,
    coverage: lookResult?.coverage ?? null,
    registration: lookResult?.registration ?? null,
    detailScore: lookResult?.score ?? null,
    detailNotes: lookResult?.notes ?? null,
    ...(sameAsRound3 !== undefined ? { sameStillAsRound3: sameAsRound3 } : {}),
    ...media,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
  console.log(`${subject.id} ${arm.id}: likeness ${JSON.stringify(likeness)} parts ${result.counts.parts} (+${result.counts.added}) texture ${atlas ? `${atlas.width}x${atlas.height} ${atlas.bytes}B` : "-"} $${cost.toFixed(4)} ${seconds}s`);
}

async function imagesFor(rig: Rig): Promise<Record<string, string> | undefined> {
  const refs = rigFiles(rig);
  return refs.length ? Object.fromEntries(refs.map((r) => [r, files.get(r)!.toString("base64")])) : undefined;
}

function identical(a: Buffer, b: Buffer): { identical: boolean; maxDiff: number } {
  const pa = decodePng(a);
  const pb = decodePng(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { identical: false, maxDiff: 255 };
  let max = 0;
  for (let i = 0; i < pa.data.length; i++) max = Math.max(max, Math.abs(pa.data[i]! - pb.data[i]!));
  return { identical: max === 0, maxDiff: max };
}

function webpSize(png: string): number {
  const run = spawnSync("python3", ["-I", "-c", "import sys, io\nfrom PIL import Image\nb = io.BytesIO()\nImage.open(sys.argv[1]).save(b, 'WEBP', quality=88, method=6)\nprint(len(b.getvalue()))", png], { encoding: "utf8" });
  return run.status === 0 ? Number(run.stdout.trim()) : -1;
}

/** Parts, how many were added to the plain rig, textured parts. */
function counts(rig: Rig, plain: Rig) {
  return {
    bones: rig.bones.length,
    parts: rig.parts.length,
    added: rig.parts.length - plain.parts.length,
    clipped: rig.parts.filter((p) => p.clipTo).length,
    textured: rig.parts.filter((p) => p.texture).length,
  };
}

/** An invisible box a little larger than the plain rig's rest pose: every arm framed exactly like round 3. */
function framed(rig: Rig, plain: Rig, close = false): Rig {
  const b = rigBounds(plain);
  const [cx, cy, hw, hh] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (close ? 0.53 : 0.62) * (b.maxX - b.minX), (close ? 0.53 : 0.54) * (b.maxY - b.minY)];
  const half = close ? hw : Math.max(hw, hh * 0.75);
  const rootBone = rig.bones.find((bone) => bone.parent === null)!.id;
  // render_service fits every part's points (not only the box): details stay inside the plain rig's shapes, so the box decides.
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

/** Still, the walk loop as an animated WebP (round 3's size and framing), animation metrics. */
async function renderMedia(dir: string, rig: Rig, clips: Record<string, Clip>, images: Record<string, string> | undefined, plain: Rig) {
  const shown = framed(rig, plain);
  const extra = images ? { images } : {};
  const clip = clips.walk ? "walk" : clips.idle ? "idle" : Object.keys(clips)[0]!;
  const still = await renderer.renderRig({ rig: shown, direction: DIRECTION, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: CELL, cellHeight: CELL, columns: 1, background: BACKGROUND, ...extra });
  writeFileSync(join(dir, "still.png"), still.png);
  // Close up: the rest pose filling the picture (the renderer keeps a 16% margin: cropped off).
  const close = await renderer.renderRig({ rig: framed(rig, plain, true), direction: DIRECTION, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: CLOSE, cellHeight: CLOSE, columns: 1, background: BACKGROUND, ...extra });
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
    ...extra,
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
    ...extra,
  });
  const metrics = sheetMetrics(decodePng(metricSheet.png), { width: METRIC_CELL, height: METRIC_CELL }, METRIC_FRAMES, ids, METRIC_FRAMES);
  return { animated: clip, animDuration: duration, anim: metrics, warnings: [...still.warnings, ...sheet.warnings] };
}

/** Likeness to the concept (round 3's measure): rest pose and concept figure, each cut to its box, same size, match.ts; plus colour detail (edge density ratio). */
async function likenessTo(rig: Rig, conceptPng: Buffer, images: Record<string, string> | undefined) {
  const rest = await renderer.renderRig({ rig, direction: DIRECTION, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: 512, cellHeight: 512, columns: 1, background: null, ...(images ? { images } : {}) });
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
    /** Interior detail: mean colour gradient inside the figure, rig over concept (1 = as busy as the design). */
    detail: round3n(gradient(a, BACKGROUND) / Math.max(1e-6, gradient(b, BACKGROUND))),
    /** Colour closeness on a blurred copy (ignores exact placement of small details), 0-1. */
    colorBlurred: round3n(matchScore(blur(a, 4), blur(b, 4), BACKGROUND).color),
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
  const out = new Uint8Array(img.data.length);
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
      for (let c = 0; c < 4; c++) out[(y * img.width + x) * 4 + c] = Math.round(acc[c]! / n);
    }
  return { width: img.width, height: img.height, data: out };
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
  const arms = ARMS.filter((a) => !wantedArms || wantedArms.includes(a.id));
  writeFileSync(join(out, "arms.json"), JSON.stringify(ARMS.map(({ id, what }) => ({ id, what })), null, 1));
  writeFileSync(join(out, "subjects.json"), JSON.stringify(all.map(({ id, name, brief }) => ({ id, name, brief })), null, 1));
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
console.log(`image spend so far: $${spentSoFar().toFixed(4)} of $${BUDGET}`);
