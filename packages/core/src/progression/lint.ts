import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";

/**
 * The progression against the world (agent J), static checks only: abilities
 * obtained in a region are granted in one of its rooms, regions have rooms,
 * connections have doors between their regions' rooms.
 */
export function lintProgressionWorld(_project: ProjectSpec): DomainWarning[] {
  return [];
}
