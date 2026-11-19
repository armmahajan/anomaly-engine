import { z } from "zod";
import { Author } from "./history.ts";
import type { OperationError } from "./operations.ts";
import { ProjectSpec } from "./schema.ts";
import { FileRef } from "./art/fileRef.ts";
import { Id } from "./common.ts";
import { ArchitectStage } from "./architect/plan.ts";

/**
 * HTTP API of the local project server (shared by server and clients).
 *
 *   GET  /api/project              -> ProjectState
 *   GET  /api/history              -> { entries: HistorySummary[] }
 *   POST /api/ops       OperationRequest -> ChangeResult
 *   POST /api/batch     BatchRequest     -> ChangeResult  (all-or-nothing, one revision)
 *   POST /api/undo      UndoRequest      -> ChangeResult
 *   POST /api/playtest  PlaytestRequest  -> PlaytestResult
 *   POST /api/reset     ResetRequest     -> ChangeResult  (backs up, then starts a fresh project)
 *   GET  /api/chat?agent=build|narrative -> ChatState (agent defaults to build)
 *   POST /api/chat      ChatRequest      -> { ok } (the turn runs in the background)
 *   POST /api/chat/cancel          -> { ok }
 *   GET  /api/events?clientId=…    -> server-sent events, `data:` = ServerEvent
 *   POST /api/export    {}               -> ExportResult (builds the standalone web game: folder + zip)
 *   GET  /api/export/<name>.zip    -> the zip built last (application/zip, as a download)
 *
 * Every edit names the revision it was based on (`baseRevision`) and is
 * rejected with `stale_revision` if the project has moved on since.
 */

export const OperationRequest = z.strictObject({
  name: z.string(),
  input: z.unknown(),
  baseRevision: z.number().int().min(0),
  author: Author.default("user"),
});
export type OperationRequest = z.input<typeof OperationRequest>;

export const BatchRequest = z.strictObject({
  /** Validated by core applyBatch. */
  operations: z.unknown(),
  baseRevision: z.number().int().min(0),
  author: Author.default("user"),
});
export type BatchRequest = z.input<typeof BatchRequest>;

export const UndoRequest = z.strictObject({
  baseRevision: z.number().int().min(0),
  author: Author.default("user"),
});
export type UndoRequest = z.input<typeof UndoRequest>;

/** The studio holds the playtest lock while playing; edits are rejected meanwhile. */
export const PlaytestRequest = z.strictObject({
  active: z.boolean(),
  clientId: z.string().min(1).max(100),
});

export const ResetRequest = z.strictObject({
  baseRevision: z.number().int().min(0),
  /** Start from the starter project (default), the example game (the fixture slice) or a blank project (the player in an empty arena). */
  from: z.enum(["starter", "example", "blank"]).default("starter"),
});

export const ChatRequest = z.strictObject({
  message: z.string().trim().min(1).max(4000),
  /**
   * Edit or retry: the index of the latest user message, whose exchange (the message and its
   * reply) this message replaces. Refused while that turn's saved changes are still in the
   * project (undo them first), so replacing never hides changes.
   */
  replace: z.number().int().min(0).optional(),
});

/** The studio's AI agents, each with its own chat: build assistant (the game) and director (wiki and progression). */
export const AgentId = z.enum(["build", "narrative", "architect"]);
export type AgentId = z.infer<typeof AgentId>;

export interface ProjectState {
  project: ProjectSpec;
  canUndo: boolean;
}

export type ChangeResult = ({ ok: true } & ProjectState) | { ok: false; error: OperationError };

export type PlaytestResult = { ok: true; revision: number } | { ok: false; error: OperationError };

export interface HistorySummary {
  revision: number;
  at: string;
  author: Author;
  summary: string;
}

export const ProjectEvent = z.object({
  type: z.literal("project"),
  project: ProjectSpec,
  canUndo: z.boolean(),
  /** What caused this event; null for the initial snapshot on connect. */
  cause: z.object({ revision: z.number(), author: Author, summary: z.string() }).nullable(),
});
export type ProjectEvent = z.infer<typeof ProjectEvent>;

