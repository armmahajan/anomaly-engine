import { z } from "zod";
import { Id } from "../common.ts";

/**
 * The game wiki: the creator's game bible (narrative, characters, places,
 * lore, ...). Canon pages are the creator's (written or approved); drafts are
 * AI-written and awaiting review. Kinds are open: any snake_case name.
 */

export const PageStatus = z.enum(["canon", "draft"]);
export type PageStatus = z.infer<typeof PageStatus>;

const MAX_FIELDS = 24;

export const WikiPage = z.strictObject({
  id: Id.describe("Unique lowercase snake_case id; other pages link to it as [[id]]."),
  kind: Id.describe(
    "What the page is about: overview, character, place, faction, lore, story, or any new kind the game needs (lowercase snake_case, e.g. deity, ability).",
  ),
  title: z.string().trim().min(1).max(120),
  summary: z.string().max(300).default("").describe("One line."),
  body: z.string().max(20_000).default("").describe("Markdown. Link other pages with [[page_id]] or [[page_id|label]]."),
  fields: z
    .record(z.string().trim().min(1).max(40), z.string().max(1000))
    .default({})
    .refine((f) => Object.keys(f).length <= MAX_FIELDS, `at most ${MAX_FIELDS} fields`)
    .describe('Short facts as text, e.g. {"role": "antagonist", "motivation": "..."}.'),
  characterId: Id.optional().describe("The in-game character this page describes, if any."),
  weaponId: Id.optional().describe("The game weapon this page describes, if any."),
  status: PageStatus.describe("canon: written or approved by the creator. draft: AI-written, awaiting review."),
});
export type WikiPage = z.infer<typeof WikiPage>;

export const Wiki = z.strictObject({ pages: z.array(WikiPage).max(1000) });
export type Wiki = z.infer<typeof Wiki>;

export const defaultWiki = (): Wiki => ({ pages: [] });

/** Kinds the studio offers first, with the fields worth filling for each. Any other kind is fine too. */
export const SUGGESTED_KINDS = [
  { kind: "overview", label: "Overview", fields: ["genre", "tone", "themes", "player fantasy"] },
  { kind: "character", label: "Characters", fields: ["role", "in_game", "motivation", "appearance"] },
  { kind: "place", label: "Places", fields: ["mood", "appearance"] },
  { kind: "faction", label: "Factions", fields: ["goal", "leader"] },
  { kind: "lore", label: "Lore", fields: ["era"] },
  { kind: "story", label: "Story", fields: ["act", "order"] },
] as const;

export function kindLabel(kind: string): string {
  const suggested = SUGGESTED_KINDS.find((k) => k.kind === kind);
  if (suggested) return suggested.label;
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function suggestedFields(kind: string): readonly string[] {
  return SUGGESTED_KINDS.find((k) => k.kind === kind)?.fields ?? [];
}

/** Kinds in display order: suggested first, then the project's own kinds alphabetically. */
export function wikiKinds(wiki: Wiki): string[] {
  const used = new Set(wiki.pages.map((p) => p.kind));
  const suggested = SUGGESTED_KINDS.map((k) => k.kind as string).filter((k) => used.has(k));
  return [...suggested, ...[...used].filter((k) => !suggested.includes(k)).sort()];
}

export const WIKI_LINK = /\[\[([a-z][a-z0-9_]*)(?:\|([^\]\n]+))?\]\]/g;

/** Ids of the pages a body links to, in order of first appearance. */
export function wikiLinks(body: string): string[] {
  return [...new Set([...body.matchAll(WIKI_LINK)].map((m) => m[1]!))];
}
