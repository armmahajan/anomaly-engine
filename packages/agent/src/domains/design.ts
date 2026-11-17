import { z } from "zod";
import { abilityGrants, Id, lintProgressionWorld, progressionReport, type Ability, type ProjectSpec } from "@anomaly/core";
import type { DomainTools } from "./types.ts";

/**
 * The build assistant's view of the design documents the director writes:
 * read tools for wiki pages and the progression, and a design summary
 * (regions and their rooms in the world, abilities and where they're given,
 * gates, the cast's wiki pages).
 */

const roomsOf = (project: ProjectSpec, regionId: string) => project.world.rooms.filter((r) => r.regionId === regionId).map((r) => r.id);

/** Where in the world an ability is given, e.g. "sanctum/guardian_1", or "not in the world yet". */
const givenAt = (project: ProjectSpec, ability: Ability) => abilityGrants(project, ability).join(", ") || "not in the world yet";

const where = (a: Ability) => (a.obtainedIn ? `in ${a.obtainedIn.regionId} (${a.obtainedIn.source}${a.obtainedIn.requires.length ? `, needs ${a.obtainedIn.requires.join(" + ")}` : ""})` : "location undecided");

function summary(project: ProjectSpec): string[] {
  const { progression: p, wiki } = project;
  if (p.regions.length === 0 && p.abilities.length === 0 && wiki.pages.length === 0) return [];
  const cast = wiki.pages.filter((page) => page.characterId).map((page) => `${page.characterId} [wiki ${page.id}]`);
  return [
    `Design (the director's documents; getProgression, getWikiPage): start ${p.start ?? "unset"}, ending ${p.ending ?? "unset"}; ${wiki.pages.length} wiki page(s).`,
    ...p.regions.map((r) => {
      const rooms = roomsOf(project, r.id);
      const gives = p.abilities.filter((a) => a.obtainedIn?.regionId === r.id).map((a) => `${a.id} (${givenAt(project, a)})`);
      return (
        `- region ${r.id} "${r.name}"${r.wikiPageId ? ` [wiki ${r.wikiPageId}]` : ""}: rooms ${rooms.join(", ") || "none yet"} (planned ${r.rooms})` +
        (gives.length ? `; gives ${gives.join(", ")}` : "") +
        (r.boss ? `; boss ${r.boss}` : "") +
        (r.enemies.length ? `; enemies ${r.enemies.join(", ")}` : "")
      );
    }),
    ...p.abilities.map((a) => `- ability ${a.id} "${a.name}" (${a.mechanic}) ${where(a)}`),
    ...p.connections.map((c) => `- gate ${c.id}: ${c.from} ${c.oneWay ? "->" : "<->"} ${c.to}${c.requires.length ? ` needs ${c.requires.join(" + ")}` : " open"}`),
    ...(cast.length ? [`Cast: ${cast.join(", ")}`] : []),
  ];
}

const PageRef = z.strictObject({ pageId: Id });

export const designTools: DomainTools<never> = {
  descriptions: {},
  schemas: {},
  summary,
  reads: [
    {
      name: "getWikiPage",
      description: "One wiki page in full (the creator's game bible): title, summary, body, fields, its in-game character.",
      schema: PageRef,
      run: (project, args) => {
        const parsed = PageRef.safeParse(args);
        const page = parsed.success && project.wiki.pages.find((pg) => pg.id === parsed.data.pageId);
        if (!page) return { ok: false, error: { code: "not_found", message: `known pages: ${project.wiki.pages.map((pg) => pg.id).join(", ") || "none"}` } };
        const character = page.characterId ? project.characters.find((c) => c.id === page.characterId) : undefined;
        const { progression: p } = project;
        const usedBy = [...p.regions, ...p.abilities].filter((i) => i.wikiPageId === page.id).map((i) => i.id);
        return { ok: true, page, ...(character && { character: { id: character.id, name: character.name, kind: character.kind } }), ...(usedBy.length && { describes: usedBy }) };
      },
    },
    {
      name: "getProgression",
      description: "The game's structure: regions (their wiki pages and rooms in the world), abilities and where they're obtained/given, gated connections, start/ending, and whether it's finishable.",
      schema: z.strictObject({}),
      run: (project) => {
        const { progression: p } = project;
        const report = progressionReport(project);
        return {
          ok: true,
          start: p.start,
          ending: p.ending,
          regions: p.regions.map((r) => ({ ...r, worldRooms: roomsOf(project, r.id) })),
          abilities: p.abilities.map((a) => ({ ...a, givenAt: abilityGrants(project, a) })),
          connections: p.connections,
          beats: p.beats,
          finishable: report.finishable,
          criticalPath: report.criticalPath,
          issues: report.issues.map((i) => i.message),
          worldWarnings: lintProgressionWorld(project).map((w) => w.message),
        };
      },
    },
  ],
};
