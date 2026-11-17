import { z } from "zod";
import {
  Action,
  applyOperation,
  Behavior,
  CharacterRef,
  Condition,
  DuplicateCharacterInput,
  Effect,
  gameArtPlan,
  GameCondition,
  GameEvent,
  EnemyCharacter,
  Id,
  MovementAbility,
  lintProject,
  UpdateBehaviorInput,
  UpdateCharacterInput,
  SetArtDirectionInput,
  UpdateAssetInput,
  AssetRef,
  UpdatePartInput,
  DeleteRoomInput,
  RemovePlacementInput,
  ApplyRoomLayoutInput,
  Clip,
  ArtJobRequest,
  RoomRef,
  GameRules,
  type OperationCall,
  type OperationName,
  type ProjectSpec,
  type ProgressionOperationName,
  type WikiOperationName,
} from "@anomaly/core";
import { describeCharacter, describeRoom, summarizeProject } from "./summary.ts";
import type { ToolDefinition } from "./messages.ts";
import { handlerTools } from "./domains/handlers.ts";
import { propTools } from "./domains/props.ts";
import { modalTools } from "./domains/modals.ts";
import { combatTools } from "./domains/combat.ts";
import { logicTools } from "./domains/logic.ts";
import { designTools } from "./domains/design.ts";

