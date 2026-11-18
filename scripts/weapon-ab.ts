/**
 * Held weapons, blind check: round 3's vector-loop rigs holding two weapons described generically
 * (a quick one-handed melee weapon, a ranged one), walking and attacking, with the attack clip made
 * three ways.
 *   node scripts/weapon-ab.ts <round3-dir> <out-dir> [--subjects player,guard] [--budget 0.25]
 * Reads <round3>/<character>/vector-loop/{rig.json, concept.png} and <round3>/subjects.json (read only).
 * Each weapon's sprite is drawn once by the weaponArt stage (one real image, grip and tip by eye);
 * each rig gets its hand grip (withHandGrip). Arms, per character x weapon:
 *   held  the pipeline: animate {weaponId} (the model writes the attack clip from its shape and
 *         timing, then it is held to the attack: the arm is turned when the weapon misses the window)
 *   code  the attack's motion alone (fitWeaponClip on an empty clip: no model)
 *   free  the model's attack clip as written, not held to the attack
 * Images are real OpenRouter calls (OPENROUTER_API_KEY from .env, never printed), cached under <out>/cache
 * and logged to <out>/costs.jsonl; a call that could take the ledger past --budget is refused. Vision runs
 * on the local Claude Code login (free).
 * Writes <out>/<character>_<weapon>/{walk.webp, still.png, concept.png} and .../<arm>/{attack.webp,
 * attack-sheet.png, clip.json, result.json, log.txt}; `node scripts/weapon-ab-page.ts <out>` makes the page.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBatch, attackClipName, Clip, createDefaultProject, ProjectSpec, rigBounds, Weapon, type FileRef, type OperationCall, type Rig } from "@anomaly/core";
import {
  animate,
  askJson,
  attackTiming,
  checkWeaponClip,
  fitWeaponClip,
  gripBones,
  heldLength,
  OpenRouterImageModel,
  weaponAnimPrompt,
  weaponArtStage,
  weaponClipBrief,
  withHandGrip,
  type ArtContext,
  type ImageModel,
} from "@anomaly/art";
import { animSystemPrompt } from "../packages/art/src/prompts.ts";
import { z } from "zod";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";
import { ClaudeCodeVisionModel } from "../packages/server/src/art/claudeCodeVision.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

export const ARMS = [
  { id: "held", what: "the pipeline: the model writes the attack clip from the attack's shape and timing (with the target angles), then code holds it to the attack (turns the arm when the weapon's fastest motion misses the active window or it points elsewhere), one critique round" },
  { id: "code", what: "the attack's motion from code alone: the arm turned so the weapon follows the attack's shape and timing, nothing else moves (no model)" },
  { id: "free", what: "the model's attack clip as written (same prompt), not held to the attack" },
] as const;

/** Two weapons described the way a creator might, without naming a kind of weapon. */
const WEAPONS = [
  Weapon.parse({
    id: "quick",
    name: "Quick Weapon",
    description: "a light one-handed melee weapon for fast swings",
    art: { brief: "a light one-handed melee weapon made for quick swings, with a short handle", trail: { color: "#e8f0ff", width: 8, seconds: 0.1 } },
    attacks: [{ id: "swing", name: "Swing", shape: { type: "arc", radius: 52, from: -75, to: 45 }, timing: { windup: 0.07, active: 0.1, recovery: 0.18 } }],
  }),
  Weapon.parse({
    id: "ranged",
    name: "Ranged Weapon",
    description: "a compact one-handed ranged weapon that fires small bolts",
    art: { brief: "a compact one-handed ranged weapon with a short barrel and a sturdy grip", trail: { width: 0 } },
    attacks: [{ id: "shot", name: "Shot", shape: { type: "projectile", projectile: { speed: 700, color: "#ffd27a" } }, timing: { windup: 0.12, active: 0.06, recovery: 0.22 } }],
  }),
];

const BACKGROUND = "#d8d6cf";
const CELL = 320;
const FPS = 24;
/** Seconds at rest after the attack before the loop starts again. */
const PAUSE = 0.35;

// --- arguments, environment ---------------------------------------------------------------

const args = process.argv.slice(2);
const round3 = args[0] ?? "";
const out = args[1] ?? "";
if (!round3 || !out || out.startsWith("--")) throw new Error("usage: node scripts/weapon-ab.ts <round3-dir> <out-dir> [--subjects a,b] [--budget 0.25]");
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const BUDGET = Number(flag("--budget") ?? 0.25);
const wantedCharacters = flag("--subjects")?.split(",") ?? ["player", "guard"];
mkdirSync(join(out, "cache"), { recursive: true });

