import { z } from "zod";
import { Id } from "../common.ts";
import type { OperationError, OperationResult } from "../operations.ts";
import { ProjectSpec } from "../schema.ts";
import { PageStatus } from "../wiki/wiki.ts";
import {
  Ability,
  Connection,
  findProgressionItem,
  progressionIds,
  Mechanic,
  Progression,
  Region,
  RewardSource,
  StoryBeat,
  type ProgressionItem,
} from "./progression.ts";

/**
 * Progression operations: same contract as ../operations.ts. Deletes
 * cascade so references never dangle. Type-only imports from
 * ../operations.ts avoid a module cycle.
 */

type Fail = { ok: false; error: OperationError };

const fail = (code: OperationError["code"], message: string, issues: OperationError["issues"] = []): Fail => ({
  ok: false,
  error: { code, message, issues },
});

const issuesOf = (error: z.ZodError, prefix = "") => error.issues.map((i) => ({ path: prefix + i.path.join("."), message: i.message }));

function commit(project: ProjectSpec, progression: Progression): OperationResult {
  const parsed = ProjectSpec.safeParse({ ...project, progression, revision: project.revision + 1 });
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    return fail("invalid_result", `operation would leave the project invalid: ${issues.map((i) => i.message).join("; ")}`, issues);
  }
  return { ok: true, project: parsed.data };
}

type ListName = "abilities" | "regions" | "connections" | "beats";
const LIST: Record<ProgressionItem["kind"], ListName> = { ability: "abilities", region: "regions", connection: "connections", beat: "beats" };

function notFound(project: ProjectSpec, id: string, kind?: ProgressionItem["kind"]): Fail {
  const ids = kind ? project.progression[LIST[kind]].map((i) => i.id) : progressionIds(project.progression);
  return fail("not_found", `no ${kind ?? "progression item"} "${id}"${ids.length ? ` (known: ${ids.join(", ")})` : " (none exist)"}`);
}

function create<T extends { id: string }>(list: ListName, schema: z.ZodType<T>, key: string) {
  const Input = z.strictObject({ [key]: z.unknown() });
  return (project: ProjectSpec, input: unknown): OperationResult => {
    const parsedInput = Input.safeParse(input);
    if (!parsedInput.success) return fail("invalid_input", `input must be { ${key} }`, issuesOf(parsedInput.error));
    const parsed = schema.safeParse(parsedInput.data[key]);
    if (!parsed.success) return fail("invalid_input", `${key} is invalid`, issuesOf(parsed.error, `${key}.`));
    if (findProgressionItem(project.progression, parsed.data.id)) {
      return fail("invalid_input", `progression id "${parsed.data.id}" is already used`);
    }
    return commit(project, { ...project.progression, [list]: [...project.progression[list], parsed.data] });
  };
}

/** Partial update; a null value removes an optional key. */
function update<T extends { id: string }>(list: ListName, schema: z.ZodType<T>, what: ProgressionItem["kind"], Input: z.ZodType<{ id: string; changes: Record<string, unknown> }>) {
  return (project: ProjectSpec, input: unknown): OperationResult => {
    const parsedInput = Input.safeParse(input);
    if (!parsedInput.success) return fail("invalid_input", `update ${what} input is malformed`, issuesOf(parsedInput.error));
    const { id, changes } = parsedInput.data;
    const items = project.progression[list] as unknown as T[];
    const index = items.findIndex((i) => i.id === id);
    if (index < 0) return notFound(project, id, what);
    if (Object.keys(changes).length === 0) return fail("invalid_input", "nothing to change");
    const candidate: Record<string, unknown> = { ...items[index] };
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete candidate[k];
      else if (v !== undefined) candidate[k] = v;
    }
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) return fail("invalid_input", `${what} "${id}" would be invalid`, issuesOf(parsed.error, "changes."));
    const next = items.slice();
    next[index] = parsed.data;
    return commit(project, { ...project.progression, [list]: next });
  };
}

const Ids = z.array(Id).max(8);

export const AbilityChanges = z.strictObject({
  name: z.string().optional(),
  mechanic: Mechanic.optional(),
  obtainedIn: z
    .strictObject({ regionId: Id, source: RewardSource, requires: Ids.default([]) })
    .nullable()
    .optional()
    .describe("Where the player gets it; replaces the old location. null: not decided."),
  wikiPageId: Id.nullable().optional().describe("null unlinks."),
  status: PageStatus.optional(),
});
export const RegionChanges = z.strictObject({
  name: z.string().optional(),
  rooms: z.number().int().optional(),
  enemies: z.array(Id).optional().describe("Replaces the list."),
  boss: Id.nullable().optional().describe("null: no boss."),
  wikiPageId: Id.nullable().optional().describe("null unlinks."),
  status: PageStatus.optional(),
});
export const ConnectionChanges = z.strictObject({
  from: Id.optional(),
  to: Id.optional(),
  oneWay: z.boolean().optional(),
  requires: Ids.optional().describe("Replaces the list."),
  status: PageStatus.optional(),
});
export const StoryBeatChanges = z.strictObject({
  wikiPageId: Id.optional(),
  regionId: Id.optional(),
  requires: Ids.optional().describe("Replaces the list."),
  status: PageStatus.optional(),
});

