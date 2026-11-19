import { isClaudeOnOpenRouter } from "@anomaly/art";
import {
  FakeImageModel,
  FakeVisionModel,
  OpenRouterImageModel,
  OpenRouterVisionModel,
  type VisionModel,
} from "@anomaly/art";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeVisionModel, DEFAULT_CLAUDE_VISION_MODEL } from "./claudeCodeVision.ts";
import { BrowserRenderer } from "./renderer.ts";
import { DEFAULT_ART_CONCURRENCY, type ArtServiceOptions } from "./service.ts";

/**
 * Art pipeline settings from the environment (the studio's .env):
 *   OPENROUTER_API_KEY         required for real generation (server-side only; images always use it)
 *   STUDIO_ART_IMAGE_MODEL     default openai/gpt-image-1-mini (concept sheets)
 *   STUDIO_ART_IMAGE_QUALITY   default low (models with a quality knob)
 *   STUDIO_ART_IMAGE_CHOICES   image models the creator can pick for all art (comma-separated OpenRouter
 *                              ids; the image model is always first, the default); picked in the art panel.
 *                              Default: the image model, Nano Banana 2 Lite, Seedream 5.5, FLUX.2 Pro,
 *                              Meta Muse Image
 *   STUDIO_ART_VISION_BACKEND  "claude-code" or "openrouter" (picks, rigs, critiques, animation).
 *                              Default: claude-code (your local Claude Code login, the chat
 *                              agents' backend; vision calls cost nothing), except openrouter
 *                              when STUDIO_ART_VISION_MODEL is a non-Claude OpenRouter id
 *                              ("provider/model"). Claude never goes through OpenRouter unless
 *                              STUDIO_ALLOW_OPENROUTER_CLAUDE=1.
 *   STUDIO_ART_VISION_MODEL    default claude-opus-5-5 on claude-code,
 *                              anthropic/claude-haiku-5.5 on openrouter
 *   STUDIO_ART_VISION_EFFORT   claude-code only: low|medium|high|xhigh|max (default: the model's)
 *   STUDIO_ART_RIG_MODE        vector (default: the full pipeline, see stages.ts rigModeFor), traced or cutout
 *   STUDIO_ART_BUDGET          USD per job, default 0.25
 *   STUDIO_ART_CONCURRENCY     art jobs that run at once, default 3 (1 = one at a time); jobs that touch
 *                              the same character, weapon, biome, room or modal still wait for each other
 *   STUDIO_ART_RENDER_PAGES    render pages in the one headless Chromium, default = concurrency, at most 3
 *   STUDIO_ART_BACKEND=fake    scripted models (tests/e2e); renders are still real
 * Defaults come from the Phase 0 benchmark: a whole character costs ~$0.01-0.02 on
 * OpenRouter, about half that (images only) with vision on Claude Code.
 */

export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-1-mini";
/** Offered after the image model (OpenRouter's images API). */
export const DEFAULT_IMAGE_CHOICES = ["google/gemini-3.1-flash-lite-image", "bytedance-seed/seedream-5-5", "black-forest-labs/flux.2-pro", "meta/muse-image"];
const MODEL_LABELS: Record<string, string> = {
  "openai/gpt-image-1-mini": "GPT Image 1 mini",
  "google/gemini-3.1-flash-lite-image": "Nano Banana 2 Lite",
  "bytedance-seed/seedream-5-5": "Seedream 5.5",
  "black-forest-labs/flux.2-pro": "FLUX.2 Pro",
  "meta/muse-image": "Meta Muse Image",
};
/**
 * Request fields each offered model accepts (OpenRouter's images/models supported_parameters, 2026-11-19);
 * others are left out of its requests. Models not listed get every field (as before).
 */
export const IMAGE_MODEL_PARAMS: Record<string, string[]> = {
  "openai/gpt-image-1-mini": ["aspect_ratio", "output_format", "quality", "background", "n", "input_references"],
  "google/gemini-3.1-flash-lite-image": ["resolution", "aspect_ratio", "n", "input_references"],
  "bytedance-seed/seedream-5-5": ["resolution", "aspect_ratio", "output_format", "background", "n", "input_references"],
  "black-forest-labs/flux.2-pro": ["aspect_ratio", "output_format", "n", "input_references"],
  "meta/muse-image": [],
};
/** A readable name for an image model id. */
export const imageModelLabel = (id: string) => MODEL_LABELS[id] ?? id;

/** The image models the creator can pick: the image model first, then the offered ones (env or defaults), each once. */
export function imageChoiceIds(env: NodeJS.ProcessEnv, imageModel: string): string[] {
  const listed = env.STUDIO_ART_IMAGE_CHOICES?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_IMAGE_CHOICES;
  return [...new Set([imageModel, ...listed])].filter((id) => !isClaudeOnOpenRouter(id));
}
export const DEFAULT_VISION_MODEL = "anthropic/claude-haiku-5.5";
export const DEFAULT_BUDGET = 0.25;
export { DEFAULT_CLAUDE_VISION_MODEL };