/** Game-logic domains, each in its own file (operations, tool text, schemas, summary). */
export const DOMAIN_TOOLS = [handlerTools, propTools, modalTools, combatTools, logicTools, designTools] as const;

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
  /** Art/world jobs queued this turn; they start after the turn ends (each its own AI change). */
  readonly jobs: ArtJobRequest[] = [];
  /** Whether art generation is configured (else the art tools refuse). */
  artAvailable: boolean;

  constructor(base: ProjectSpec, artAvailable = false) {
    this.base = base;
    this.current = base;
    this.artAvailable = artAvailable;
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
export const PIPELINE_ONLY_OPERATIONS = ["createAsset", "addConcept", "chooseConcept", "setRig", "setBiomeKit", "addRoom", "setRoomComposition"] as const;

/** The build assistant's write tools: every operation except the wiki's and progression's (the director's) and pipeline-only art ones. */
type BuildOperation = Exclude<OperationName, WikiOperationName | ProgressionOperationName | (typeof PIPELINE_ONLY_OPERATIONS)[number]>;

const writeDescriptions: Record<BuildOperation, string> = {
  createCharacter:
    "Create a new enemy type. It does not appear in any room until you also call addRoomSpawn. Give it a behavior built from the primitives (see listPrimitives).",
  duplicateCharacter: "Copy an existing enemy type under a new id (stats, look, behavior), e.g. to make a variant.",
  deleteCharacter: "Delete an enemy type and all its spawns. The player cannot be deleted.",
  updateCharacter: "Change a character's name, color, size or stats (and, for the player, movement ability tuning). Applies to every spawn of it.",
  updateBehavior:
    "Targeted edit of one behavior state (action params, transitions by index) and/or the behavior's interrupts by index. Prefer this over setBehavior for tweaks.",
  setBehavior:
    "Replace an enemy's whole behavior state machine. Use for new or restructured behaviors (adding/removing states or transitions).",
  setArtDirection: "Change the project-wide art direction (style words, palette, outline color/width, line boil, rig mode vector|cutout).",
  updateAsset: "Rename an art asset or change its brief (the description concept art is generated from).",
  deleteAsset: "Delete an art asset; characters drawn with it go back to colored boxes.",
  assignAppearance: "Draw a character with a character art asset (or null for a colored box). Variants can share one asset.",
  updatePart:
    "Targeted edit of one part of a character's rig: recolor (fill/shade), outline (ink), glow, opacity, draw order (z) or shape.",
  setClip:
    "Create, replace or delete (clip: null) an animation clip on a character asset. Slot names (idle, walk, run, windup, attack, hurt, jump, fall, fly) are used automatically.",
  setStateClip: "Make a behavior state play a specific clip instead of its automatic slot (clipId null = automatic).",
  updateRoom: "Change a world room's name or atmosphere: palette colors, fog density per layer (0-1), dust.",
  deleteRoom: "Delete a biome's room (composition); world rooms dressed with it go back to plain tiles.",
  updatePlacement: "Move, re-layer, scale or flip one placed piece in a world room.",
  addPlacement: "Place a biome kit piece in a room (x = room x; y = its bottom, or top if hanging).",
  removePlacement: "Remove one placed piece from a world room, by placement id.",
  setDressing: "Dress a world room (default: the playtest room) with a biome room (art only), or biomeId null for plain tiles.",
  applyRoomLayout: "Accept a biome room's suggested layout: a world room's tiles (default: the playtest room's) become it.",
  createWorldRoom: "Create a game-world room: a grid of 32 px tiles, empty with a solid border. Rooms join through doors.",
  updateWorldRoom: "Rename a game-world room, move it on the world map (tiles), dress it with a biome room or set its region.",
  deleteWorldRoom: "Delete a game-world room; doors to it become unconnected.",
  resizeWorldRoom: "Resize a room's grid; shiftX/shiftY move the content right/down. New cells: empty, solid outer edge.",
  paintTiles: "Set a rectangle (area) or [col, row] cells of a room's grid to one tile kind.",
  setDoor: "Add or change (by id) a door: an opening carved in one side. The floor inside should be level with its bottom edge.",
  removeDoor: "Remove a door (its partner becomes unconnected; tiles stay).",
  connectDoors: "Make two doors lead to each other (right <-> left, bottom <-> top); to: null disconnects.",
  addRoomSpawn: "Place an enemy in a room (feet, px from its top-left). Enemies respawn on entering.",
  moveRoomSpawn: "Move an enemy spawn in a room.",
  removeRoomSpawn: "Remove an enemy spawn from a room.",
  setSpawnCondition: "Make an enemy spawn only while a condition holds (e.g. {type: 'flag', flag: 'x_beaten', is: false} so a beaten enemy stays gone); null = always.",
  setWorldStart: "Set where the game begins (room, player's feet); roomId null clears it.",
  setPlaytest: "Set what ▶ Play tests: the room (with x, y: where the player starts) and/or the movement abilities the player has (dash, double_jump, wall_jump, glide, ground_pound).",
  setGameRules: "Game rules (presets of handlers): onDeath room (back to the room's entry) | start | checkpoint, save room | never, hazardDamage.",
  setLedgeThickness: "Thickness (px) of ledge and one-way tiles everywhere.",
  ...handlerTools.descriptions,
  ...propTools.descriptions,
  ...modalTools.descriptions,
  ...combatTools.descriptions,
  ...logicTools.descriptions,
  ...designTools.descriptions,
};

const int = z.number().int();
const xy = z.strictObject({ x: int, y: int });
const side = z.enum(["left", "right", "top", "bottom"]);
const doorEnd = z.strictObject({ roomId: z.string(), doorId: z.string() });

/** Precise parameter schemas for the model; the operations themselves accept `unknown` and validate. */
const writeSchemas: Record<BuildOperation, z.ZodType> = {
  // The behavior's full schema is setBehavior's; repeating it here would double the primitives' share of every turn.
  createCharacter: z.strictObject({
    character: EnemyCharacter.extend({ behavior: z.record(z.string(), z.unknown()).describe("A behavior exactly as setBehavior takes it: {initial, states, interrupts}.") }),
  }),
  duplicateCharacter: DuplicateCharacterInput,
  deleteCharacter: CharacterRef,
  updateCharacter: UpdateCharacterInput,
  updateBehavior: UpdateBehaviorInput,
  setBehavior: z.strictObject({ characterId: Id, behavior: Behavior }),
  setArtDirection: SetArtDirectionInput,
  updateAsset: UpdateAssetInput,
  deleteAsset: AssetRef,
  // Field notes that repeat the tool description are left out of these to keep the tool list small.
  assignAppearance: z.strictObject({ characterId: Id, assetId: Id.nullable() }),
  updatePart: UpdatePartInput,
  // A compact spec instead of the full Clip schema keeps every chat turn cheaper; the operation validates fully.
  setClip: z.strictObject({
    assetId: Id,
    clipId: Id,
    clip: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        'null deletes. {duration, loop, tracks: [{bone, property: rotate|x|y|scaleX|scaleY, keys: [[t 0..1, value]], ease}], motions: [{type: sway|bob|shift|pulse|squash|shake, bone, degrees|amount, cycles, phase}], visibility: [{part, keys: [[t, bool]]}]}; values are offsets from rest.',

      ),
  }),
  setStateClip: z.strictObject({ assetId: Id, stateId: Id, clipId: Id.nullable() }),
  // World edits also take compact specs (the operations validate fully); light shafts and extra lights stay workbench-only.
  updateRoom: z.strictObject({
    assetId: Id,
    roomId: Id,
    changes: z
      .record(z.string(), z.unknown())
      .describe("Any of: name; palette {ambient, fog, light, shadow: '#rrggbb'}; fog {mid, back, play: 0-1}; dust {color, amount}."),
  }),
  deleteRoom: DeleteRoomInput,
  updatePlacement: z.strictObject({
    assetId: Id,
    roomId: Id,
    placementId: Id,
    changes: z.record(z.string(), z.unknown()).describe("Any of: x, y, layer (far|mid|back|play|front), scale, flip."),
  }),
  addPlacement: z.strictObject({
    assetId: Id,
    roomId: Id,
    placement: z.record(z.string(), z.unknown()).describe("{piece, layer: far|mid|back|play|front, x, y, scale?, flip?}"),
  }),
  removePlacement: RemovePlacementInput,
  setDressing: z.strictObject({ worldRoomId: Id.optional(), biomeId: Id.nullable(), roomId: Id.optional() }),
  applyRoomLayout: ApplyRoomLayoutInput,
  // Game-world tools take compact specs too (ids as plain strings, details in the descriptions); the operations validate fully.
  createWorldRoom: z.strictObject({ name: z.string(), id: z.string().optional(), cols: int.optional(), rows: int.optional(), at: xy.optional() }),
  updateWorldRoom: z.strictObject({
    roomId: z.string(),
    changes: z.strictObject({ name: z.string().optional(), at: xy.optional(), dressing: z.strictObject({ biome: z.string(), room: z.string() }).nullable().optional(), regionId: z.string().nullable().optional() }),
  }),
  deleteWorldRoom: z.strictObject({ roomId: z.string() }),
  resizeWorldRoom: z.strictObject({ roomId: z.string(), cols: int, rows: int, shiftX: int.optional(), shiftY: int.optional() }),
  paintTiles: z.strictObject({
    roomId: z.string(),
    kind: z.enum(["empty", "solid", "ledge", "oneway", "hazard", "breakable"]),
    area: z.strictObject({ col: int, row: int, cols: int, rows: int }).optional(),
    cells: z.array(z.tuple([int, int])).optional(),
  }),
  setDoor: z.strictObject({
    roomId: z.string(),
    door: z.strictObject({ id: z.string().optional(), side, offset: int.describe("tiles from the top (left/right) or left (top/bottom)"), size: int }),
    carve: z.boolean().optional(),
  }),
  removeDoor: z.strictObject({ roomId: z.string(), doorId: z.string() }),
  connectDoors: z.strictObject({ from: doorEnd, to: doorEnd.nullable() }),
  addRoomSpawn: z.strictObject({
    roomId: z.string(),
    characterId: z.string(),
    x: z.number().describe("Feet x, px from the room's left."),
    y: z.number().describe("Feet y, px from the room's top; y grows downward (a floor's top to stand on it)."),
    spawnId: z.string().optional(),
  }),
  moveRoomSpawn: z.strictObject({ roomId: z.string(), spawnId: z.string(), x: z.number().optional(), y: z.number().optional() }),
  removeRoomSpawn: z.strictObject({ roomId: z.string(), spawnId: z.string() }),
  setSpawnCondition: z.strictObject({ roomId: z.string(), spawnId: z.string(), when: z.record(z.string(), z.unknown()).nullable().describe("A condition (see listGameLogic) or null.") }),
  setWorldStart: z.strictObject({ roomId: z.string().nullable(), x: z.number().optional(), y: z.number().optional() }),
  setPlaytest: z.strictObject({ roomId: z.string().optional(), x: z.number().optional(), y: z.number().optional(), abilities: z.array(MovementAbility).optional() }),
  setGameRules: z.strictObject({ onDeath: GameRules.shape.onDeath.unwrap().optional(), save: GameRules.shape.save.unwrap().optional(), hazardDamage: int.optional() }),
  setLedgeThickness: z.strictObject({ thickness: int }),
  ...handlerTools.schemas,
  ...propTools.schemas,
  ...modalTools.schemas,
  ...combatTools.schemas,
  ...logicTools.schemas,
  ...designTools.schemas,
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
  description: "Readable summary of the game's characters, rooms, playtest and behaviors, including changes staged this turn and any warnings.",
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
        spawns: draft.current.world.rooms.flatMap((r) => r.spawns.filter((s) => s.characterId === character.id).map((s) => ({ room: r.id, ...s }))),
        summary: describeCharacter(draft.current, character),
      };
    },
  },
  {
    name: "getRoom",
    description: "One game-world room in full: its tile rows (row 0 at the top), doors, enemy spawns and dressing.",
    schema: RoomRef,
    run: (draft, args) => {
      const parsed = RoomRef.safeParse(args);
      const room = parsed.success && draft.current.world.rooms.find((r) => r.id === parsed.data.roomId);
      if (!room) {
        return { ok: false, error: { code: "not_found", message: `known rooms: ${draft.current.world.rooms.map((r) => r.id).join(", ") || "none"}` } };
      }
      return { ok: true, room, summary: describeRoom(room) };
    },
  },
  {
    name: "listPrimitives",
    description: "The behavior building blocks: action primitives (what a state does) and condition primitives (when to leave it), with parameters.",
    schema: z.strictObject({}),
    run: () => ({ ok: true, actions: jsonSchema(Action), conditions: jsonSchema(Condition) }),
  },
  {
    name: "listGameLogic",
    description: "The game-logic building blocks for handlers: events (on), conditions (when) and effects (do), with parameters.",
    schema: z.strictObject({}),
    run: () => ({ ok: true, events: jsonSchema(GameEvent), conditions: jsonSchema(GameCondition), effects: jsonSchema(Effect) }),
  },
  // Domains' read tools (the design documents, the game checker, ...).
  ...DOMAIN_TOOLS.flatMap((d) => d.reads ?? []).map((t): ToolSpec => ({ name: t.name, description: t.description, schema: t.schema, run: (draft, args) => t.run(draft.current, args) })),
];