export const ChatOutcome = z.enum(["committed", "no_changes", "commit_failed", "step_limit", "cancelled", "model_error"]);

export const ChatEntry = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), at: z.string(), text: z.string() }),
  z.object({
    role: z.literal("assistant"),
    at: z.string(),
    text: z.string(),
    outcome: ChatOutcome,
    /** Revision the turn's changes were saved as (committed turns only). */
    revision: z.number().nullable(),
    changes: z.array(z.string()),
    usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), cost: z.number().optional() }),
    error: z.string().optional(),
  }),
]);
export type ChatEntry = z.infer<typeof ChatEntry>;

export const ChatActivity = z.object({ kind: z.enum(["text", "tool"]), text: z.string(), ok: z.boolean().optional() });
export type ChatActivity = z.infer<typeof ChatActivity>;

export const ChatState = z.object({
  entries: z.array(ChatEntry),
  /** The turn in progress, if any. Edits and playtests are locked meanwhile. */
  running: z.object({ activity: z.array(ChatActivity) }).nullable(),
  /** Revisions that have since been undone. */
  undone: z.array(z.number()).default([]),
});
export type ChatState = z.infer<typeof ChatState>;

export const ChatEvent = z.object({ type: z.literal("chat"), agent: AgentId, chat: ChatState });
export type ChatEvent = z.infer<typeof ChatEvent>;

// --- art jobs ------------------------------------------------------------------
//   GET  /api/art                 -> ArtState
//   POST /api/art/jobs  ArtJobRequest -> { ok, jobId } or { ok, queued: true } (runs in the background; progress via `art` events)
//   POST /api/art/cancel  { jobId? }  -> { ok } (that running job; without jobId every running job and the queue)
//   GET  /api/files/<ref>         -> the stored image (concept sheets, renders)

/**
 * concepts: new 2x2 concept sheet (creates the character's art asset if needed)
 * choose:   pick a design from a sheet (default: latest sheet, AI's recommendation)
 * rig:      build (or, with feedback, revise) the rig from the chosen design
 * animate:  write the clips the character needs (its slots and its weapons' attack clips); `clip` (or
 *           `clips`) redoes only those by name, from `direction` (kept as each one's Clip.direction; else
 *           its stored one); `weaponId` only that weapon's attack clips
 * auto:    all of the above in order, taking the AI's recommendations
 */
export const ArtStage = z.enum([
  "concepts",
  "choose",
  "rig",
  "animate",
  "auto",
  "worldKit",
  "worldCompose",
  "worldRepaint",
  "propArt",
  "modalArt",
  "itemArt",
  "gameArt",
  "artDirection",
  "weaponArt",
]);
export type ArtStage = z.infer<typeof ArtStage>;

/** Stages that work on a biome. */
export const WORLD_STAGES: readonly ArtStage[] = ["worldKit", "worldCompose", "worldRepaint"];
/** Stages that work on a character. */
export const CHARACTER_STAGES: readonly ArtStage[] = ["concepts", "choose", "rig", "animate", "auto"];

/**
 * Character stages need `characterId`. World stages:
 *   worldKit:     paint a biome's kit (new biome from `brief` = theme, or `biomeId` to repaint all of it); `quality`
 *   worldCompose: compose a room for `biomeId` around a world room's tiles (`newLayout` also suggests platforms; `dressRoom` dresses that world room)
 *   worldRepaint: repaint one `part` of `biomeId`'s kit
 * Game stages:
 *   propArt:  draw the props of world room `worldRoomId` with its biome's kit (picking or painting pieces)
 *   modalArt: illustrate modal `modalId`
 *   itemArt:  draw icons for the items that have none
 *   weaponArt: draw weapon `weaponId`'s held sprite (one image) and find its grip and tip; `feedback` steers a redraw
 *   gameArt:  everything the game still needs (core gameArtPlan), step by step; `steps` limits it to those step ids
 *   artDirection: write the art direction (style, palette, outlines) from the wiki; only while it is a default
 */
