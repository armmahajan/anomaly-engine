import { z } from "zod";
import {
  Action,
  AddSpawnInput,
  applyOperation,
  Behavior,
  CharacterRef,
  Condition,
  DuplicateCharacterInput,
  EnemyCharacter,
  Id,
  lintProject,
  MoveSpawnInput,
  OPERATION_NAMES,
  SpawnRef,
  UpdateBehaviorInput,
  UpdateCharacterInput,
  type OperationCall,
  type OperationName,
  type ProjectSpec,
} from "@anomaly/core";
import { describeCharacter, summarizeProject } from "./summary.ts";
import type { ToolDefinition } from "./messages.ts";

/**
 * The agent's tools. Write tools are exactly the core operations (same names,
 * same validation); their parameter schemas are generated from the core Zod
 * schemas, so tools can't drift from what the server accepts.
 *
 * Writes go to a Draft: they take effect immediately for later tool calls in
 * the same turn, and are saved together as one batch (one undo step) when the
 * turn ends.
 */

/** Working copy for one agent turn. */
export class Draft {
  readonly base: ProjectSpec;
  current: ProjectSpec;
  readonly calls: OperationCall[] = [];

  constructor(base: ProjectSpec) {
    this.base = base;
    this.current = base;
  }

  get changed(): boolean {
    return this.calls.length > 0;
  }
}

interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (draft: Draft, args: unknown) => unknown;
}

const writeDescriptions: Record<OperationName, string> = {
  createCharacter:
    "Create a new enemy type. It does not appear in the arena until you also call addSpawn. Give it a behavior built from the primitives (see listPrimitives).",
  duplicateCharacter: "Copy an existing enemy type under a new id (stats, look, behavior), e.g. to make a variant.",
  deleteCharacter: "Delete an enemy type and all its spawns. The player cannot be deleted.",
  updateCharacter: "Change a character's name, color, size or stats. Applies to every spawn of it.",
  updateBehavior:
    "Targeted edit of one behavior state: change action params and/or edit existing transitions by index. Prefer this over setBehavior for tweaks.",
  setBehavior:
    "Replace an enemy's whole behavior state machine. Use for new or restructured behaviors (adding/removing states or transitions).",
  addSpawn: "Place an instance of a character in the arena at its feet position.",
  moveSpawn: "Move a spawn (either axis).",
  removeSpawn: "Remove one spawn. The character type remains.",
};

/** Precise parameter schemas for the model; the operations themselves accept `unknown` and validate. */
const writeSchemas: Record<OperationName, z.ZodType> = {
  createCharacter: z.strictObject({ character: EnemyCharacter }),
  duplicateCharacter: DuplicateCharacterInput,
  deleteCharacter: CharacterRef,
  updateCharacter: UpdateCharacterInput,
  updateBehavior: UpdateBehaviorInput,
  setBehavior: z.strictObject({ characterId: Id, behavior: Behavior }),
  addSpawn: AddSpawnInput,
  moveSpawn: MoveSpawnInput,
  removeSpawn: SpawnRef,
};

function writeTool(name: OperationName): ToolSpec {
  return {
    name,
    description: writeDescriptions[name],
    schema: writeSchemas[name],
    run: (draft, args) => {
      const result = applyOperation(draft.current, name, args);
      if (!result.ok) return { ok: false, error: result.error };
      draft.current = result.project;
      draft.calls.push({ name, input: args });
      return {
        ok: true,
        note: "Staged. All staged changes are saved together when you finish your turn.",
        warnings: lintProject(draft.current).map((w) => w.message),
      };
    },
  };
}

const readTools: ToolSpec[] = [
  {
    name: "getProjectSummary",
    description: "Readable summary of the current project, including changes staged this turn and any warnings.",
    schema: z.strictObject({}),
    run: (draft) => ({ ok: true, summary: summarizeProject(draft.current) }),
  },
  {
    name: "getCharacter",
    description: "Exact JSON of one character (including its full behavior) and its spawns.",
    schema: CharacterRef,
    run: (draft, args) => {
      const parsed = CharacterRef.safeParse(args);
      const character = parsed.success && draft.current.characters.find((c) => c.id === parsed.data.characterId);
      if (!character) {
        return {
          ok: false,
          error: { code: "not_found", message: `known characters: ${draft.current.characters.map((c) => c.id).join(", ")}` },
        };
      }
      return {
        ok: true,
        character,
        spawns: draft.current.sandbox.spawns.filter((s) => s.characterId === character.id),
        summary: describeCharacter(draft.current, character),
      };
    },
  },
  {
    name: "listPrimitives",
    description: "The behavior building blocks: action primitives (what a state does) and condition primitives (when to leave it), with parameters.",
    schema: z.strictObject({}),
    run: () => ({ ok: true, actions: jsonSchema(Action), conditions: jsonSchema(Condition) }),
  },
];

const tools: ToolSpec[] = [...readTools, ...OPERATION_NAMES.map(writeTool)];
const byName = new Map(tools.map((t) => [t.name, t]));

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  return rest;
}

/** Tool definitions in OpenAI function-calling format. */
export function toolDefinitions(): ToolDefinition[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: jsonSchema(t.schema) },
  }));
}

export const READ_TOOL_NAMES = readTools.map((t) => t.name);

/** Run one tool call against the draft. Never throws; failures become results the model can read. */
export function executeTool(draft: Draft, name: string, rawArguments: string): unknown {
  const tool = byName.get(name);
  if (!tool) return { ok: false, error: { code: "unknown_tool", message: `no tool "${name}" (known: ${[...byName.keys()].join(", ")})` } };
  let args: unknown;
  try {
    args = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    return { ok: false, error: { code: "invalid_arguments", message: "tool arguments must be a JSON object" } };
  }
  return tool.run(draft, args);
}