/** Render pages at most (each runs the web runtime: about 150 MB). */
export const MAX_RENDER_PAGES = 3;
/** Art jobs at most, whatever the environment says. */
export const MAX_ART_CONCURRENCY = 8;

/** A whole number from the environment within 1..max, else the fallback. */
function count(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value?.trim() || NaN);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

/** Jobs at once and render pages from the environment. */
export function artConcurrencyFromEnv(env: Record<string, string | undefined>): { concurrency: number; pages: number } {
  const concurrency = count(env.STUDIO_ART_CONCURRENCY, DEFAULT_ART_CONCURRENCY, MAX_ART_CONCURRENCY);
  return { concurrency, pages: count(env.STUDIO_ART_RENDER_PAGES, Math.min(concurrency, MAX_RENDER_PAGES), MAX_RENDER_PAGES) };
}

export type VisionBackend = "claude-code" | "openrouter";

function rigModeFromEnv(value: string | undefined): "vector" | "cutout" | "traced" {
  const v = value?.trim();
  return v === "traced" || v === "cutout" ? v : "vector";
}

/** The vision backend the environment asks for; null when STUDIO_ART_VISION_BACKEND is misspelled. */
export function visionBackendFromEnv(env: Record<string, string | undefined>): VisionBackend | null {
  const explicit = env.STUDIO_ART_VISION_BACKEND?.trim();
  if (explicit === "claude-code" || explicit === "openrouter") return explicit;
  if (explicit) return null;
  // A "provider/model" id is an OpenRouter model, except Claude's: Claude runs on the Claude Code subscription.
  const model = env.STUDIO_ART_VISION_MODEL?.trim();
  if (model?.includes("/") && !isClaudeOnOpenRouter(model)) return "openrouter";
  return "claude-code";
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function artOptionsFromEnv(
  env: Record<string, string | undefined>,
  gameDir: string,
): Omit<ArtServiceOptions, "files"> & { renderer: BrowserRenderer } {
  const { concurrency, pages } = artConcurrencyFromEnv(env);
  const renderer = new BrowserRenderer(gameDir, { pages });
  const budget = Number(env.STUDIO_ART_BUDGET ?? DEFAULT_BUDGET);
  const base = { renderer, concurrency, budget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET };

  if (env.STUDIO_ART_BACKEND === "fake") {
    const image = new FakeImageModel();
    // Two scripted image models, so the picker shows in tests.
    return { ...base, models: { image, vision: new FakeVisionModel(), imageChoices: [{ id: image.id, label: "Fake image", model: image }, { id: "fake/image-alt", label: "Fake image (alt)", model: new FakeImageModel(undefined, "fake/image-alt") }] } };
  }
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ...base, models: null, unavailableReason: "art generation needs OPENROUTER_API_KEY in the studio's .env" };
  }
  const openRouter = { apiKey };
  const backend = visionBackendFromEnv(env);
  if (!backend) {
    return { ...base, models: null, unavailableReason: 'STUDIO_ART_VISION_BACKEND must be "claude-code" or "openrouter"' };
  }
  let vision: VisionModel;
  if (backend === "claude-code") {
    const effort = env.STUDIO_ART_VISION_EFFORT?.trim();
    vision = new ClaudeCodeVisionModel({
      model: env.STUDIO_ART_VISION_MODEL?.trim() || DEFAULT_CLAUDE_VISION_MODEL,
      ...(effort && EFFORTS.includes(effort) ? { effort: effort as EffortLevel } : {}),
    });
  } else {
    const model = env.STUDIO_ART_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
    const allowClaude = env.STUDIO_ALLOW_OPENROUTER_CLAUDE === "1";
    if (isClaudeOnOpenRouter(model) && !allowClaude) {
      return {
        ...base,
        models: null,
        unavailableReason: `${model} on OpenRouter would be billed there: Claude runs on your Claude Code subscription (STUDIO_ART_VISION_BACKEND=claude-code), or set STUDIO_ALLOW_OPENROUTER_CLAUDE=1 to pay through OpenRouter`,
      };
    }
    vision = new OpenRouterVisionModel({ ...openRouter, allowClaude }, model);
  }
  const imageId = env.STUDIO_ART_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
  const quality = env.STUDIO_ART_IMAGE_QUALITY ?? "low";
  // OpenAI's image models take a quality knob; the others don't.
  const imageModel = (id: string) => new OpenRouterImageModel(openRouter, id, id.startsWith("openai/") ? { quality } : {}, IMAGE_MODEL_PARAMS[id]);
  const image = imageModel(imageId);
  return {
    ...base,
    models: {
      image,
      vision,
      imageChoices: imageChoiceIds(env, imageId).map((id) => ({ id, label: imageModelLabel(id), model: id === imageId ? image : imageModel(id) })),
    },
    // Vector: the full pipeline the creator voted for (rig-ready designs, a flat redraw, a vector rig with elbows
    // and knees checked over render-and-compare rounds, detail shapes). STUDIO_ART_RIG_MODE=traced or cutout picks another.
    defaultRigMode: rigModeFromEnv(env.STUDIO_ART_RIG_MODE),
  };
}
