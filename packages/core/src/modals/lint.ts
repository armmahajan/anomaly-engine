import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";
import { modalUses } from "./operations.ts";

/** Modal and map warnings: modals nothing shows, modals that can never close, a map with nothing to map. */
export function lintModals(project: ProjectSpec): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  const { modals, map, rooms } = project.world;
  modals.forEach((modal, i) => {
    const path = `world.modals.${i}`;
    if (!modalUses(project, modal.id).some((u) => u.modal !== modal.id)) {
      warnings.push({ code: "modal_unused", path, message: `modal "${modal.id}" is never shown (no handler or other modal's button shows it)` });
    }
    const reopens = modal.buttons.every((b) => b.do.some((e) => e.type === "showModal" && e.modal === modal.id));
    if (modal.buttons.length > 0 && reopens) {
      warnings.push({ code: "modal_never_closes", path, message: `modal "${modal.id}" can never close: every button shows it again` });
    }
  });
  if (map.enabled && rooms.length < 2) {
    warnings.push({ code: "map_too_small", path: "world.map", message: `the map is on but the game has only ${rooms.length} room(s)` });
  }
  return warnings;
}
