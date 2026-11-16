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
  SetArenaAbilitiesInput,
  SpawnRef,
  UpdateBehaviorInput,
  UpdateCharacterInput,
  SetArtDirectionInput,
  UpdateAssetInput,
  AssetRef,
  AssignAppearanceInput,
  UpdatePartInput,
  SetStateClipInput,
  UpdateRoomInput,
  DeleteRoomInput,
  UpdatePlacementInput,
  AddPlacementInput,
  RemovePlacementInput,
  SetDressingInput,
  ApplyRoomLayoutInput,
  Clip,
  type OperationCall,
  type OperationName,
  type ProjectSpec,
  type ProgressionOperationName,
  type WikiOperationName,
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

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (draft: Draft, args: unknown) => unknown;
}

/** Art operations only the art pipeline runs (concepts, whole rigs); the build assistant uses art jobs instead. */
export const PIPELINE_ONLY_OPERATIONS = ["createAsset", "addConcept", "chooseConcept", "setRig", "setBiomeKit", "addRoom"] as const;

/** The build assistant's write tools: every operation except the wiki's and progression's (the director's) and pipeline-only art ones. */
type BuildOperation = Exclude<OperationName, WikiOperationName | ProgressionOperationName | (typeof PIPELINE_ONLY_OPERATIONS)[number]>;

const writeDescriptions: Record<BuildOperation, string> = {
  createCharacter:
    "Create a new enemy type. It does not appear in the arena until you also call addSpawn. Give it a behavior built from the primitives (see listPrimitives).",
  duplicateCharacter: "Copy an existing enemy type under a new id (stats, look, behavior), e.g. to make a variant.",
  deleteCharacter: "Delete an enemy type and all its spawns. The player cannot be deleted.",
  updateCharacter: "Change a character's name, color, size or stats (and, for the player, movement ability tuning). Applies to every spawn of it.",
  setArenaAbilities: "Choose which movement abilities (dash, double_jump, wall_jump, glide, ground_pound) the player has when playtesting the arena.",
  updateBehavior:
    "Targeted edit of one behavior state (action params, transitions by index) and/or the behavior's interrupts by index. Prefer this over setBehavior for tweaks.",
  setBehavior:
    "Replace an enemy's whole behavior state machine. Use for new or restructured behaviors (adding/removing states or transitions).",
  addSpawn: "Place an instance of a character in the arena at its feet position.",
  moveSpawn: "Move a spawn (either axis).",
  removeSpawn: "Remove one spawn. The character type remains.",
  setArtDirection: "Change the project-wide art direction (style words, palette, outline color/width, line boil).",
  updateAsset: "Rename an art asset or change its brief (the description concept art is generated from).",
  deleteAsset: "Delete an art asset; characters drawn with it go back to colored boxes.",
  assignAppearance: "Draw a character with a character art asset (or null for a colored box). Variants can share one asset.",
  updatePart:
    "Targeted edit of one part of a character's rig: recolor (fill/shade), outline (ink), glow, opacity, draw order (z) or shape.",
  setClip:
    "Create, replace or delete (clip: null) an animation clip on a character asset. Slot names (idle, walk, run, windup, attack, hurt, jump, fall, fly) are used automatically.",
  setStateClip: "Make a behavior state play a specific clip instead of its automatic slot (clipId null = automatic).",
  updateRoom:
    "Change a world room's name or atmosphere: palette (ambient darkness, fog, light, shadow colors), fog density per layer, dust, light shafts or extra lights.",
  deleteRoom: "Delete a world room (the arena goes back to plain if it was dressed with it).",
  updatePlacement: "Move, re-layer (far/mid/back/play/front), scale or flip one placed piece in a world room, by placement id.",
  addPlacement: "Place a biome kit piece in a world room (x = room x it is seen at; y = its bottom, or its top for hanging pieces).",
  removePlacement: "Remove one placed piece from a world room, by placement id.",
  setDressing: "Dress the arena with a biome room (art only; collision stays the arena's platforms), or biomeId null for the plain arena.",
  applyRoomLayout: "Accept a room's suggested platform layout: the arena's platforms become it and the arena is dressed with that room.",
};