const env: Record<string, string | undefined> = { ...process.env };
for (const path of [join(root, ".env"), join(root, "../../../.env")]) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
    break;
  } catch {
    // try the next
  }
}
const apiKey = env.OPENROUTER_API_KEY?.trim();

// --- the image model: cached, ledgered, capped ------------------------------------------------

const LEDGER = join(out, "costs.jsonl");
const CALL_RESERVE = 0.02;
const spentSoFar = () =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce((s, l) => s + (JSON.parse(l) as { cost: number }).cost, 0)
    : 0;
const real = apiKey ? new OpenRouterImageModel({ apiKey }, env.STUDIO_ART_IMAGE_MODEL ?? "openai/gpt-image-1-mini", { quality: env.STUDIO_ART_IMAGE_QUALITY ?? "low" }) : null;
function cachedImages(label: string): ImageModel {
  return {
    id: real?.id ?? "none",
    async generate(request) {
      const key = createHash("sha256").update(request.prompt).update(request.quality ?? "").update(String(request.transparent)).update(request.aspectRatio ?? "").digest("hex").slice(0, 24);
      const file = join(out, "cache", `${key}.png`);
      const meta = join(out, "cache", `${key}.json`);
      if (existsSync(file) && existsSync(meta)) {
        const m = JSON.parse(readFileSync(meta, "utf8")) as { model: string; ext: "png" | "jpg" | "webp"; cost: number };
        return { image: readFileSync(file), ext: m.ext, usage: { cost: 0, promptTokens: 0, completionTokens: 0 }, model: `${m.model} (cached)` };
      }
      if (!real) throw new Error("OPENROUTER_API_KEY is not set (.env)");
      const spent = spentSoFar();
      if (spent + CALL_RESERVE > BUDGET) throw new Error(`image budget: $${spent.toFixed(4)} spent of $${BUDGET}; refusing another call (${label})`);
      const t0 = Date.now();
      const result = await real.generate(request);
      writeFileSync(file, result.image);
      writeFileSync(meta, JSON.stringify({ model: result.model, ext: result.ext, cost: result.usage.cost, prompt: request.prompt }));
      appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), what: label, model: result.model, quality: request.quality ?? null, cost: result.usage.cost, ms: Date.now() - t0, key })}\n`);
      console.log(`  image: ${label} $${result.usage.cost.toFixed(4)} (total $${(spent + result.usage.cost).toFixed(4)})`);
      return result;
    },
  };
}

// --- files, renderer, vision, a project per run ------------------------------------------------

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

function context(project: () => ProjectSpec, logPath: string, label: string): { ctx: ArtContext; commit: (ops: OperationCall[]) => void } {
  let current = project();
  const lines: string[] = [];
  const ctx: ArtContext = {
    project: () => current,
    image: cachedImages(label),
    vision,
    renderer,
    files: store,
    log: (a) => {
      lines.push(`${new Date().toISOString().slice(11, 19)} ${a.text}${a.cost ? ` ($${a.cost.toFixed(4)})` : ""}`);
      writeFileSync(logPath, lines.join("\n"));
    },
    remaining: () => 5,
    spend: () => {},
  };
  const commit = (ops: OperationCall[]) => {
    const r = applyBatch(current, ops);
    if (!r.ok) throw new Error(r.error.message);
    current = r.project;
  };
  return { ctx, commit };
}

/** The default project with these weapons, and the player drawn with `rig` (its clips: `clips`). */
function projectWith(weapons: Weapon[], rig?: Rig, clips: Record<string, Clip> = {}, brief = ""): ProjectSpec {
  const base = createDefaultProject();
  const asset = rig ? [{ id: "look", name: "Look", kind: "character", brief, concepts: [], chosen: null, rig, preview: null, clips, clipPreviews: {}, stateClips: {} }] : [];
  return ProjectSpec.parse({
    ...base,
    name: "Weapon check",
    weapons: { list: weapons, loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: null }] } },
    characters: base.characters.map((c) => (c.kind === "player" && rig ? { ...c, appearance: "look" } : c)),
    art: { ...base.art, assets: asset },
  });
}

// --- weapons: drawn once ------------------------------------------------------------------------

async function drawWeapons(): Promise<Weapon[]> {
  const cache = join(out, "weapons.json");
  if (existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, "utf8")) as Weapon[];
    for (const w of saved) if (w.art.sprite) files.set(w.art.sprite, readFileSync(join(out, w.art.sprite)));
    return saved;
  }
  const drawn: Weapon[] = [];
  for (const weapon of WEAPONS) {
    const { ctx, commit } = context(() => projectWith([weapon]), join(out, `weapon-${weapon.id}.log.txt`), `weapon ${weapon.id}`);
    commit((await weaponArtStage(ctx, { weaponId: weapon.id })).operations);
    const done = ctx.project().weapons.list[0]!;
    writeFileSync(join(out, done.art.sprite!), files.get(done.art.sprite!)!);
    writeFileSync(join(out, `weapon-${weapon.id}.png`), files.get(done.art.sprite!)!);
    drawn.push(done);
    console.log(`${weapon.id}: grip ${done.art.grip}, tip ${done.art.tip}, scale ${done.art.scale}`);
  }
  writeFileSync(cache, JSON.stringify(drawn, null, 1));
  return drawn;
}

// --- clips --------------------------------------------------------------------------------------

const ClipsReply = z.object({ clips: z.record(z.string(), Clip) });

async function attackClips(character: string, brief: string, rig: Rig, weapon: Weapon, dir: string): Promise<Record<(typeof ARMS)[number]["id"], Clip>> {
  const cache = join(dir, "clips.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const grip = rig.grips!.find((g) => g.id === "hand")!;
  const attack = weapon.attacks[0]!;
  const name = attackClipName(weapon, attack);
  // held: the stage itself.
  const held = context(() => projectWith([weapon], rig, {}, brief), join(dir, "held.log.txt"), `${character} ${weapon.id} held`);
  held.commit((await animate(held.ctx, { characterId: "player", weaponId: weapon.id })).operations);
  const asset = held.ctx.project().art.assets[0]!;
  if (asset.kind !== "character") throw new Error("no character asset");
  // free: the same prompt, the reply as written.
  const free = context(() => projectWith([weapon], rig, {}, brief), join(dir, "free.log.txt"), `${character} ${weapon.id} free`);
  const rest = (await renderer.renderRig({ rig, direction: free.ctx.project().art.direction, clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: 384, cellHeight: 384, columns: 1, background: BACKGROUND })).png;
  const reply = await askJson(
    free.ctx,
    ClipsReply,
    {
      system: animSystemPrompt(),
      content: [
        { type: "image", image: rest },
        { type: "text", text: weaponAnimPrompt({ brief, rig, grip: { ...grip, at: [grip.at[0], grip.at[1]], path: gripBones(rig, grip) }, clips: [weaponClipBrief(weapon, attack, name, grip.angle)], limbJoints: true }) },
      ],
      maxTokens: 10000,
    },
    "writing the free clip",
  );
  const { duration } = attackTiming(attack);
  const written = reply.clips[name] ?? Object.values(reply.clips)[0] ?? Clip.parse({ duration, loop: false });
  const clips = {
    held: asset.clips[name]!,
    code: fitWeaponClip(rig, grip, attack, Clip.parse({ duration, loop: false })),
    free: Clip.parse({ ...written, duration, loop: false }),
  };
  writeFileSync(cache, JSON.stringify(clips, null, 1));
  return clips;
}

// --- rendering ------------------------------------------------------------------------------------

/** An invisible box around the rig and the weapon's reach, so every frame is framed the same. */
function framed(rig: Rig, reach: number): Rig {
  const b = rigBounds(rig);
  const [cx, cy] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  const half = Math.max((b.maxX - b.minX) / 2 + reach, (b.maxY - b.minY) / 2 + reach * 0.6);
  const rootBone = rig.bones.find((bone) => bone.parent === null)!.id;
  return {
    ...rig,
    parts: [
      ...rig.parts,
      { id: "ab_frame", bone: rootBone, z: -100, shape: { type: "blob", points: [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]], smooth: 0, sharp: [] }, fill: "#000000", ink: 0, glow: false, opacity: 0 },
    ],
  };
}

async function sheet(dir: string, name: string, rig: Rig, clips: Record<string, Clip>, clip: string | null, times: number[], weapon: Weapon, attack: string | null) {
  const image = await renderer.renderRig({
    rig,
    direction: createDefaultProject().art.direction,
    clips,
    frames: times.map((time) => ({ clip, time })),
    cellWidth: CELL,
    cellHeight: CELL,
    columns: times.length,
    background: BACKGROUND,
    images: weapon.art.sprite ? { [weapon.art.sprite]: files.get(weapon.art.sprite)!.toString("base64") } : {},
    weapon: { weapon, attack },
  });
  writeFileSync(join(dir, `${name}-sheet.png`), image.png);
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
        "frames[0].save(dst, save_all=True, append_images=frames[1:], duration=ms, loop=0, quality=85, method=6)",
      ].join("\n"),
      join(dir, `${name}-sheet.png`),
      join(dir, `${name}.webp`),
      String(times.length),
      String(CELL),
      String(Math.round(1000 / FPS)),
    ],
    { encoding: "utf8" },
  );
  if (webp.status !== 0) throw new Error(`webp: ${webp.stderr}`);
  return image.warnings;
}

// --- main -----------------------------------------------------------------------------------------

interface Subject {
  id: string;
  name: string;
  brief: string;
}

try {
  const characters = (JSON.parse(readFileSync(join(round3, "subjects.json"), "utf8")) as Subject[]).filter((s) => wantedCharacters.includes(s.id));
  const weapons = await drawWeapons();
  const subjects: { id: string; name: string; brief: string; character: string; weapon: string }[] = [];
  for (const c of characters) {
    const saved = JSON.parse(readFileSync(join(round3, c.id, "vector-loop", "rig.json"), "utf8")) as { rig: Rig; clips: Record<string, Clip> };
    const rig = withHandGrip(saved.rig);
    const grip = rig.grips?.find((g) => g.id === "hand");
    if (!grip) throw new Error(`${c.id}: no hand grip`);
    console.log(`${c.id}: hand grip on ${grip.bone} at [${grip.at}] angle ${grip.angle}`);
    for (const weapon of weapons) {
      const id = `${c.id}_${weapon.id}`;
      const attack = weapon.attacks[0]!;
      const name = attackClipName(weapon, attack);
      subjects.push({ id, name: `${c.name} with the ${weapon.name.toLowerCase()}`, brief: `${c.brief}; holding ${weapon.description}`, character: c.id, weapon: weapon.id });
      const dir = join(out, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "concept.png"), readFileSync(join(round3, c.id, "vector-loop", "concept.png")));
      const t0 = Date.now();
      const clips = await attackClips(c.id, c.brief, rig, weapon, dir);
      const shown = framed(rig, heldLength(weapon) * 1.2);
      const walk = saved.clips.walk!;
      const walkWarnings = await sheet(dir, "walk", shown, { walk }, "walk", Array.from({ length: 16 }, (_, i) => (walk.duration * i) / 16), weapon, null);
      await sheet(dir, "still", shown, {}, null, [0], weapon, null);
      const length = heldLength(weapon);
      for (const arm of ARMS) {
        const armDir = join(dir, arm.id);
        mkdirSync(armDir, { recursive: true });
        const clip = clips[arm.id];
        const total = clip.duration + PAUSE;
        const times = Array.from({ length: Math.round(total * FPS) }, (_, i) => i / FPS);
        const warnings = await sheet(armDir, "attack", shown, { [name]: clip }, name, times, weapon, attack.id);
        const check = checkWeaponClip(rig, grip, attack, clip, length);
        writeFileSync(join(armDir, "clip.json"), JSON.stringify(clip, null, 1));
        writeFileSync(
          join(armDir, "result.json"),
          JSON.stringify({ subject: id, arm: arm.id, what: arm.what, attack: { ...attackTiming(attack), shape: attack.shape.type }, check, grip, warnings: [...walkWarnings, ...warnings] }, null, 1),
        );
        console.log(`${id} ${arm.id}: ${check.ok ? "ok" : check.problems.join("; ")} (peak t ${check.peak.toFixed(2)})`);
      }
      console.log(`${id}: ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
  writeFileSync(join(out, "arms.json"), JSON.stringify(ARMS, null, 1));
  writeFileSync(join(out, "subjects.json"), JSON.stringify(subjects, null, 1));
} finally {
  await renderer.close();
}
console.log(`image spend: $${spentSoFar().toFixed(4)} of $${BUDGET}`);
