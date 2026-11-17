import type { ProjectSpec } from "../../schema.ts";
import type { Handler } from "../../events/events.ts";
import type { StageOptions, StageOutcome } from "../stages.ts";
import { endingModal, grantScreens, TITLE_MODAL, titleModal, withMissing } from "./grants.ts";

/**
 * The screens stage: a title screen shown on gameStarted (the game's name and its
 * wiki overview's line), an ending screen (the ending region's line, and thanks),
 * a "You got X" message for every ability or key the player can get (the
 * progression's placed abilities and everything the plan grants: its name, its
 * wiki line, how to use it, what it opens), and the map turned on.
 *
 * Division of work with population (grants.ts): population creates the message
 * modals, key items and the ending modal its own handlers show, so its output is
 * valid by itself; this stage adds whatever is still missing and wires the title.
 * Both only add: a screen that exists (the creator's edit, an earlier run) is kept,
 * and a world that already shows a screen on gameStarted keeps its own title.
 * Pinned rooms are never touched (this stage touches no rooms at all).
 */
export function screensStage(project: ProjectSpec, _options?: StageOptions): StageOutcome {
  const p = project.progression;
  const granted = new Set<string>([
    ...p.abilities.filter((a) => a.obtainedIn).map((a) => a.id),
    ...project.architect.rooms.flatMap((r) => r.contents.flatMap((c) => (c.kind === "pickup" ? [c.grants] : c.kind === "enemy" ? c.grants : []))),
  ]);
  const screens = grantScreens(project, [...granted].sort());
  const hasTitle = project.world.handlers.some((h) => h.on.type === "gameStarted" && h.do.some((e) => e.type === "showModal"));
  const needEnding = p.ending !== undefined || hasEndGame(project);
  let world = withMissing(project.world, [...(hasTitle ? [] : [titleModal(project)]), ...(needEnding ? [endingModal(project)] : []), ...screens.modals], screens.items);
  if (!hasTitle) {
    const show: Handler = { on: { type: "gameStarted" }, when: [], do: [{ type: "showModal", modal: TITLE_MODAL }] };
    world = { ...world, handlers: [show, ...world.handlers] };
  }
  world = { ...world, map: { ...world.map, enabled: true } };
  const added = world.modals.length - project.world.modals.length;
  return {
    project: { ...project, world },
    issues: [],
    summary: `screens: ${hasTitle ? "kept the title" : "title on start"}, ${added} new screen(s) (${screens.modals.length} message(s) for what the player gets), map on`,
  };
}

function hasEndGame(project: ProjectSpec): boolean {
  return project.world.rooms.some((r) => [...r.handlers, ...r.props.flatMap((p) => p.handlers), ...r.spawns.flatMap((s) => s.handlers)].some((h) => h.do.some((e) => e.type === "endGame" && e.modal === "ending")));
}