/** Precise parameter schemas for the model; the operations themselves accept `unknown` and validate. */
const writeSchemas: Record<BuildOperation, z.ZodType> = {
  createCharacter: z.strictObject({ character: EnemyCharacter }),
  duplicateCharacter: DuplicateCharacterInput,
  deleteCharacter: CharacterRef,
  updateCharacter: UpdateCharacterInput,
  setArenaAbilities: SetArenaAbilitiesInput,
  updateBehavior: UpdateBehaviorInput,
  setBehavior: z.strictObject({ characterId: Id, behavior: Behavior }),
  addSpawn: AddSpawnInput,
  moveSpawn: MoveSpawnInput,
  removeSpawn: SpawnRef,
  setArtDirection: SetArtDirectionInput,
  updateAsset: UpdateAssetInput,
  deleteAsset: AssetRef,
  assignAppearance: AssignAppearanceInput,
  updatePart: UpdatePartInput,
  // A compact spec instead of the full Clip schema keeps every chat turn cheaper; the operation validates fully.
  setClip: z.strictObject({
    assetId: Id,
    clipId: Id,
    clip: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        'null deletes. Else {"duration": s, "loop": bool, "tracks": [{"bone", "property": "rotate"|"x"|"y"|"scaleX"|"scaleY", "keys": [[t 0..1, value], ...], "ease": "smooth"|"linear"|"step"}], "motions": [{"type": "sway"|"bob"|"shift"|"pulse", "bone", "degrees" (sway) or "amount", "cycles": int, "phase": 0..1} | {"type": "squash", "bone", "amount", "at", "width"} | {"type": "shake", "bone", "amount"}], "visibility": [{"part", "keys": [[t, bool]]}]}. Values are offsets from rest: degrees clockwise, px (y down), scale multipliers. Use getCharacter / the asset to see bone ids.',
      ),
  }),
  setStateClip: SetStateClipInput,
  updateRoom: UpdateRoomInput,
  deleteRoom: DeleteRoomInput,
  updatePlacement: UpdatePlacementInput,
  addPlacement: AddPlacementInput,
  removePlacement: RemovePlacementInput,
  setDressing: SetDressingInput,
  applyRoomLayout: ApplyRoomLayoutInput,
};

/** Apply an operation to the draft and stage it for the end-of-turn commit. */
export function stageOperation(draft: Draft, name: OperationName, args: unknown, warnings: (project: ProjectSpec) => string[]): unknown {
  const result = applyOperation(draft.current, name, args);
  if (!result.ok) return { ok: false, error: result.error };
  draft.current = result.project;
  draft.calls.push({ name, input: args });
  return {
    ok: true,
    note: "Staged. All staged changes are saved together when you finish your turn.",
    warnings: warnings(draft.current),
  };
}

function writeTool(name: BuildOperation): ToolSpec {
  return {
    name,
    description: writeDescriptions[name],
    schema: writeSchemas[name],
    run: (draft, args) => stageOperation(draft, name, args, (p) => lintProject(p).map((w) => w.message)),
  };
}

export const projectSummaryTool: ToolSpec = {
  name: "getProjectSummary",
  description: "Readable summary of the game's characters, arena and behaviors, including changes staged this turn and any warnings.",
  schema: z.strictObject({}),
  run: (draft) => ({ ok: true, summary: summarizeProject(draft.current) }),
};

const readTools: ToolSpec[] = [
  projectSummaryTool,
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

/** A set of tools one agent can use. */
export interface Toolset {
  specs: ToolSpec[];
  byName: Map<string, ToolSpec>;
}

export const toolset = (specs: ToolSpec[]): Toolset => ({ specs, byName: new Map(specs.map((t) => [t.name, t])) });

export const BUILD_TOOLS = toolset([...readTools, ...(Object.keys(writeSchemas) as BuildOperation[]).map(writeTool)]);

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  return rest;
}

/** Tool definitions in OpenAI function-calling format. */
export function toolDefinitions(tools: Toolset = BUILD_TOOLS): ToolDefinition[] {
  return tools.specs.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: jsonSchema(t.schema) },
  }));
}

export const READ_TOOL_NAMES = readTools.map((t) => t.name);

/** Name, description and input schema of every tool (for SDKs that take Zod schemas). */
export const toolSchemas = (tools: Toolset): { name: string; description: string; schema: z.ZodType }[] =>
  tools.specs.map(({ name, description, schema }) => ({ name, description, schema }));

export const TOOL_SCHEMAS = toolSchemas(BUILD_TOOLS);

export function isOk(result: unknown): boolean {
  return (result as { ok?: boolean }).ok === true;
}

/** Run one tool call against the draft. Never throws; failures become results the model can read. */
export function executeTool(draft: Draft, name: string, rawArguments: string, tools: Toolset = BUILD_TOOLS): unknown {
  const tool = tools.byName.get(name);
  if (!tool) {
    return { ok: false, error: { code: "unknown_tool", message: `no tool "${name}" (known: ${[...tools.byName.keys()].join(", ")})` } };
  }
  let args: unknown;
  try {
    args = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    return { ok: false, error: { code: "invalid_arguments", message: "tool arguments must be a JSON object" } };
  }
  return tool.run(draft, args);
}
