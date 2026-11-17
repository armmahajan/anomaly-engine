import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";

/** Prop and item warnings (agent D). */
export function lintProps(_project: ProjectSpec): DomainWarning[] {
  return [];
}