export const ArtJobRequest = z
  .strictObject({
    stage: ArtStage,
    characterId: Id.optional(),
    biomeId: Id.optional(),
    /** New biome / room name. */
    name: z.string().trim().max(80).optional(),
    quality: z.enum(["draft", "final"]).optional(),
    newLayout: z.boolean().optional(),
    /** A world room to dress with the composed room. */
    dressRoom: Id.optional(),
    part: z.enum(["backdrop", "backgrounds", "structures", "props", "ground"]).optional(),
    /** worldCompose: recompose this biome room (instead of composing a new one). */
    roomId: Id.optional(),
    worldRoomId: Id.optional(),
    modalId: Id.optional(),
    /** weaponArt: the weapon to draw. animate: only this weapon's attack clips. */
    weaponId: Id.optional(),
    /** animate: only this clip, by name (a clip slot, a weapon attack clip or any other name), written from `direction`. */
    clip: Id.optional(),
    /** animate: what the clip(s) should be, in the creator's words (kept on Clip.direction to redo them). */
    direction: z.string().trim().max(600).optional(),
    /** animate: only these clips, by name (the game-art plan's missing ones); `direction` (else `feedback`) is kept as their direction. */
    clips: z.array(Id).min(1).max(64).optional(),
    /** gameArt: only these plan steps. */
    steps: z.array(z.string().max(120)).max(500).optional(),
    /** rig: vector, cutout or traced (default: the art direction's rigMode, else the backend's). */
    rigMode: z.enum(["vector", "cutout", "traced"]).optional(),
    brief: z.string().trim().max(2000).optional(),
  feedback: z.string().trim().max(1000).optional(),
  /** concepts: variations on the chosen design (it is sent as a reference image). */
  refine: z.boolean().optional(),
  sheet: z.number().int().min(0).optional(),
  cell: z.number().int().min(0).max(3).optional(),
  })
  .superRefine((r, ctx) => {
    const world = WORLD_STAGES.includes(r.stage);
    if (CHARACTER_STAGES.includes(r.stage) && !r.characterId) ctx.addIssue({ code: "custom", path: ["characterId"], message: `${r.stage} needs a characterId` });
    if (r.stage === "propArt" && !r.worldRoomId) ctx.addIssue({ code: "custom", path: ["worldRoomId"], message: "propArt needs a worldRoomId" });
    if (r.stage === "weaponArt" && !r.weaponId) ctx.addIssue({ code: "custom", path: ["weaponId"], message: "weaponArt needs a weaponId" });
    if (r.stage === "modalArt" && !r.modalId) ctx.addIssue({ code: "custom", path: ["modalId"], message: "modalArt needs a modalId" });
    if (world && r.stage !== "worldKit" && !r.biomeId) ctx.addIssue({ code: "custom", path: ["biomeId"], message: `${r.stage} needs a biomeId` });
    if (r.stage === "worldKit" && !r.biomeId && !r.brief) ctx.addIssue({ code: "custom", path: ["brief"], message: "a new biome needs a brief (its theme)" });
    if (r.stage === "worldRepaint" && !r.part) ctx.addIssue({ code: "custom", path: ["part"], message: "worldRepaint needs a part" });
  });
export type ArtJobRequest = z.input<typeof ArtJobRequest>;

export const ArtActivityEntry = z.object({
  at: z.string(),
  text: z.string(),
  cost: z.number().optional(),
  file: FileRef.optional(),
});
export type ArtActivityEntry = z.infer<typeof ArtActivityEntry>;

export const ArtJobOutcome = z.enum(["committed", "failed", "cancelled", "over_budget"]);

