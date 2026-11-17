import type { ProjectSpec } from "../schema.ts";
import { unchanged, type StageOutcome } from "../architect/stages.ts";

/**
 * Difficulty by region (agent M owns this file): enemy stats rise with how deep in
 * the game the regions they appear in are (the progression's region order), so the
 * later regions are harder. Generic: works on any enemy character, from its spawns.
 * Used by the Architect's cast stage after the characters exist.
 */
export function difficultyStage(project: ProjectSpec): StageOutcome {
  return unchanged(project, "difficulty: not implemented yet");
}
