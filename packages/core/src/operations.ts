import { z } from "zod";
import { Character, EnemyStats, PlayerStats, ProjectSpec, type EnemyCharacter } from "./schema.ts";
import { Id } from "./common.ts";
import type { Transition } from "./behavior.ts";
import { wikiOperations } from "./wiki/operations.ts";
import { progressionOperations, withoutEnemy } from "./progression/operations.ts";
import { architectOperations } from "./architect/operations.ts";
import { artOperations } from "./art/operations.ts";
import { worldOperations } from "./art/worldOperations.ts";
import { withoutRoomSpawns, worldRoomOperations } from "./world/operations.ts";
import { handlerOperations } from "./events/operations.ts";
import { propOperations } from "./props/operations.ts";
import { modalOperations } from "./modals/operations.ts";
import { combatOperations } from "./combat/operations.ts";

/**
 * Project operations: pure functions (project, untrusted input) -> result.
 * The UI and (later) the AI both edit the project only through these.
 * Inputs are `unknown` on purpose: every caller is treated as untrusted.
 */

export interface Issue {
  path: string;
  message: string;
}

export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "invalid_result"
  /** The project can't be edited right now (e.g. a playtest is running). */
  | "locked"
  /** The edit was based on an older revision than the current one. */
  | "stale_revision"
  | "nothing_to_undo"
  /** The request itself (not the operation input) was malformed. */
  | "invalid_request"
  /** The project server could not be reached. */
  | "unavailable"
  /** Missing or wrong studio access token. */
  | "unauthorized";

export interface OperationError {
  code: ErrorCode;
  message: string;
  issues: Issue[];
}

export type OperationResult =
  | { ok: true; project: ProjectSpec }
  | { ok: false; error: OperationError };

export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Hint listing valid ids, so a caller (or model) can correct a bad reference. */
function known(ids: Iterable<string>): string {
  const list = [...ids];
  return list.length > 0 ? ` (known: ${list.join(", ")})` : " (none exist)";
}

const noCharacter = (project: ProjectSpec, id: string) =>
  fail("not_found", `no character with id "${id}"${known(project.characters.map((c) => c.id))}`);
export function fail(code: ErrorCode, message: string, issues: Issue[] = []): { ok: false; error: OperationError } {
  return { ok: false, error: { code, message, issues } };
}

export type ValidationResult =
  | { ok: true; project: ProjectSpec }
  | { ok: false; issues: Issue[] };

export function validateProject(input: unknown): ValidationResult {
  const parsed = ProjectSpec.safeParse(input);
  return parsed.success ? { ok: true, project: parsed.data } : { ok: false, issues: toIssues(parsed.error) };
}

export const UpdateCharacterInput = z.strictObject({
  characterId: Id,
  changes: z.strictObject({
    name: z.string().optional(),
    color: z.string().optional(),
    size: z.strictObject({ width: z.number().optional(), height: z.number().optional() }).optional(),
    movement: z.enum(["ground", "flying"]).optional().describe("Enemies only."),
    // Checked against the character's own stats schema below.
    stats: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Stats to change. Player: runSpeed, jumpVelocity, health, attackDamage, attackReach, attackCooldown, pogoVelocity, maxFallSpeed, coyoteTime, jumpBuffer. Enemy: knockback, health, contactDamage, armor (0-1: resists being pushed back by sword hits).",
      ),
    abilities: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        "Player only: movement ability tuning to change, e.g. {\"dash\": {\"distance\": 260}}. Abilities: dash {distance, duration, cooldown}, doubleJump {jumps, velocity}, wallJump {slideSpeed, velocity, kickSpeed, kickTime}, glide {fallSpeed}, groundPound {speed}.",
      ),
  }),
});

export type UpdateCharacterInput = z.infer<typeof UpdateCharacterInput>;

const statsSchemaFor = {
  player: PlayerStats.partial(),
  enemy: EnemyStats.partial(),
} as const;