/** A set of tools one agent can use. */
export interface Toolset {
  specs: ToolSpec[];
  byName: Map<string, ToolSpec>;
}

export const toolset = (specs: ToolSpec[]): Toolset => ({ specs, byName: new Map(specs.map((t) => [t.name, t])) });

// --- art jobs (queued: they run after the turn, each saved as its own AI change) ---------------

const GenerateCharacterArtInput = z.strictObject({
  characterId: Id,
  brief: z.string().max(2000).optional().describe("Its look; needed the first time unless its wiki page describes it."),
});
const GenerateWorldInput = z.strictObject({
  theme: z.string().min(3).max(2000).describe("What the place is."),
  name: z.string().max(80).optional(),
  quality: z.enum(["draft", "final"]).default("draft").describe("draft ~$0.02, final ~$0.05"),
  dress: z.boolean().default(true).describe("Dress the playtest room with its first room."),
});
const ComposeWorldRoomInput = z.strictObject({
  biomeId: Id,
  direction: z.string().max(1000).optional(),
  newLayout: z.boolean().default(false).describe("Also suggest platforms (creator accepts)."),
  dressRoom: Id.optional().describe("A world room to dress with it (its tiles are what the room is composed around)."),
});

function queue(draft: Draft, job: ArtJobRequest, note: string): unknown {
  if (!draft.artAvailable) {
    return { ok: false, error: { code: "unavailable", message: "art generation is not configured (no model key); tell the creator" } };
  }
  const parsed = ArtJobRequest.safeParse(job);
  if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: parsed.error.issues.map((i) => i.message).join("; ") } };
  draft.jobs.push(job);
  return { ok: true, note: `Queued: ${note}. It starts when you finish this turn and shows in the Characters/Worlds workbench; it is not done yet, so say so.` };
}

