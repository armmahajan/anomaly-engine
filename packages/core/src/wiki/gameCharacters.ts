import { Character, type ProjectSpec } from "../schema.ts";
import { newEnemyCharacter } from "../defaultProject.ts";
import { uniqueId } from "../ids.ts";
import { fingerprint } from "../architect/preview.ts";
import type { WikiPage } from "./wiki.ts";

/**
 * Which wiki pages describe things that are in the game, and as what: a kind of
 * character (the schema's own character kinds: player, enemy) or a weapon. Read
 * from what the pages say, never from role names.
 *
 * A page is in the game when, in order:
 *  1. its `in_game` field (when filled in) starts with a game kind ("enemy", "player",
 *     "enemy (boss)", "weapon"); any other value ("none", "npc", ...) says it is not;
 *  2. it is linked to a character in the cast (characterId: that one's kind) or to a
 *     weapon (weaponId);
 *  3. the progression lists it (its id or linked id) as a region's enemy or boss;
 *  4. its wiki kind is a game kind (a page of kind "weapon");
 *  5. its `role` field starts with a game kind ("player character").
 * Anything else (story-only people, lore figures) is not in the game.
 */

/** The field the director writes on pages of things in the game: a game kind, or "none". */
export const IN_GAME_FIELD = "in_game";

export type CharacterKind = Character["kind"];
export const CHARACTER_KINDS = Character.options.map((o) => o.shape.kind.value) as CharacterKind[];
/** What a wiki page can make in the game: a character of a kind, or a weapon. */
export type GameKind = CharacterKind | "weapon";
export const GAME_KINDS: readonly GameKind[] = [...CHARACTER_KINDS, "weapon"];

const isCharacterKind = (kind: GameKind | null | undefined): kind is CharacterKind => !!kind && kind !== "weapon";

/** The game kind a phrase starts with ("Enemy (boss)" -> enemy), if any. */
function leadingKind(text: string | undefined): GameKind | null {
  const first = text?.trim().toLowerCase().match(/^[a-z]+/)?.[0];
  return GAME_KINDS.find((k) => k === first) ?? null;
}

export function pageGameKind(project: ProjectSpec, page: WikiPage): GameKind | null {
  const explicit = Object.entries(page.fields).find(([k]) => k.trim().toLowerCase().replace(/[\s-]+/g, "_") === IN_GAME_FIELD)?.[1];
  if (explicit?.trim()) return leadingKind(explicit);
  const linked = page.characterId !== undefined ? project.characters.find((c) => c.id === page.characterId) : undefined;
  if (linked) return linked.kind;
  if (page.weaponId !== undefined && project.weapons.list.some((w) => w.id === page.weaponId)) return "weapon";
  const listed = new Set(project.progression.regions.flatMap((r) => [...r.enemies, ...(r.boss ? [r.boss] : [])]));
  if (listed.has(page.id) || (page.characterId !== undefined && listed.has(page.characterId))) return "enemy";
  const ofKind = GAME_KINDS.find((k) => k === page.kind);
  if (ofKind) return ofKind;
  const role = Object.entries(page.fields).find(([k]) => k.trim().toLowerCase() === "role")?.[1];
  return leadingKind(role);
}

/** Every page that makes something in the game (a character or a weapon), with its kind. */
export function gamePages(project: ProjectSpec): { page: WikiPage; kind: GameKind }[] {
  return project.wiki.pages.flatMap((page) => {
    const kind = pageGameKind(project, page);
    return kind ? [{ page, kind }] : [];
  });
}

/** Every page that describes a game character, with its kind. */
export function gameCharacterPages(project: ProjectSpec): { page: WikiPage; kind: CharacterKind }[] {
  return gamePages(project).flatMap(({ page, kind }) => (isCharacterKind(kind) ? [{ page, kind }] : []));
}

/** Every page that describes a game weapon. */
export const gameWeaponPages = (project: ProjectSpec): WikiPage[] => gamePages(project).flatMap(({ page, kind }) => (kind === "weapon" ? [page] : []));

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
    if (!page || !isCharacterKind(kind)) continue;
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

/** A weapon's look, briefed from its page: a looks field, else its summary. */
function weaponBrief(page: WikiPage): string {
  const looks = Object.entries(page.fields).find(([k]) => /^(appearance|looks?)$/i.test(k.trim()))?.[1];
  return (looks?.trim() || page.summary || page.title).slice(0, 400);
}

/**
 * Make these pages' weapons: a weapon page not linked to a weapon gets a new one
 * (with the page's id when it is free; its name, description and look from the page;
 * no attacks until the build assistant writes them), linked to the page (weaponId);
 * an unlinked weapon that already has the page's id is linked instead. Pages already
 * linked keep their weapon. Pure: operations to apply. `created`: the new weapons
 * (they need attacks).
 */
export function weaponsFromPages(project: ProjectSpec, pageIds: string[]): { operations: { name: string; input: unknown }[]; created: string[] } {
  const operations: { name: string; input: unknown }[] = [];
  const created: string[] = [];
  const taken = new Set(project.weapons.list.map((w) => w.id));
  const linked = new Set(project.wiki.pages.flatMap((p) => (p.weaponId ? [p.weaponId] : [])));
  for (const id of pageIds) {
    const page = project.wiki.pages.find((p) => p.id === id);
    if (!page || pageGameKind(project, page) !== "weapon") continue;
    if (page.weaponId !== undefined && taken.has(page.weaponId)) continue;
    let weaponId = page.id;
    if (!taken.has(weaponId) || linked.has(weaponId)) {
      weaponId = uniqueId(page.id, taken);
      taken.add(weaponId);
      operations.push({ name: "createWeapon", input: { id: weaponId, name: page.title.slice(0, 60), description: page.summary.slice(0, 400), brief: weaponBrief(page) } });
      created.push(weaponId);
    }
    operations.push({ name: "updateWikiPage", input: { pageId: page.id, changes: { weaponId } } });
    linked.add(weaponId);
  }
  return { operations, created };
}