/** Partially update a character type. Applies to every spawn of it. */
export function updateCharacter(project: ProjectSpec, input: unknown): OperationResult {
  const parsedInput = UpdateCharacterInput.safeParse(input);
  if (!parsedInput.success) {
    return fail("invalid_input", "updateCharacter input is malformed", toIssues(parsedInput.error));
  }
  const { characterId, changes } = parsedInput.data;

  const index = project.characters.findIndex((c) => c.id === characterId);
  const current = project.characters[index];
  if (!current) {
    return noCharacter(project, characterId);
  }

  if (changes.abilities !== undefined && current.kind !== "player") {
    return fail("invalid_input", `"${characterId}" is a ${current.kind}; only the player has movement abilities`);
  }
  if (changes.movement !== undefined && current.kind !== "enemy") {
    return fail("invalid_input", `"${characterId}" is a ${current.kind}; only enemies have a movement type`);
  }

  let statChanges: Record<string, unknown> = {};
  if (changes.stats) {
    const parsedStats = statsSchemaFor[current.kind].safeParse(changes.stats);
    if (!parsedStats.success) {
      return fail(
        "invalid_input",
        `invalid stats for ${current.kind} "${characterId}"`,
        toIssues(parsedStats.error).map((i) => ({ ...i, path: `changes.stats.${i.path}` })),
      );
    }
    // Only the named stats: .partial() still fills in defaults for the rest.
    const named = parsedStats.data as Record<string, unknown>;
    statChanges = Object.fromEntries(Object.keys(changes.stats).map((k) => [k, named[k]]));
  }

  const candidate = {
    ...current,
    ...(changes.name !== undefined && { name: changes.name }),
    ...(changes.color !== undefined && { color: changes.color }),
    ...(changes.movement !== undefined && { movement: changes.movement }),
    size: { ...current.size, ...changes.size },
    stats: { ...current.stats, ...statChanges },
    ...(current.kind === "player" &&
      changes.abilities && {
        abilities: Object.fromEntries(
          Object.entries({ ...current.abilities, ...changes.abilities }).map(([k, v]) => [k, { ...(current.abilities as Record<string, object>)[k], ...v }]),
        ),
      }),
  };

  const parsedCharacter = Character.safeParse(candidate);
  if (!parsedCharacter.success) {
    return fail(
      "invalid_input",
      `update would make character "${characterId}" invalid`,
      toIssues(parsedCharacter.error),
    );
  }

  const characters = project.characters.slice();
  characters[index] = parsedCharacter.data;
  return commit({ ...project, characters });
}

/** Find an enemy (only enemies have behaviors). */
function findEnemy(
  project: ProjectSpec,
  characterId: string,
): { ok: true; index: number; character: EnemyCharacter } | { ok: false; error: OperationError } {
  const index = project.characters.findIndex((c) => c.id === characterId);
  const character = project.characters[index];
  if (!character) return noCharacter(project, characterId);
  if (character.kind !== "enemy") {
    return fail("invalid_input", `"${characterId}" is a ${character.kind}; only enemies have behaviors`);
  }
  return { ok: true, index, character };
}

function replaceCharacter(project: ProjectSpec, index: number, candidate: unknown, what: string): OperationResult {
  const parsed = Character.safeParse(candidate);
  if (!parsed.success) return fail("invalid_input", `${what} would be invalid`, toIssues(parsed.error));
  const characters = project.characters.slice();
  characters[index] = parsed.data;
  return commit({ ...project, characters });
}

const ParamChanges = z.record(z.string(), z.unknown());


const TransitionEdits = z
  .array(
    z.strictObject({
      index: z.number().int().min(0),
      when: ParamChanges.optional().describe(
        "Params merged into the condition, e.g. {\"seconds\": 1.2}; a different `type` replaces it.",
      ),
      and: z
        .array(ParamChanges)
        .optional()
        .describe(
          "Edits to the extra `and` conditions by position: each entry is merged into the condition at that position ({} leaves it alone, a different `type` replaces it); entries past the end are added as new conditions.",
        ),
      to: Id.optional().describe("New target state id."),
    }),
  )
  .optional();

export const UpdateBehaviorInput = z.strictObject({
  characterId: Id,
  stateId: Id.optional().describe("State to edit; required for `action` and `transitions`."),
  action: ParamChanges.optional().describe(
    "Params merged into the state's action, e.g. {\"speed\": 300}. Include a different `type` to replace the action with another primitive (then give all its params).",
  ),
  transitions: TransitionEdits.describe("Targeted edits to the state's existing transitions, by index (0 = first)."),
  interrupts: TransitionEdits.describe("Targeted edits to the behavior's existing interrupts, by index."),
});

/** Merge param changes into a primitive, or replace it if the type changes. */
function mergePrimitive<T extends { type: string }>(current: T, changes: Record<string, unknown>): unknown {
  return changes.type !== undefined && changes.type !== current.type ? changes : { ...current, ...changes };
}