const artTools: ToolSpec[] = [
  {
    name: "generateCharacterArt",
    description:
      "Queue a character's whole art pipeline (concepts, design, rig, animations; ~$0.02, ~2 min).",
    schema: GenerateCharacterArtInput,
    run: (draft, args) => {
      const p = GenerateCharacterArtInput.safeParse(args);
      if (!p.success) return { ok: false, error: { code: "invalid_input", message: p.error.issues.map((i) => i.message).join("; ") } };
      const character = draft.current.characters.find((c) => c.id === p.data.characterId);
      if (!character) return { ok: false, error: { code: "not_found", message: `no character "${p.data.characterId}"` } };
      const hasBrief =
        Boolean(p.data.brief?.trim()) || draft.current.art.assets.some((a) => a.id === character.appearance) || draft.current.wiki.pages.some((pg) => pg.characterId === character.id);
      if (!hasBrief) return { ok: false, error: { code: "invalid_input", message: "give a brief: what it should look like" } };
      return queue(draft, { stage: "auto", characterId: character.id, brief: p.data.brief?.trim() || undefined }, `art for ${character.name}`);
    },
  },
  {
    name: "generateWorld",
    description:
      "Queue a new biome: a painted kit plus a first room composed around the playtest room's tiles (~1 min).",
    schema: GenerateWorldInput,
    run: (draft, args) => {
      const p = GenerateWorldInput.safeParse(args);
      if (!p.success) return { ok: false, error: { code: "invalid_input", message: p.error.issues.map((i) => i.message).join("; ") } };
      return queue(
        draft,
        { stage: "worldKit", brief: p.data.theme, name: p.data.name, quality: p.data.quality, dressRoom: p.data.dress ? draft.current.world.playtest?.room : undefined },
        `a ${p.data.quality} world "${p.data.name ?? p.data.theme.slice(0, 40)}"`,
      );
    },
  },
  {
    name: "composeWorldRoom",
    description: "Queue another room from a biome's kit (~$0.004, reviewed from a render).",
    schema: ComposeWorldRoomInput,
    run: (draft, args) => {
      const p = ComposeWorldRoomInput.safeParse(args);
      if (!p.success) return { ok: false, error: { code: "invalid_input", message: p.error.issues.map((i) => i.message).join("; ") } };
      const biome = draft.current.art.assets.find((a) => a.id === p.data.biomeId && a.kind === "biome");
      if (!biome) return { ok: false, error: { code: "not_found", message: `no biome "${p.data.biomeId}"` } };
      return queue(
        draft,
        { stage: "worldCompose", biomeId: biome.id, feedback: p.data.direction, newLayout: p.data.newLayout, dressRoom: p.data.dressRoom },
        `a new room for ${biome.name}`,
      );
    },
  },
  {
    name: "generateGameArt",
    description:
      "Queue art for everything the game still lacks (characters and their animations, a biome per region, every room, props, screens, item icons), step by step. Reruns resume.",
    schema: z.strictObject({}),
    run: (draft) => {
      const plan = gameArtPlan(draft.current);
      if (plan.length === 0) return { ok: true, note: "Nothing to draw: the game has art for everything." };
      const estimate = plan.reduce((sum, s) => sum + s.estimatedCost, 0);
      return queue(draft, { stage: "gameArt" }, `art for the whole game (${plan.length} steps, about $${estimate.toFixed(2)})`);
    },
  },
];

export const ART_TOOL_NAMES = artTools.map((t) => t.name);

export const BUILD_TOOLS = toolset([...readTools, ...(Object.keys(writeSchemas) as BuildOperation[]).map(writeTool), ...artTools]);

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
