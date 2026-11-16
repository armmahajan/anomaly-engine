import type { ProjectSpec } from "../schema.ts";
import { wikiLinks } from "./wiki.ts";

/** Something the wiki is missing or gets wrong. Never blocks an edit. */
export interface WikiGap {
  code: "no_overview" | "broken_link" | "missing_character" | "unwritten_character";
  message: string;
  pageId?: string;
  characterId?: string;
}

export function wikiGaps(project: ProjectSpec): WikiGap[] {
  const { pages } = project.wiki;
  const ids = new Set(pages.map((p) => p.id));
  const characters = new Map(project.characters.map((c) => [c.id, c]));
  const gaps: WikiGap[] = [];

  if (!pages.some((p) => p.kind === "overview")) {
    gaps.push({ code: "no_overview", message: "There is no overview page (the game's pitch, tone and themes)." });
  }
  for (const page of pages) {
    for (const target of wikiLinks(page.body)) {
      if (!ids.has(target)) {
        gaps.push({ code: "broken_link", pageId: page.id, message: `"${page.title}" links to [[${target}]], which doesn't exist.` });
      }
    }
    if (page.characterId !== undefined && !characters.has(page.characterId)) {
      gaps.push({
        code: "missing_character",
        pageId: page.id,
        characterId: page.characterId,
        message: `"${page.title}" describes the in-game character "${page.characterId}", which no longer exists.`,
      });
    }
  }
  const written = new Set(pages.map((p) => p.characterId));
  for (const character of project.characters) {
    if (!written.has(character.id)) {
      gaps.push({
        code: "unwritten_character",
        characterId: character.id,
        message: `${character.name} (${character.kind}) is in the game but has no wiki page.`,
      });
    }
  }
  return gaps;
}
