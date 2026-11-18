import { Character, type ProjectSpec } from "../schema.ts";
import { newEnemyCharacter } from "../defaultProject.ts";
import { uniqueId } from "../ids.ts";
import { fingerprint } from "../architect/preview.ts";
import type { WikiPage } from "./wiki.ts";

/**
 * Which wiki pages describe characters that are in the game, and as what kind
 * of character. Read from what the pages say, never from role names: the
 * kinds are the schema's own character kinds (player, enemy).
 *
 * A page is a game character when, in order:
 *  1. its `in_game` field (when filled in) starts with a character kind ("enemy", "player",
 *     "enemy (boss)"); any other value ("none", "npc", ...) says it is not;
 *  2. it is linked (characterId) to a character in the cast: that one's kind;
 *  3. the progression lists it (its id or linked id) as a region's enemy or boss;
 *  4. its `role` field starts with a character kind ("player character").
 * Anything else (story-only people, lore figures) is not a game character.
 */

/** The field the director writes on character pages: a character kind, or "none". */
export const IN_GAME_FIELD = "in_game";

export type CharacterKind = Character["kind"];
export const CHARACTER_KINDS = Character.options.map((o) => o.shape.kind.value) as CharacterKind[];

/** The character kind a phrase starts with ("Enemy (boss)" -> enemy), if any. */
function leadingKind(text: string | undefined): CharacterKind | null {
  const first = text?.trim().toLowerCase().match(/^[a-z]+/)?.[0];
  return CHARACTER_KINDS.find((k) => k === first) ?? null;
}

export function pageGameKind(project: ProjectSpec, page: WikiPage): CharacterKind | null {
  const explicit = Object.entries(page.fields).find(([k]) => k.trim().toLowerCase().replace(/[\s-]+/g, "_") === IN_GAME_FIELD)?.[1];
  if (explicit?.trim()) return leadingKind(explicit);
  const linked = page.characterId !== undefined ? project.characters.find((c) => c.id === page.characterId) : undefined;
  if (linked) return linked.kind;
  const listed = new Set(project.progression.regions.flatMap((r) => [...r.enemies, ...(r.boss ? [r.boss] : [])]));
  if (listed.has(page.id) || (page.characterId !== undefined && listed.has(page.characterId))) return "enemy";
  const role = Object.entries(page.fields).find(([k]) => k.trim().toLowerCase() === "role")?.[1];
  return leadingKind(role);
}

/** Every page that describes a game character, with its kind. */
export function gameCharacterPages(project: ProjectSpec): { page: WikiPage; kind: CharacterKind }[] {
  return project.wiki.pages.flatMap((page) => {
    const kind = pageGameKind(project, page);
    return kind ? [{ page, kind }] : [];
  });
}

const PLACEHOLDER_COLORS = ["#5f9e6e", "#d08c3a", "#4f8fbf", "#b8577d", "#9c9a3f", "#7a6fbf", "#c4664a"];

/**
 * Make these pages' game characters part of the cast: an enemy page gets a new enemy
 * (with the page's id when it is free; a placeholder behavior until one is written)
 * or the unlinked enemy that already has its id; the player page is linked to the
 * player (who takes the page's title as name, unless another page already describes
 * them). Pages already linked keep their character. Pure: operations to apply.
 * `created`: new characters (they need a behavior); `draw`: characters these pages
 * now describe (they need art).
 */
export function castFromPages(project: ProjectSpec, pageIds: string[]): { operations: { name: string; input: unknown }[]; created: string[]; draw: string[] } {
  const operations: { name: string; input: unknown }[] = [];
  const created: string[] = [];
  const draw: string[] = [];
  const taken = new Set(project.characters.map((c) => c.id));
  const linked = new Set(project.wiki.pages.flatMap((p) => (p.characterId ? [p.characterId] : [])));
  const link = (pageId: string, characterId: string) => {
    operations.push({ name: "updateWikiPage", input: { pageId, changes: { characterId } } });
    linked.add(characterId);
    draw.push(characterId);
  };
  for (const id of pageIds) {
    const page = project.wiki.pages.find((p) => p.id === id);
    const kind = page && pageGameKind(project, page);
    if (!page || !kind) continue;
    const current = page.characterId !== undefined ? project.characters.find((c) => c.id === page.characterId) : undefined;
    if (current) {
      if (current.kind === kind) draw.push(current.id);
      continue;
    }
    if (kind === "player") {
      const player = project.characters.find((c) => c.kind === "player");
      if (!player || linked.has(player.id)) continue;
      link(page.id, player.id);
      if (player.name !== page.title) operations.push({ name: "updateCharacter", input: { characterId: player.id, changes: { name: page.title.slice(0, 80) } } });
      continue;
    }
    const same = project.characters.find((c) => c.id === page.id);
    if (same && same.kind === kind && !linked.has(same.id)) {
      link(page.id, same.id);
      continue;
    }
    const characterId = uniqueId(page.id, taken);
    taken.add(characterId);
    const color = PLACEHOLDER_COLORS[parseInt(fingerprint(characterId), 16) % PLACEHOLDER_COLORS.length];
    operations.push({ name: "createCharacter", input: { character: newEnemyCharacter(characterId, page.title.slice(0, 80), color) } });
    created.push(characterId);
    link(page.id, characterId);
  }
  return { operations, created, draw };
}