/** Targeted edit of one behavior state, e.g. "make the windup last 1s". */
export function updateBehavior(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = UpdateBehaviorInput.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "updateBehavior input is malformed", toIssues(parsed.error));
  const { characterId, stateId, action, transitions, interrupts } = parsed.data;
  if (!action && !transitions && !interrupts) {
    return fail("invalid_input", "nothing to change: give action, transitions or interrupts");
  }

  const found = findEnemy(project, characterId);
  if (!found.ok) return found;
  const { index, character } = found;
  let behavior: unknown = character.behavior;

  if (interrupts) {
    const edited = editTransitions(character.behavior.interrupts, interrupts, "the behavior's interrupts");
    if (!edited.ok) return edited;
    behavior = { ...character.behavior, interrupts: edited.transitions };
  }

  if (action || transitions) {
    if (stateId === undefined) return fail("invalid_input", "stateId is required to edit a state's action or transitions");
    const state = character.behavior.states[stateId];
    if (!state) {
      return fail("not_found", `"${characterId}" has no behavior state "${stateId}"${known(Object.keys(character.behavior.states))}`);
    }
    const edited = editTransitions(state.transitions, transitions ?? [], `state "${stateId}"`);
    if (!edited.ok) return edited;
    const nextState = { action: action ? mergePrimitive(state.action, action) : state.action, transitions: edited.transitions };
    behavior = { ...(behavior as object), states: { ...character.behavior.states, [stateId]: nextState } };
  }

  return replaceCharacter(project, index, { ...character, behavior }, `behavior of "${characterId}"`);
}

function editTransitions(
  current: Transition[],
  edits: NonNullable<z.infer<typeof TransitionEdits>>,
  where: string,
): { ok: true; transitions: unknown[] } | { ok: false; error: OperationError } {
  const next: unknown[] = current.slice();
  for (const change of edits) {
    const existing = current[change.index];
    if (!existing) {
      return fail(
        "not_found",
        `${where} has no transition at index ${change.index} (it has ${current.length}: ${
          current.map((t, i) => `${i} -> ${t.to}`).join(", ") || "none"
        })`,
      );
    }
    const and = change.and ? editConditions(existing.and ?? [], change.and) : existing.and;
    next[change.index] = {
      when: change.when ? mergePrimitive(existing.when, change.when) : existing.when,
      ...(and && { and }),
      to: change.to ?? existing.to,
    };
  }
  return { ok: true, transitions: next };
}

function editConditions(current: Transition["when"][], edits: Record<string, unknown>[]): unknown[] {
  return Array.from({ length: Math.max(current.length, edits.length) }, (_, i) => {
    const existing = current[i];
    return existing ? mergePrimitive(existing, edits[i] ?? {}) : edits[i];
  });
}

export const SetBehaviorInput = z.strictObject({ characterId: Id, behavior: z.unknown() });

/** Replace an enemy's whole behavior (e.g. a newly composed state machine). */
export function setBehavior(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = SetBehaviorInput.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "setBehavior input is malformed", toIssues(parsed.error));
  const found = findEnemy(project, parsed.data.characterId);
  if (!found.ok) return found;
  const candidate = { ...found.character, behavior: parsed.data.behavior };
  return replaceCharacter(project, found.index, candidate, `behavior of "${parsed.data.characterId}"`);
}

// --- characters ------------------------------------------------------------

export const CreateCharacterInput = z.strictObject({ character: z.unknown() });

/** Add a new character type. It does not appear in a room until spawned there (addRoomSpawn). */
export function createCharacter(project: ProjectSpec, input: unknown): OperationResult {
  const parsedInput = CreateCharacterInput.safeParse(input);
  if (!parsedInput.success) return fail("invalid_input", "createCharacter input is malformed", toIssues(parsedInput.error));
  const parsed = Character.safeParse(parsedInput.data.character);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      "character is invalid",
      toIssues(parsed.error).map((i) => ({ ...i, path: `character.${i.path}` })),
    );
  }
  const character = parsed.data;
  if (character.kind === "player") return fail("invalid_input", "a project has exactly one player; create enemies instead");
  if (project.characters.some((c) => c.id === character.id)) {
    return fail("invalid_input", `a character with id "${character.id}" already exists`);
  }
  return commit({ ...project, characters: [...project.characters, character] });
}

export const CharacterRef = z.strictObject({ characterId: Id });

/** Remove a character type and every spawn of it in every room. The player cannot be deleted. */
export function deleteCharacter(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = CharacterRef.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "deleteCharacter input is malformed", toIssues(parsed.error));
  const { characterId } = parsed.data;
  const character = project.characters.find((c) => c.id === characterId);
  if (!character) return noCharacter(project, characterId);
  if (character.kind === "player") return fail("invalid_input", "the player cannot be deleted");
  // Its variants (variantOf: tougher copies for deeper regions) go with it.
  const gone = project.characters.filter((c) => c.id === characterId || (c.kind === "enemy" && c.variantOf === characterId)).map((c) => c.id);
  return commit({
    ...project,
    characters: project.characters.filter((c) => !gone.includes(c.id)),
    progression: gone.reduce(withoutEnemy, project.progression),
    world: gone.reduce(withoutRoomSpawns, project.world),
  });
}

