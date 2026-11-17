import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";

/** Fairness warnings for every enemy's behavior (agent F). */
export function lintCombat(_project: ProjectSpec): DomainWarning[] {
  return [];
}
