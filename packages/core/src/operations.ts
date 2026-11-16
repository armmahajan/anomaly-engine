import { z } from "zod";
import { Character, EnemyStats, PlayerStats, ProjectSpec, type EnemyCharacter } from "./schema.ts";
import { Id } from "./common.ts";
import type { Transition } from "./behavior.ts";

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
const noSpawn = (project: ProjectSpec, id: string) =>
  fail("not_found", `no spawn with id "${id}"${known(project.sandbox.spawns.map((s) => s.id))}`);

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
        "Stats to change. Player: runSpeed, jumpVelocity, health, attackDamage, attackReach, attackCooldown, pogoVelocity. Enemy: knockback, health, contactDamage.",
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

/** Add a new character type. It does not appear in the arena until spawned (addSpawn). */
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

/** Remove a character type and every spawn of it. The player cannot be deleted. */
export function deleteCharacter(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = CharacterRef.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "deleteCharacter input is malformed", toIssues(parsed.error));
  const { characterId } = parsed.data;
  const character = project.characters.find((c) => c.id === characterId);
  if (!character) return noCharacter(project, characterId);
  if (character.kind === "player") return fail("invalid_input", "the player cannot be deleted");
  return commit({
    ...project,
    characters: project.characters.filter((c) => c.id !== characterId),
    sandbox: { ...project.sandbox, spawns: project.sandbox.spawns.filter((s) => s.characterId !== characterId) },
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

// --- spawns ------------------------------------------------------------------

export const AddSpawnInput = z.strictObject({
  characterId: Id,
  x: z.number().describe("Feet x in px."),
  y: z.number().describe("Feet y in px (y grows downward; use the floor's top to stand on the floor)."),
  spawnId: Id.optional().describe("Optional id to refer to this spawn later; generated (<characterId>_<n>) if omitted."),
});

/** Place an instance of a character in the sandbox. (x, y) is its feet. */
export function addSpawn(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = AddSpawnInput.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "addSpawn input is malformed", toIssues(parsed.error));
  const { characterId, x, y } = parsed.data;
  if (!project.characters.some((c) => c.id === characterId)) {
    return noCharacter(project, characterId);
  }
  const taken = project.sandbox.spawns.map((s) => s.id);
  if (parsed.data.spawnId && taken.includes(parsed.data.spawnId)) {
    return fail("invalid_input", `a spawn with id "${parsed.data.spawnId}" already exists`);
  }
  let n = 1;
  while (taken.includes(`${characterId}_${n}`)) n++;
  const id = parsed.data.spawnId ?? `${characterId}_${n}`;
  return commit({ ...project, sandbox: { ...project.sandbox, spawns: [...project.sandbox.spawns, { id, characterId, x, y }] } });
}

export const MoveSpawnInput = z.strictObject({ spawnId: Id, x: z.number().optional(), y: z.number().optional() });

export function moveSpawn(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = MoveSpawnInput.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "moveSpawn input is malformed", toIssues(parsed.error));
  const { spawnId, x, y } = parsed.data;
  const index = project.sandbox.spawns.findIndex((s) => s.id === spawnId);
  const spawn = project.sandbox.spawns[index];
  if (!spawn) return noSpawn(project, spawnId);
  const spawns = project.sandbox.spawns.slice();
  spawns[index] = { ...spawn, x: x ?? spawn.x, y: y ?? spawn.y };
  return commit({ ...project, sandbox: { ...project.sandbox, spawns } });
}

export const SpawnRef = z.strictObject({ spawnId: Id });

export function removeSpawn(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = SpawnRef.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "removeSpawn input is malformed", toIssues(parsed.error));
  const spawn = project.sandbox.spawns.find((s) => s.id === parsed.data.spawnId);
  if (!spawn) return noSpawn(project, parsed.data.spawnId);
  return commit({
    ...project,
    sandbox: { ...project.sandbox, spawns: project.sandbox.spawns.filter((s) => s.id !== spawn.id) },
  });
}

/** Every operation, by name. The server and (later) AI tools dispatch through this. */
const operations = {
  updateCharacter,
  updateBehavior,
  setBehavior,
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  addSpawn,
  moveSpawn,
  removeSpawn,
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

export const MAX_BATCH_SIZE = 50;

/**
 * Apply several operations as one change: all succeed or nothing does, and
 * the project advances by exactly one revision (one undo step).
 * Each step is validated against the result of the previous one.
 */
export function applyBatch(project: ProjectSpec, calls: unknown): OperationResult {
  const parsed = z.array(OperationCall).min(1).max(MAX_BATCH_SIZE).safeParse(calls);
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
