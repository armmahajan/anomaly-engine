import type { ProjectSpec } from "../../schema.ts";
import type { Effect, GameCondition } from "../../events/events.ts";
import { MOVEMENT_ABILITIES, type MovementAbility } from "../../movement/params.ts";
import type { Ability } from "../../progression/progression.ts";
import type { Item, Modal, World } from "../../world/world.ts";

/**
 * What the player gets, as primitives: a progression ability whose mechanic is
 * a movement ability is granted with grantAbility; anything else (a key, a
 * story item, swim until it is playable) is an item with the ability's id,
 * given with giveItem and defined in world.items. Every one has a message
 * modal ("You got X"), shown by the handler that gives it.
 *
 * Shared by the population stage (which creates the modals and items its
 * handlers use, so its output is valid on its own) and the screens stage
 * (which adds the ones nothing has created yet). Both only add what is
 * missing: a modal or item that exists (the creator's edit, or an earlier
 * run) is kept as it is.
 */

const MAX_ID = 64;

/** A valid id (lowercase snake_case, at most 64 characters) from parts; long ones end in a short hash. */
export function safeId(...parts: string[]): string {
  let id = parts
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(id)) id = `x_${id}`;
  if (id.length <= MAX_ID) return id;
  return `${id.slice(0, MAX_ID - 8).replace(/_+$/, "")}_${hash(id)}`;
}

export function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36).slice(0, 7);
}

export const isMovement = (mechanic: string): mechanic is MovementAbility => mechanic in MOVEMENT_ABILITIES;

export const findAbility = (project: ProjectSpec, id: string): Ability | undefined => project.progression.abilities.find((a) => a.id === id);

/** The effect that gives the player a progression ability or key. */
export function grantEffect(project: ProjectSpec, id: string): Effect {
  const ability = findAbility(project, id);
  if (ability && isMovement(ability.mechanic)) return { type: "grantAbility", ability: ability.mechanic };
  return { type: "giveItem", item: id, count: 1 };
}

/** Holds while the player has it. */
export function hasCondition(project: ProjectSpec, id: string): GameCondition {
  const ability = findAbility(project, id);
  if (ability && isMovement(ability.mechanic)) return { type: "ability", ability: ability.mechanic };
  return { type: "item", item: id, atLeast: 1 };
}

/** Is it an item (not a movement ability)? */
export function isItemGrant(project: ProjectSpec, id: string): boolean {
  const ability = findAbility(project, id);
  return !ability || !isMovement(ability.mechanic);
}

export const messageModalId = (id: string) => safeId("got", id);
export const TITLE_MODAL = "title";
export const ENDING_MODAL = "ending";

const titleCase = (id: string) => id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const abilityName = (project: ProjectSpec, id: string) => findAbility(project, id)?.name ?? titleCase(id);

/** Wiki links as plain text: [[id|label]] -> label, [[id]] -> the page's title. */
export function plainText(project: ProjectSpec, text: string): string {
  return text.replace(/\[\[([a-z][a-z0-9_]*)(?:\|([^\]\n]+))?\]\]/g, (_, id: string, label?: string) => label ?? project.wiki.pages.find((p) => p.id === id)?.title ?? titleCase(id));
}

/** A page's one line: its summary, else its body's first paragraph (plain text). */
export function pageLine(project: ProjectSpec, pageId: string | undefined): string {
  const page = pageId ? project.wiki.pages.find((p) => p.id === pageId) : undefined;
  if (!page) return "";
  const text = page.summary.trim() || (page.body.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith("#")) ?? "").trim();
  return plainText(project, text);
}

const sentence = (text: string) => (text && !/[.!?]$/.test(text) ? `${text}.` : text);

/** "You got X": its name, what it is (its wiki page), how to use it (a movement ability) and what it opens. */
export function messageModal(project: ProjectSpec, id: string): Modal {
  const ability = findAbility(project, id);
  const name = abilityName(project, id);
  const lines: string[] = [];
  const about = pageLine(project, ability?.wikiPageId ?? project.wiki.pages.find((p) => p.id === id)?.id);
  if (about) lines.push(sentence(about));
  if (ability && isMovement(ability.mechanic)) lines.push(MOVEMENT_ABILITIES[ability.mechanic]);
  const opens = project.progression.connections
    .filter((c) => c.requires.includes(id))
    .map((c) => project.progression.regions.find((r) => r.id === c.to)?.name)
    .filter((n): n is string => !!n);
  if (opens.length) lines.push(`It opens the way to ${[...new Set(opens)].join(" and ")}.`);
  return { id: messageModalId(id), title: `You got ${name}`.slice(0, 120), body: lines.join("\n\n").slice(0, 4000), image: null, buttons: [] };
}

/** The item a key is (its id is the ability's id). */
export function grantItem(project: ProjectSpec, id: string): Item {
  const ability = findAbility(project, id);
  const description = pageLine(project, ability?.wikiPageId) || messageModal(project, id).body;
  return { id, name: abilityName(project, id).slice(0, 80), description: description.slice(0, 400), color: "#e8c547" };
}

/** The world with these modals and items added where missing (existing ones are kept). */
export function withMissing(world: World, modals: readonly Modal[], items: readonly Item[]): World {
  const haveModal = new Set(world.modals.map((m) => m.id));
  const haveItem = new Set(world.items.map((i) => i.id));
  const newModals = dedupe(modals).filter((m) => !haveModal.has(m.id));
  const newItems = dedupe(items).filter((i) => !haveItem.has(i.id));
  if (!newModals.length && !newItems.length) return world;
  return { ...world, modals: [...world.modals, ...newModals], items: [...world.items, ...newItems] };
}

function dedupe<T extends { id: string }>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** The modals and items giving `ids` needs. */
export function grantScreens(project: ProjectSpec, ids: Iterable<string>): { modals: Modal[]; items: Item[] } {
  const list = [...new Set(ids)];
  return {
    modals: list.map((id) => messageModal(project, id)),
    items: list.filter((id) => isItemGrant(project, id)).map((id) => grantItem(project, id)),
  };
}

/** The ending screen: the ending region's line from the wiki, and thanks. */
export function endingModal(project: ProjectSpec): Modal {
  const p = project.progression;
  const region = p.regions.find((r) => r.id === p.ending);
  const line = region ? pageLine(project, region.wikiPageId) : "";
  const body = [line ? sentence(line) : region ? `You reached ${region.name}.` : "You made it.", `Thanks for playing ${project.name}.`].join("\n\n");
  return { id: ENDING_MODAL, title: "The End", body: body.slice(0, 4000), image: null, buttons: [] };
}

/** The title screen: the game's name and its overview's line. */
export function titleModal(project: ProjectSpec): Modal {
  const overview = project.wiki.pages.find((p) => p.kind === "overview");
  const body = overview ? pageLine(project, overview.id) : "";
  return { id: TITLE_MODAL, title: (project.name || overview?.title || "Untitled").slice(0, 120), body: body.slice(0, 4000), image: null, buttons: [{ label: "Begin", do: [] }] };
}