export const UpdateAbilityInput = z.strictObject({ abilityId: Id, changes: AbilityChanges });
export const UpdateRegionInput = z.strictObject({ regionId: Id, changes: RegionChanges });
export const UpdateConnectionInput = z.strictObject({ connectionId: Id, changes: ConnectionChanges });
export const UpdateStoryBeatInput = z.strictObject({ beatId: Id, changes: StoryBeatChanges });

const byId = <S extends z.ZodType<{ changes: Record<string, unknown> }>>(schema: S, key: string) =>
  schema.transform((v) => ({ id: (v as Record<string, unknown>)[key] as string, changes: v.changes }));

export const createAbility = create("abilities", Ability, "ability");
export const createRegion = create("regions", Region, "region");
export const createConnection = create("connections", Connection, "connection");
export const createStoryBeat = create("beats", StoryBeat, "beat");
export const updateAbility = update("abilities", Ability, "ability", byId(UpdateAbilityInput, "abilityId"));
export const updateRegion = update("regions", Region, "region", byId(UpdateRegionInput, "regionId"));
export const updateConnection = update("connections", Connection, "connection", byId(UpdateConnectionInput, "connectionId"));
export const updateStoryBeat = update("beats", StoryBeat, "beat", byId(UpdateStoryBeatInput, "beatId"));

export const SetProgressionEndsInput = z.strictObject({
  start: Id.nullable().optional().describe("Region where the game starts; null clears it."),
  ending: Id.nullable().optional().describe("Region whose arrival finishes the game; null clears it."),
});

export function setProgressionEnds(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = SetProgressionEndsInput.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "setProgressionEnds input is malformed", issuesOf(parsed.error));
  const next: Progression = { ...project.progression };
  for (const key of ["start", "ending"] as const) {
    const value = parsed.data[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return commit(project, next);
}

export const ProgressionItemRef = z.strictObject({ id: Id });

/** Approve a draft: it becomes canon. */
export function acceptProgressionItem(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = ProgressionItemRef.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "acceptProgressionItem input is malformed", issuesOf(parsed.error));
  const found = findProgressionItem(project.progression, parsed.data.id);
  if (!found) return notFound(project, parsed.data.id);
  if (found.item.status === "canon") return fail("invalid_input", `"${found.item.id}" is already canon`);
  const list = LIST[found.kind];
  const items = (project.progression[list] as { id: string }[]).map((i) => (i.id === found.item.id ? { ...i, status: "canon" } : i));
  return commit(project, { ...project.progression, [list]: items });
}

/** Delete anything by id. References to it are cleaned up, never left dangling. */
export function deleteProgressionItem(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = ProgressionItemRef.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "deleteProgressionItem input is malformed", issuesOf(parsed.error));
  const { id } = parsed.data;
  const found = findProgressionItem(project.progression, id);
  if (!found) return notFound(project, id);
  const p = project.progression;
  const keep = <T extends { id: string }>(items: T[]) => items.filter((i) => i.id !== id);
  switch (found.kind) {
    case "region": {
      const next: Progression = {
        ...p,
        regions: keep(p.regions),
        connections: p.connections.filter((c) => c.from !== id && c.to !== id),
        beats: p.beats.filter((b) => b.regionId !== id),
        abilities: p.abilities.map((a) => {
          if (a.obtainedIn?.regionId !== id) return a;
          const { obtainedIn: _, ...rest } = a;
          return rest;
        }),
      };
      if (next.start === id) delete next.start;
      if (next.ending === id) delete next.ending;
      return commit(project, next);
    }
    case "ability": {
      const without = (ids: string[]) => ids.filter((r) => r !== id);
      return commit(project, {
        ...p,
        abilities: keep(p.abilities).map((a) => (a.obtainedIn ? { ...a, obtainedIn: { ...a.obtainedIn, requires: without(a.obtainedIn.requires) } } : a)),
        connections: p.connections.map((c) => ({ ...c, requires: without(c.requires) })),
        beats: p.beats.map((b) => ({ ...b, requires: without(b.requires) })),
      });
    }
    case "connection":
      return commit(project, { ...p, connections: keep(p.connections) });
    case "beat":
      return commit(project, { ...p, beats: keep(p.beats) });
  }
}

/** Remove an enemy character from every region (called when the character is deleted). */
export function withoutEnemy(progression: Progression, characterId: string): Progression {
  return {
    ...progression,
    regions: progression.regions.map((r) => {
      const { boss, ...rest } = r;
      return { ...rest, enemies: r.enemies.filter((e) => e !== characterId), ...(boss !== undefined && boss !== characterId && { boss }) };
    }),
  };
}

export const progressionOperations = {
  createRegion,
  updateRegion,
  createAbility,
  updateAbility,
  createConnection,
  updateConnection,
  createStoryBeat,
  updateStoryBeat,
  setProgressionEnds,
  acceptProgressionItem,
  deleteProgressionItem,
};
export type ProgressionOperationName = keyof typeof progressionOperations;
export const PROGRESSION_OPERATION_NAMES = Object.keys(progressionOperations) as ProgressionOperationName[];