export const ArtJobSummary = z.object({
  id: z.string(),
  stage: ArtStage,
  /** The character or biome the job worked on. */
  characterId: z.string().optional(),
  biomeId: z.string().optional(),
  at: z.string(),
  outcome: ArtJobOutcome,
  /** USD. */
  cost: z.number(),
  summary: z.string(),
  error: z.string().optional(),
  /** Revisions saved by this job (one per completed stage). */
  revisions: z.array(z.number()),
  activity: z.array(ArtActivityEntry),
});
export type ArtJobSummary = z.infer<typeof ArtJobSummary>;

/** A running art job, as the studio shows it. */
export const ArtRunningJob = z.object({
  id: z.string(),
  stage: ArtStage,
  characterId: z.string().optional(),
  biomeId: z.string().optional(),
  weaponId: z.string().optional(),
  /** propArt: the world room whose props it draws. */
  worldRoomId: z.string().optional(),
  /** modalArt: the screen it illustrates. */
  modalId: z.string().optional(),
  startedAt: z.string(),
  cost: z.number(),
  activity: z.array(ArtActivityEntry),
  /** True when the job runs inside the Architect's run (which holds the project lock); false for background jobs, which never lock the creator out. */
  underLock: z.boolean().default(false),
  /** Why its finished stage isn't saved yet (a playtest or an AI turn is running), if it is waiting. */
  waiting: z.string().nullable().default(null),
});
export type ArtRunningJob = z.infer<typeof ArtRunningJob>;

export const ArtState = z.object({
  /** False when no model key is configured; jobs are refused. */
  available: z.boolean(),
  models: z.object({ image: z.string(), vision: z.string() }),
  /** USD limit per job. */
  budget: z.number(),
  /** How many jobs may run at once (STUDIO_ART_CONCURRENCY). */
  concurrency: z.number().int().min(1).default(1),
  /** Every running job, oldest first. Jobs that touch different things (characters, weapons, biomes, rooms, modals) run together. */
  runningJobs: z.array(ArtRunningJob).default([]),
  /** The oldest running job (runningJobs[0]), kept for older readers; null when none runs. */
  running: ArtRunningJob.nullable(),
  /** Recent jobs, newest last. */
  jobs: z.array(ArtJobSummary),
  /** Jobs waiting to start (queued by the chat, the creator or the live cast): no free slot yet, or they touch what a running job touches. */
  queued: z.number().default(0),
  /** What those queued jobs are, in order. */
  pending: z
    .array(
      z.object({
        stage: ArtStage,
        characterId: z.string().optional(),
        biomeId: z.string().optional(),
        weaponId: z.string().optional(),
        worldRoomId: z.string().optional(),
        modalId: z.string().optional(),
      }),
    )
    .default([]),
  /** USD spent on art in this project. */
  totalCost: z.number(),
});
export type ArtState = z.infer<typeof ArtState>;

export const ArtCancelRequest = z.strictObject({ jobId: z.string().max(80).optional() });

export const ArtEvent = z.object({ type: z.literal("art"), art: ArtState });
export type ArtEvent = z.infer<typeof ArtEvent>;

// --- the Architect ---------------------------------------------------------------
//   GET  /api/architect                        -> ArchitectState
//   POST /api/architect/run  ArchitectRunRequest -> { ok } (runs in the background; progress via `architect` events)
//   POST /api/architect/cancel                 -> { ok } (stops after the current stage)
// Stage results are committed to the project as revisions (undoable); stage status lives in project.architect.stages.

export const ArchitectRunRequest = z.strictObject({
  /** First stage to run (default: the first stage that isn't done, or "plan"). */
  from: ArchitectStage.optional(),
  /** Last stage to run (default: "art"). Pauses in the plan's pauseAfter still apply. */
  to: ArchitectStage.optional(),
  /** Only these plan rooms (regenerate one room or a region); default all unpinned rooms. */
  rooms: z.array(Id).max(200).optional(),
});
export type ArchitectRunRequest = z.infer<typeof ArchitectRunRequest>;

export const ArchitectLogEntry = z.object({ at: z.string(), stage: ArchitectStage, text: z.string() });
export type ArchitectLogEntry = z.infer<typeof ArchitectLogEntry>;

