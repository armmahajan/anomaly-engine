/**
 * World generation demo (prototype): one cheap biome kit -> one composed room.
 *   node scripts/world-demo.ts <slug> "<theme>"
 * Uses OPENROUTER_API_KEY from .env and the studio's default art models.
 * Writes apps/studio/public/world-preview/<slug>/ (scene.json + images,
 * gitignored), including views.png (the room from three camera positions).
 * Open /world.html?w=<slug> in the studio to see it live.
 *   node scripts/world-demo.ts <slug> "<theme>" --recompose
 * reuses the slug's kit and only composes a new room (one text call).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultArtDirection, WorldScene, type FileRef } from "@anomaly/core";
import { composeRoom, generateBiome, OpenRouterImageModel, OpenRouterVisionModel } from "@anomaly/art";
import { BrowserRenderer } from "../packages/server/src/art/renderer.ts";
import { DEFAULT_IMAGE_MODEL, DEFAULT_VISION_MODEL } from "../packages/server/src/art/config.ts";

const [slug, theme, flag] = process.argv.slice(2);
const recompose = flag === "--recompose";
if (!slug || !theme || !/^[a-z0-9-]+$/.test(slug)) throw new Error('usage: node scripts/world-demo.ts <slug> "<theme>"');
const root = fileURLToPath(new URL("..", import.meta.url));
const apiKey = readFileSync(join(root, ".env"), "utf8").match(/OPENROUTER_API_KEY=(.*)/)?.[1]?.trim();
if (!apiKey) throw new Error("OPENROUTER_API_KEY missing from .env");

const outDir = join(root, "apps/studio/public/world-preview", slug);
mkdirSync(outDir, { recursive: true });
const files = new Map<string, Buffer>();
const store = {
  async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
    const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
    files.set(ref, data);
    writeFileSync(join(outDir, ref), data);
    return ref;
  },
};

const renderer = new BrowserRenderer(join(root, "apps/studio/public/game"));
let spent = 0;
const t0 = Date.now();
try {
  const ctx = {
    image: new OpenRouterImageModel({ apiKey }, DEFAULT_IMAGE_MODEL, { quality: "low" }),
    vision: new OpenRouterVisionModel({ apiKey }, DEFAULT_VISION_MODEL),
    renderer,
    files: store,
    direction: defaultArtDirection(),
    log: (text: string, cost?: number) => console.log(`- ${text}${cost ? ` $${cost.toFixed(4)}` : ""}`),
    spend: (u: { cost: number }) => (spent += u.cost),
  };
  let scene;
  if (recompose) {
    const old = WorldScene.parse(JSON.parse(readFileSync(join(outDir, "scene.json"), "utf8")));
    for (const ref of [old.backdrop, old.ground, ...old.pieces.map((p) => p.file)]) files.set(ref, readFileSync(join(outDir, ref)));
    scene = await composeRoom(ctx, { name: slug, theme, width: old.width, height: old.height }, {
      backdrop: old.backdrop,
      ground: old.ground,
      pieces: old.pieces,
      backdropImage: files.get(old.backdrop)!,
    });
  } else {
    scene = await generateBiome(ctx, { name: slug, theme });
  }
  writeFileSync(join(outDir, "scene.json"), JSON.stringify(scene, null, 1));
  console.log(`kit + room: $${spent.toFixed(4)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const images = Object.fromEntries([...files].map(([ref, data]) => [ref, data.toString("base64")]));
  const views = await renderer.renderWorld({ scene, images, cameras: [0, scene.width / 2, scene.width], width: 960, height: 540 });
  writeFileSync(join(outDir, "views.png"), views.png);
  console.log(`rendered ${views.width}x${views.height}`, views.warnings);
} finally {
  await renderer.close();
}
