import { z } from "zod";
import { Color, isDefaultArtDirection, type ProjectSpec, type WikiPage } from "@anomaly/core";
import { StageError, type ArtContext, type StageResult } from "./stages.ts";
import { ask } from "./world.ts";

/**
 * The art direction from the design: one text call reads the wiki (overview,
 * places, characters' looks) and writes the project's look (style, palette,
 * outlines). It only replaces a default direction: once the creator (or this
 * step) has chosen one, it is kept.
 */

const DirectionReply = z.object({
  style: z.string().min(40).max(1500),
  palette: z.array(Color).min(3).max(16),
  ink: Color,
  inkWidth: z.number().min(0).max(12),
  boil: z.number().min(0).max(1),
});

const PLACE_KINDS = /place|region|location|area|zone|biome|realm|world|city|land/;
const LOOK_FIELDS = /appear|look|visual|colou?r|mood|tone|atmosphere|setting|era|style|material|climate|terrain|theme|genre/i;

const plain = (text: string) => text.replace(/\[\[[a-z0-9_]+\|([^\]\n]+)\]\]|\[\[([a-z0-9_]+)\]\]/g, (_, label, id) => label ?? id.replace(/_/g, " ")).replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text);

function pageText(page: WikiPage, bodyMax: number, fields: (key: string) => boolean): string {
  const facts = Object.entries(page.fields)
    .filter(([k]) => fields(k))
    .map(([k, v]) => `${k}: ${plain(v)}`);
  return [page.summary ? `${page.title}: ${plain(page.summary)}` : page.title, ...facts, bodyMax > 0 ? clip(plain(page.body), bodyMax) : ""].filter(Boolean).join(". ");
}

/** The parts of the wiki that decide the look: the overview in full, then places and characters in brief. */
export function designText(project: ProjectSpec): string {
  const pages = project.wiki.pages;
  const overview = pages.filter((p) => p.kind === "overview");
  const regionPages = new Set(project.progression.regions.map((r) => r.wikiPageId).filter(Boolean));
  const places = pages.filter((p) => p.kind !== "overview" && (regionPages.has(p.id) || PLACE_KINDS.test(p.kind))).slice(0, 12);
  const characters = pages.filter((p) => p.characterId || p.kind === "character").slice(0, 8);
  return [
    `Game: ${project.name}`,
    ...overview.map((p) => `Overview. ${pageText(p, 2500, () => true)}`),
    places.length ? `Places:\n${places.map((p) => `- ${pageText(p, 400, (k) => LOOK_FIELDS.test(k))}`).join("\n")}` : "",
    characters.length ? `Characters:\n${characters.map((p) => `- ${pageText(p, 0, (k) => LOOK_FIELDS.test(k))}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function directionPrompt(project: ProjectSpec): string {
  return [
    "Write the art direction for this game from its design (below). It is added to every image prompt the game's art is painted from (characters, places, props, screens), so it must describe one coherent look shared by all of them.",
    "- style: 3-5 sentences (at most 700 characters) on the look in plain words: how it is rendered (2D game art with smooth, clean edges: not pixel art, not 3D), line and outline, shape language, color and value, light, and the mood and materials that run through the whole game. Take all of it from the design: its tone, genre, era, places and people. Describe traits; never name other games, films, studios or artists. Don't describe one particular place or character.",
    "- palette: 6-10 '#rrggbb' colors that fit the design (a dark, a light, the main hues, one or two accents).",
    "- ink: the outline color '#rrggbb'; inkWidth: the base outline width in px (0.8-3); boil: hand-drawn line wobble, 0 (steady) to 0.6 (lively).",
    `The design:\n${designText(project)}`,
    'Reply with JSON only: {"style", "palette": ["#rrggbb", ...], "ink", "inkWidth", "boil"}',
  ].join("\n");
}

export async function artDirectionStage(ctx: ArtContext): Promise<StageResult> {
  const project = ctx.project();
  if (!isDefaultArtDirection(project.art.direction)) {
    ctx.log({ text: "the art direction was chosen already; keeping it" });
    return { operations: [], summary: "kept the art direction that was chosen" };
  }
  if (!project.wiki.pages.some((p) => p.kind === "overview")) {
    throw new StageError("the wiki has no overview yet: write the game's overview (its pitch, tone and setting) first");
  }
  const reply = await ask(
    ctx,
    DirectionReply,
    {
      system: "You are the art director of an original 2D side-view game. You turn its design into a clear, specific visual direction that every artist can follow.",
      content: [{ type: "text", text: directionPrompt(project) }],
      maxTokens: 2000,
    },
    "writing the art direction",
  );
  const changes = {
    style: clip(reply.style.trim(), 1500),
    palette: reply.palette.slice(0, 16),
    ink: reply.ink,
    inkWidth: Math.min(4, Math.max(0.5, reply.inkWidth)),
    boil: Math.min(0.8, reply.boil),
  };
  ctx.log({ text: `art direction: ${changes.style}` });
  return { operations: [{ name: "setArtDirection", input: { changes } }], summary: "wrote the art direction from the wiki" };
}