export const ArchitectIssueView = z.object({ stage: ArchitectStage, code: z.string(), message: z.string(), roomId: z.string().optional(), linkId: z.string().optional() });

export const ArchitectState = z.object({
  running: z
    .object({
      stage: ArchitectStage,
      /** The stages this run will go through, in order. */
      stages: z.array(ArchitectStage),
      startedAt: z.string(),
      rooms: z.array(z.string()).optional(),
    })
    .nullable(),
  /** How the last run ended. */
  last: z
    .object({
      outcome: z.enum(["finished", "paused", "failed", "cancelled"]),
      stage: ArchitectStage,
      at: z.string(),
      error: z.string().optional(),
      issues: z.array(ArchitectIssueView),
    })
    .nullable(),
  /** Recent activity, newest last. */
  log: z.array(ArchitectLogEntry),
});
export type ArchitectState = z.infer<typeof ArchitectState>;

export const ArchitectEvent = z.object({ type: z.literal("architect"), architect: ArchitectState });
export type ArchitectEvent = z.infer<typeof ArchitectEvent>;

// --- live: the studio fills in as the creator designs ------------------------------
//   GET  /api/live                     -> LiveState
//   POST /api/live  LiveSettingsRequest -> LiveState (turn the live cast / live rooms on or off)
// Background work: it never holds the project lock. Its results are saved as their own
// AI revisions onto the project as it is then (waiting while a playtest or an AI turn runs).

export const LiveSettings = z.object({
  /** Wiki pages of game characters become characters (linked, with a behavior and art), weapon pages weapons (linked, with attacks). */
  cast: z.boolean(),
  /** The progression's regions become rooms (the Architect's code stages, no model, no art). */
  rooms: z.boolean(),
});
export type LiveSettings = z.infer<typeof LiveSettings>;

export const LiveSettingsRequest = LiveSettings.partial().strict();

export const LiveState = z.object({
  settings: LiveSettings,
  cast: z.object({
    /** Characters (and weapons) being made or given a behavior (attacks) now. */
    working: z.array(z.string()),
    /** What the live cast is doing (empty when idle). */
    message: z.string(),
    /** The last problem, if the last run had one. */
    error: z.string().nullable(),
  }),
  rooms: z.object({
    status: z.enum(["idle", "building", "saving"]),
    /** What the live rooms did last or are doing. */
    message: z.string(),
    error: z.string().nullable(),
    /** The message reports the live rooms' own preview build: out of date once the plan is no longer the preview's (core previewOwnsPlan). */
    preview: z.boolean().default(false),
  }),
  /** Why background saves are waiting right now (a playtest, an AI turn), or null. */
  waiting: z.string().nullable(),
});
export type LiveState = z.infer<typeof LiveState>;

export const LiveEvent = z.object({ type: z.literal("live"), live: LiveState });
export type LiveEvent = z.infer<typeof LiveEvent>;

export const ServerEvent = z.discriminatedUnion("type", [ProjectEvent, ChatEvent, ArtEvent, ArchitectEvent, LiveEvent]);
export type ServerEvent = z.infer<typeof ServerEvent>;

// --- game export ---

/** One file of a game export (paths relative to its index.html). */
export interface ExportedFile {
  path: string;
  bytes: number;
  kind: "page" | "data" | "art" | "runtime" | "readme";
}

/** A built game export: the folder <project>/exports/<name>/ and its zip <name>.zip. */
export interface GameExportSummary {
  /** Safe file name, from the game's name. */
  name: string;
  /** The game's name (the page title). */
  title: string;
  /** The zip's file name (download it from GET /api/export/<zip>). */
  zip: string;
  zipBytes: number;
  /** Every file of the folder, in path order. */
  files: ExportedFile[];
  folderBytes: number;
  revision: number;
}

export const ExportRequest = z.strictObject({});
export type ExportResult = { ok: true; export: GameExportSummary } | { ok: false; error: OperationError };
