import { z } from "zod";
import {
  Ability,
  AbilityChanges,
  Connection,
  ConnectionChanges,
  findProgressionItem,
  Id,
  progressionReport,
  Region,
  RegionChanges,
  SetProgressionEndsInput,
  StoryBeat,
  StoryBeatChanges,
  type OperationName,
  type ProjectSpec,
} from "@anomaly/core";
import { stageOperation, type Draft, type ToolSpec } from "../tools.ts";

/** The progression as the director sees it: every item in one line, the spheres, the critical path and the issues. */
export function summarizeProgression(project: ProjectSpec): string {
  const p = project.progression;
  if (p.regions.length === 0 && p.abilities.length === 0) return "Progression: (empty)";
  const report = progressionReport(project);
  const needs = (ids: string[]) => (ids.length ? `needs ${ids.join(" + ")}` : "open");
  const sphere = (k: number | undefined) => (k === undefined ? "unreachable" : `sphere ${k}`);
  const lines = [
    `Progression: ${p.regions.length} region(s), ${p.abilities.length} ability(ies), ${p.connections.length} connection(s), ${p.beats.length} story beat(s). Start: ${p.start ?? "none"}. Ending: ${p.ending ?? "none"}.`,
    "Regions:",
    ...p.regions.map((r) =>
      [
        `- [${r.id}] "${r.name}" (${r.status})`,
        sphere(report.regionSphere[r.id]),
        `${r.rooms} rooms`,
        r.enemies.length ? `enemies: ${r.enemies.join(", ")}` : "",
        r.boss ? `boss: ${r.boss}` : "",
        r.wikiPageId ? `wiki: ${r.wikiPageId}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    "Abilities:",
    ...p.abilities.map((a) =>
      [
        `- [${a.id}] "${a.name}" (${a.status})`,
        a.mechanic,
        a.obtainedIn ? `in ${a.obtainedIn.regionId} (${a.obtainedIn.source}, ${needs(a.obtainedIn.requires)})` : "not placed",
        a.obtainedIn ? (report.abilitySphere[a.id] === undefined ? "never collected" : `collected in sphere ${report.abilitySphere[a.id]}`) : "",
        a.wikiPageId ? `wiki: ${a.wikiPageId}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    "Connections:",
    ...p.connections.map((c) => `- [${c.id}] ${c.from} ${c.oneWay ? "-> (one-way)" : "<->"} ${c.to} · ${needs(c.requires)} (${c.status})`),
  ];
  if (p.beats.length) {
    lines.push("Story beats:", ...p.beats.map((b) => `- [${b.id}] page ${b.wikiPageId} in ${b.regionId} · ${needs(b.requires)} · ${sphere(report.beatSphere[b.id])} (${b.status})`));
  }
  if (report.spheres.length) {
    lines.push(
      `Spheres: ${report.spheres.map((s, k) => `${k}: ${s.regions.join(", ") || "-"}${s.abilities.length ? ` (+${s.abilities.join(", ")})` : ""}`).join(" | ")}`,
      `Finishable: ${report.finishable ? "yes" : "no"}. Critical path: ${report.criticalPath.join(" -> ") || "none"}.`,
    );
  }
  lines.push(report.issues.length ? `Issues:\n${report.issues.map((i) => `- ${i.severity.toUpperCase()} ${i.code}: ${i.message}`).join("\n")}` : "Issues: none");
  return lines.join("\n");
}

const ConfirmedByCreator = z
  .boolean()
  .optional()
  .describe("Only for canon items: true when the creator explicitly asked for this change in this conversation.");

const invalid = (error: z.ZodError) => ({
  ok: false,
  error: { code: "invalid_input", message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
});

/** Refuse to touch a canon item unless the creator asked for it. */
function canonGuard(draft: Draft, id: string | undefined, confirmed: boolean | undefined, action: string) {
  const found = id === undefined ? undefined : findProgressionItem(draft.current.progression, id);
  if (found?.item.status !== "canon" || confirmed) return null;
  return {
    ok: false,
    error: {
      code: "canon_protected",
      message: `"${id}" is canon: the creator made or approved it. Don't ${action} it on your own; ask the creator. Only if they asked for exactly this in this conversation, call again with confirmedByCreator: true.`,
    },
  };
}

const wikiWarnings = (id: string) => (project: ProjectSpec) =>
  progressionReport(project)
    .issues.filter((i) => i.code === "missing_wiki_page" && i.ids[0] === id)
    .map((i) => `${i.message} Fine if you create that page later this turn.`);

type Kind = { name: string; op: OperationName; key: string; schema: z.ZodObject };

function createTool({ name, op, key, schema }: Kind, description: string): ToolSpec {
  const Input = z.strictObject({ [key]: schema.omit({ status: true }) });
  return {
    name,
    description,
    schema: Input,
    run: (draft, args) => {
      const parsed = Input.safeParse(args);
      if (!parsed.success) return invalid(parsed.error);
      const item = parsed.data[key] as { id: string };
      return stageOperation(draft, op, { [key]: { ...item, status: "draft" } }, wikiWarnings(item.id));
    },
  };
}

function updateTool(name: string, op: OperationName, idKey: string, changes: z.ZodObject, description: string): ToolSpec {
  const Input = z.strictObject({ [idKey]: Id, changes: changes.omit({ status: true }), confirmedByCreator: ConfirmedByCreator });
  return {
    name,
    description,
    schema: Input,
    run: (draft, args) => {
      const parsed = Input.safeParse(args);
      if (!parsed.success) return invalid(parsed.error);
      const { confirmedByCreator, ...input } = parsed.data as Record<string, unknown> & { confirmedByCreator?: boolean };
      const id = input[idKey] as string;
      return canonGuard(draft, id, confirmedByCreator, "change") ?? stageOperation(draft, op, input, wikiWarnings(id));
    },
  };
}

const EndsInput = SetProgressionEndsInput.extend({ confirmedByCreator: ConfirmedByCreator });
const DeleteInput = z.strictObject({ id: Id, confirmedByCreator: ConfirmedByCreator });

export const progressionTools: ToolSpec[] = [
  {
    name: "getProgression",
    description:
      "The progression in full: regions, abilities, connections, story beats, the spheres (what is reachable in which order), the critical path and every issue (errors: unbeatable, soft-locks, unobtainable abilities). Includes changes staged this turn.",
    schema: z.strictObject({}),
    run: (draft) => ({ ok: true, progression: summarizeProgression(draft.current) }),
  },
  createTool({ name: "createRegion", op: "createRegion", key: "region", schema: Region }, "Add a region (a connected area of the world). Saved as a draft."),
  createTool(
    { name: "createAbility", op: "createAbility", key: "ability", schema: Ability },
    "Add an ability or key item and (optionally) where the player gets it. The region must exist. Saved as a draft.",
  ),
  createTool(
    { name: "createConnection", op: "createConnection", key: "connection", schema: Connection },
    "Join two existing regions, optionally one-way and gated by abilities. Saved as a draft.",
  ),
  createTool(
    { name: "createStoryBeat", op: "createStoryBeat", key: "beat", schema: StoryBeat },
    "Place a story page (kind story) in the structure: where it happens and what the player has by then. Saved as a draft.",
  ),
  updateTool("updateRegion", "updateRegion", "regionId", RegionChanges, "Change a region (only the fields given). Canon items need the creator's request."),
  updateTool("updateAbility", "updateAbility", "abilityId", AbilityChanges, "Change an ability: name, mechanic, where it is obtained, wiki page. Canon items need the creator's request."),
  updateTool("updateConnection", "updateConnection", "connectionId", ConnectionChanges, "Change a connection: ends, one-way, requirements. Canon items need the creator's request."),
  updateTool("updateStoryBeat", "updateStoryBeat", "beatId", StoryBeatChanges, "Change a story beat. Canon items need the creator's request."),
  {
    name: "setProgressionEnds",
    description: "Set the start region and/or the ending region (arriving there finishes the game). Changing an end that is a canon region needs the creator's request.",
    schema: EndsInput,
    run: (draft, args) => {
      const parsed = EndsInput.safeParse(args);
      if (!parsed.success) return invalid(parsed.error);
      const { confirmedByCreator, ...input } = parsed.data;
      const current = draft.current.progression;
      const changing = (["start", "ending"] as const).filter((k) => input[k] !== undefined && input[k] !== current[k]).map((k) => current[k]);
      const guard = changing.map((id) => canonGuard(draft, id, confirmedByCreator, "move the start or ending away from")).find(Boolean);
      return guard ?? stageOperation(draft, "setProgressionEnds", input, () => []);
    },
  },
  {
    name: "deleteProgressionItem",
    description: "Delete a region, ability, connection or story beat by id. References to it are removed too. Canon items need the creator's request.",
    schema: DeleteInput,
    run: (draft, args) => {
      const parsed = DeleteInput.safeParse(args);
      if (!parsed.success) return invalid(parsed.error);
      const { id, confirmedByCreator } = parsed.data;
      return canonGuard(draft, id, confirmedByCreator, "delete") ?? stageOperation(draft, "deleteProgressionItem", { id }, () => []);
    },
  },
];
