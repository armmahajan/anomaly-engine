import { kindLabel, wikiGaps, wikiKinds, type ProjectSpec, type WikiPage } from "@anomaly/core";

const OVERVIEW_BODY_LIMIT = 4000;

const fieldsText = (page: WikiPage) =>
  Object.entries(page.fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");

function pageLine(page: WikiPage): string {
  const parts = [`- [${page.id}] "${page.title}" (${page.status})`];
  if (page.characterId) parts.push(`in-game: ${page.characterId}`);
  if (page.weaponId) parts.push(`weapon: ${page.weaponId}`);
  if (page.summary) parts.push(page.summary);
  const fields = fieldsText(page);
  if (fields) parts.push(`{${fields}}`);
  return parts.join(" · ");
}

/** The wiki as the narrative director sees it: every page in one line, the overview in full, gaps, and the game's cast. */
export function summarizeWiki(project: ProjectSpec): string {
  const { pages } = project.wiki;
  const canon = pages.filter((p) => p.status === "canon").length;
  const lines = [`Wiki: ${pages.length} page(s), ${canon} canon, ${pages.length - canon} draft.`];
  if (pages.length === 0) lines.push("(empty)");

  for (const page of pages.filter((p) => p.kind === "overview")) {
    const body = page.body.length > OVERVIEW_BODY_LIMIT ? `${page.body.slice(0, OVERVIEW_BODY_LIMIT)}…` : page.body;
    lines.push(`Overview [${page.id}] (${page.status}): "${page.title}". ${page.summary}`, fieldsText(page), body);
  }
  for (const kind of wikiKinds(project.wiki).filter((k) => k !== "overview")) {
    lines.push(`${kindLabel(kind)} (kind ${kind}):`, ...pages.filter((p) => p.kind === kind).map(pageLine));
  }

  const gaps = wikiGaps(project);
  lines.push(gaps.length ? `Gaps:\n${gaps.map((g) => `- ${g.message}`).join("\n")}` : "Gaps: none");
  lines.push(
    "Game cast (characters designed in the studio; ids are what characterId refers to):",
    ...project.characters.map((c) => `- ${c.id} "${c.name}" (${c.kind})`),
  );
  if (project.weapons.list.length) {
    lines.push("Game weapons (ids are what weaponId refers to):", ...project.weapons.list.map((w) => `- ${w.id} "${w.name}" (${w.attacks.length} attack(s))`));
  }
  return lines.filter(Boolean).join("\n");
}
