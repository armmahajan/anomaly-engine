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
import type { ArtServiceOptions } from "./service.ts";

/**
 * Art pipeline settings from the environment (the studio's .env):
 *   OPENROUTER_API_KEY         required for real generation (server-side only; images always use it)
 *   STUDIO_ART_IMAGE_MODEL     default openai/gpt-image-1-mini (concept sheets)
 *   STUDIO_ART_IMAGE_QUALITY   default low (models with a quality knob)
 *   STUDIO_ART_VISION_BACKEND  "claude-code" or "openrouter" (picks, rigs, critiques, animation).
 *                              Default: claude-code (your local Claude Code login, the chat
 *                              agents' backend; vision calls cost nothing), except openrouter
 *                              when STUDIO_CHAT_BACKEND=fake or STUDIO_ART_VISION_MODEL is an
 *                              OpenRouter id ("provider/model").
 *   STUDIO_ART_VISION_MODEL    default claude-opus-5-5 on claude-code,
 *                              anthropic/claude-haiku-5.5 on openrouter
 *   STUDIO_ART_VISION_EFFORT   claude-code only: low|medium|high|xhigh|max (default: the model's)
 *   STUDIO_ART_RIG_MODE        traced (default: the design's pieces redrawn as flat vector shapes), cutout or vector
 *   STUDIO_ART_BUDGET          USD per job, default 0.25
 *   STUDIO_ART_BACKEND=fake    scripted models (tests/e2e); renders are still real
 * Defaults come from the Phase 0 benchmark: a whole character costs ~$0.01-0.02 on
 * OpenRouter, about half that (images only) with vision on Claude Code.
 */

export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-1-mini";
export const DEFAULT_VISION_MODEL = "anthropic/claude-haiku-5.5";
export const DEFAULT_BUDGET = 0.25;
export { DEFAULT_CLAUDE_VISION_MODEL };

export type VisionBackend = "claude-code" | "openrouter";

function rigModeFromEnv(value: string | undefined): "vector" | "cutout" | "traced" {
  const v = value?.trim();
  return v === "vector" || v === "cutout" ? v : "traced";
}

/** The vision backend the environment asks for; null when STUDIO_ART_VISION_BACKEND is misspelled. */
export function visionBackendFromEnv(env: Record<string, string | undefined>): VisionBackend | null {
  const explicit = env.STUDIO_ART_VISION_BACKEND?.trim();
  if (explicit === "claude-code" || explicit === "openrouter") return explicit;
  if (explicit) return null;
  if (env.STUDIO_CHAT_BACKEND === "fake") return "openrouter";
  if (env.STUDIO_ART_VISION_MODEL?.includes("/")) return "openrouter";
  return "claude-code";
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

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
    vision = new OpenRouterVisionModel(openRouter, env.STUDIO_ART_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL);
  }
  return {
    ...base,
    models: {
      image: new OpenRouterImageModel(openRouter, env.STUDIO_ART_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL, {
        quality: env.STUDIO_ART_IMAGE_QUALITY ?? "low",
      }),
      vision,
    },
    // Traced: the chosen design cut into pieces, each redrawn as flat vector shapes (likeness of a cutout, clean
    // animation of a vector rig). STUDIO_ART_RIG_MODE=cutout or vector picks another.
    defaultRigMode: rigModeFromEnv(env.STUDIO_ART_RIG_MODE),
  };
}
