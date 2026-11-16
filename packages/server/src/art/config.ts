import {
  FakeImageModel,
  FakeVisionModel,
  OpenRouterImageModel,
  OpenRouterVisionModel,
} from "@anomaly/art";
import { BrowserRenderer } from "./renderer.ts";
import type { ArtServiceOptions } from "./service.ts";

/**
 * Art pipeline settings from the environment (the studio's .env):
 *   OPENROUTER_API_KEY         required for real generation (server-side only)
 *   STUDIO_ART_IMAGE_MODEL     default openai/gpt-image-1-mini (concept sheets)
 *   STUDIO_ART_IMAGE_QUALITY   default low (models with a quality knob)
 *   STUDIO_ART_VISION_MODEL    default anthropic/claude-haiku-5.5 (picks, rigs, critiques, animation)
 *   STUDIO_ART_BUDGET          USD per job, default 0.25
 *   STUDIO_ART_BACKEND=fake    scripted models (tests/e2e); renders are still real
 * Defaults come from the Phase 0 benchmark: a whole character costs ~$0.01-0.02.
 */

export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-1-mini";
export const DEFAULT_VISION_MODEL = "anthropic/claude-haiku-5.5";
export const DEFAULT_BUDGET = 0.25;

export function artOptionsFromEnv(
  env: Record<string, string | undefined>,
  gameDir: string,
): Omit<ArtServiceOptions, "files"> & { renderer: BrowserRenderer } {
  const renderer = new BrowserRenderer(gameDir);
  const budget = Number(env.STUDIO_ART_BUDGET ?? DEFAULT_BUDGET);
  const base = { renderer, budget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET };

  if (env.STUDIO_ART_BACKEND === "fake") {
    return { ...base, models: { image: new FakeImageModel(), vision: new FakeVisionModel() } };
  }
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ...base, models: null, unavailableReason: "art generation needs OPENROUTER_API_KEY in the studio's .env" };
  }
  const openRouter = { apiKey };
  return {
    ...base,
    models: {
      image: new OpenRouterImageModel(openRouter, env.STUDIO_ART_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL, {
        quality: env.STUDIO_ART_IMAGE_QUALITY ?? "low",
      }),
      vision: new OpenRouterVisionModel(openRouter, env.STUDIO_ART_VISION_MODEL ?? DEFAULT_VISION_MODEL),
    },
  };
}
