import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";

/** Modal and map warnings (agent E). */
export function lintModals(_project: ProjectSpec): DomainWarning[] {
  return [];
}