export const DuplicateCharacterInput = z.strictObject({
  characterId: Id,
  newId: Id,
  name: z.string().optional(),
});

/** Copy a character type (stats, behavior, look) under a new id, e.g. to make a variant. */
export function duplicateCharacter(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = DuplicateCharacterInput.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "duplicateCharacter input is malformed", toIssues(parsed.error));
  const { characterId, newId, name } = parsed.data;
  const source = project.characters.find((c) => c.id === characterId);
  if (!source) return noCharacter(project, characterId);
  if (source.kind === "player") return fail("invalid_input", "the player cannot be duplicated");
  if (project.characters.some((c) => c.id === newId)) {
    return fail("invalid_input", `a character with id "${newId}" already exists`);
  }
  const copy = { ...structuredClone(source), id: newId, name: name ?? `${source.name} copy` };
  const checked = Character.safeParse(copy);
  if (!checked.success) return fail("invalid_input", "duplicate would be invalid", toIssues(checked.error));
  return commit({ ...project, characters: [...project.characters, checked.data] });
}

export const RenameProjectInput = z.strictObject({
  name: z.string().trim().min(1).max(120).describe("The game's new name."),
});

/** Rename the project (the game's title in the studio). */
export function renameProject(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = RenameProjectInput.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "renameProject needs a name of 1 to 120 characters", toIssues(parsed.error));
  return commit({ ...project, name: parsed.data.name });
}

/** Every operation, by name. The server and (later) AI tools dispatch through this. */
const operations = {
  renameProject,
  updateCharacter,
  updateBehavior,
  setBehavior,
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  ...wikiOperations,
  ...progressionOperations,
  ...architectOperations,
  ...artOperations,
  ...worldOperations,
  ...worldRoomOperations,
  ...handlerOperations,
  ...propOperations,
  ...modalOperations,
  ...combatOperations,
} satisfies Record<string, (project: ProjectSpec, input: unknown) => OperationResult>;

export type OperationName = keyof typeof operations;
export const OPERATION_NAMES = Object.keys(operations) as OperationName[];

export function applyOperation(project: ProjectSpec, name: string, input: unknown): OperationResult {
  if (!Object.hasOwn(operations, name)) {
    return fail("invalid_input", `unknown operation "${name}" (known: ${OPERATION_NAMES.join(", ")})`);
  }
  return operations[name as OperationName](project, input);
}

export const OperationCall = z.strictObject({ name: z.string(), input: z.unknown() });
export type OperationCall = z.infer<typeof OperationCall>;

/** One batch is one undo step; an AI turn that builds several rooms easily stages hundreds of operations. */
export const MAX_BATCH_SIZE = 2000;

/**
 * Apply several operations as one change: all succeed or nothing does, and
 * the project advances by exactly one revision (one undo step).
 * Each step is validated against the result of the previous one.
 */
export function applyBatch(project: ProjectSpec, calls: unknown): OperationResult {
  if (Array.isArray(calls) && calls.length > MAX_BATCH_SIZE) {
    return fail("invalid_input", `a batch holds at most ${MAX_BATCH_SIZE} operations (this one has ${calls.length}); save in smaller steps`);
  }
  if (Array.isArray(calls) && calls.length === 0) return fail("invalid_input", "a batch needs at least one operation");
  const parsed = z.array(OperationCall).safeParse(calls);
  if (!parsed.success) return fail("invalid_input", "batch must be a list of { name, input }", toIssues(parsed.error));
  let current = project;
  for (const [i, call] of parsed.data.entries()) {
    const result = applyOperation(current, call.name, call.input);
    if (!result.ok) {
      return fail(
        result.error.code,
        `batch step ${i + 1} (${call.name}) failed: ${result.error.message}; no changes were applied`,
        result.error.issues.map((issue) => ({ ...issue, path: `ops.${i}.input.${issue.path}` })),
      );
    }
    current = result.project;
  }
  return { ok: true, project: { ...current, revision: project.revision + 1 } };
}

/** Final whole-project check; every successful operation goes through here. */
function commit(next: ProjectSpec): OperationResult {
  const validated = validateProject({ ...next, revision: next.revision + 1 });
  if (!validated.ok) {
    return fail("invalid_result", "operation would leave the project invalid", validated.issues);
  }
  return { ok: true, project: validated.project };
}
