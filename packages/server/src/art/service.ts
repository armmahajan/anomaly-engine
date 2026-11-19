import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  gameArtPlan,
  isObjectAsset,
  ArtJobRequest,
  ArtJobSummary,
  fail,
  toIssues,
  type ArtActivityEntry,
  type ArtRunningJob,
  type ArtStage,
  type ArtState,
  type OperationCall,
  type OperationError,
} from "@anomaly/core";
import {
  animate,
  buildRig,
  BudgetExceeded,
  chooseConcept,
  generateConcepts,
  worldComposeStage,
  worldKitStage,
  worldRepaintStage,
  propArtStage,
  modalArtStage,
  itemArtStage,
  artDirectionStage,
  weaponArtStage,
  StageError,
  type ArtContext,
  type ArtRenderer,
  type FileStore,
  type ImageModel,
  type StageResult,
  type VisionModel,
} from "@anomaly/art";
import type { ProjectStore } from "../projectStore.ts";
import { conflicts, EVERYTHING, jobKeys, lanesOf, runLanes } from "./scheduling.ts";

const RECENT_JOBS = 20;
/** Jobs that run at once by default (STUDIO_ART_CONCURRENCY). */
export const DEFAULT_ART_CONCURRENCY = 3;

export interface ArtModels {
  image: ImageModel;
  vision: VisionModel;
  /** Image models the creator can pick for all art (the art direction's imageModel), first = default. */
  imageChoices?: { id: string; label: string; model: ImageModel }[];
}

/**
 * The image model a job draws with: the art direction's pick when the studio offers it, else the default.
 * A request the pick can't take (a reference image, a transparent background) goes to the default instead,
 * so every step still works; the result's `model` says which one drew it.
 */
export function imageModelFor(models: ArtModels, picked: string | undefined): ImageModel {
  const choice = picked ? (models.imageChoices ?? []).find((m) => m.id === picked)?.model : undefined;
  if (!choice || choice === models.image) return models.image;
  const fallback = models.image;
  return {
    id: choice.id,
    accepts: () => true,
    generate: (request) => ((choice.accepts?.(request) ?? true) ? choice : fallback).generate(request),
  };
}

export interface ArtServiceOptions {
  /** Null when no API key is configured: jobs are refused with an explanation. */
  models: ArtModels | null;
  renderer: ArtRenderer;
  files: FileStore;
  /** USD limit per job. */
  budget: number;
  /** Jobs that may run at once (default 3); 1 runs them one at a time. Inside the game-art job, independent steps run this many at once too. */
  concurrency?: number;
  /** Shown when models are missing. */
  unavailableReason?: string;
  rigRounds?: number;
  animRounds?: number;
  roomRounds?: number;
  /** Rig mode when the art direction doesn't pick one: cutout for real models (it won the rig A/B, 2026-11-18). */
  defaultRigMode?: "vector" | "cutout" | "traced";
}

type Result = { ok: true; jobId: string; queued?: boolean } | { ok: false; error: OperationError };
type Parsed = ReturnType<typeof ArtJobRequest.parse>;

/** A job waiting its turn. `onlyIfUndrawn`: skip it if the character is drawn (rigged) by the time it would start. */
interface Queued {
  request: unknown;
  onlyIfUndrawn?: boolean;
}

interface Running {
  id: string;
  /** The biome a world job works on (set once a new biome exists). */
  biomeId?: string;
  request: Parsed;
  /** What it touches (scheduling.ts): a job conflicting with these waits. Grows as the job creates things (a new biome). */
  keys: string[];
  startedAt: string;
  activity: ArtActivityEntry[];
  cost: number;
  revisions: number[];
  controller: AbortController;
  done: Promise<void>;
  /** USD this job may spend (gameArt gets its plan's estimate, with headroom). */
  budget?: number;
  /** True when the job runs inside the lock of an Architect run (its stages save as the run's AI edits). Otherwise it is background work. */
  underLock: boolean;
  /** Why its finished stage waits to be saved, if it does. */
  waiting: string | null;
  /** The store's epoch when it started (a reset since means it saves nothing). */
  epoch: number;
}

type Step = { stage: Exclude<ArtStage, "auto">; run: () => Promise<StageResult> };
/** Lanes that may run side by side; each lane's steps run in order. */
type Phase = Step[][];

/**
 * Runs art jobs and keeps their log (<dir>/art-jobs.jsonl). Up to `concurrency`
 * jobs run at once; a job that touches what a running job touches (the same
 * character, weapon, biome, room or modal; see scheduling.ts) or finds no free
 * slot queues, and starts when it can, never ahead of an earlier queued job it
 * conflicts with. The art direction and the game-art job touch everything and
 * run alone. Jobs are background work: they hold no lock, so the creator keeps
 * editing (and chatting) while they run. Each completed stage is saved as one AI
 * change (one undo step) onto the project as it is then
 * (ProjectStore.commitBackground: its operations applied again; the store
 * serializes saves, and conflicting jobs never run together, so concurrent saves
 * touch different things), waiting while a playtest or an AI turn runs; a stage
 * whose changes no longer apply (its character was deleted meanwhile) fails the
 * job cleanly. Each job has its own budget, activity, cancel and revisions. An
 * auto run that fails late keeps the stages that worked. The Architect's
 * game-art job is the exception: it runs inside the run's lock and saves as the
 * run's edits; it stops the background jobs that are running (it draws whatever
 * is missing anyway).
 */
export class ArtService {
  private readonly store: ProjectStore;
  private readonly options: ArtServiceOptions;
  private readonly path: string;
  private readonly concurrency: number;
  private jobs: ArtJobSummary[];
  private totalCost: number;
  /** Running jobs by id, oldest first. */
  private active = new Map<string, Running>();
  /** Jobs waiting to start. */
  private queue: Queued[] = [];
  private listeners = new Set<(state: ArtState) => void>();
  private seq = 0;
  /** Job log appends, in order. */
  private writes: Promise<void> = Promise.resolve();
  /** Saves of jobs inside the Architect's lock, one at a time (each based on the revision it lands on). */
  private lockedSaves: Promise<unknown> = Promise.resolve();
  private pumping = false;
  private pumpAgain = false;

  private constructor(store: ProjectStore, options: ArtServiceOptions, jobs: ArtJobSummary[], totalCost: number) {
    this.store = store;
    this.options = options;
    this.path = join(store.dir, "art-jobs.jsonl");
    this.jobs = jobs;
    this.totalCost = totalCost;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_ART_CONCURRENCY));
  }

  static async open(store: ProjectStore, options: ArtServiceOptions): Promise<ArtService> {
    let raw = "";
    try {
      raw = await readFile(join(store.dir, "art-jobs.jsonl"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const all = raw
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          const parsed = ArtJobSummary.safeParse(JSON.parse(l));
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      });
    const total = all.reduce((sum, j) => sum + j.cost, 0);
    return new ArtService(store, options, all.slice(-RECENT_JOBS), total);
  }

  getState(): ArtState {
    const runningJobs: ArtRunningJob[] = [...this.active.values()].map((r) => ({
      id: r.id,
      stage: r.request.stage,
      characterId: r.request.characterId,
      objectId: r.request.objectId,
      biomeId: r.biomeId,
      weaponId: r.request.weaponId,
      worldRoomId: r.request.worldRoomId,
      modalId: r.request.modalId,
      startedAt: r.startedAt,
      cost: r.cost,
      activity: r.activity,
      underLock: r.underLock,
      waiting: r.waiting,
    }));
    return {
      available: this.options.models !== null,
      models: {
        image: this.options.models?.image.id ?? "none",
        vision: this.options.models?.vision.id ?? "none",
        imageChoices: (this.options.models?.imageChoices ?? []).map(({ id, label }) => ({ id, label })),
      },
      budget: this.options.budget,
      concurrency: this.concurrency,
      runningJobs,
      running: runningJobs[0] ?? null,
      jobs: this.jobs,
      queued: this.queue.length,
      pending: this.queue.flatMap(({ request }) => {
        const parsed = ArtJobRequest.safeParse(request);
        if (!parsed.success) return [];
        const { stage, characterId, objectId, biomeId, weaponId, worldRoomId, modalId } = parsed.data;
        return [{ stage, characterId, objectId, biomeId, weaponId, worldRoomId, modalId }];
      }),
      totalCost: this.totalCost,
    };
  }

  subscribe(listener: (state: ArtState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A request that can run now, or why not (malformed, no models, an unknown character/object/weapon/biome). */
  private check(request: unknown): { ok: true; request: Parsed } | { ok: false; error: OperationError } {
    const parsed = ArtJobRequest.safeParse(request);
    if (!parsed.success) return fail("invalid_request", "malformed art job request", toIssues(parsed.error));
    if (!this.options.models) {
      return fail("unavailable", this.options.unavailableReason ?? "art generation is not configured (no model API key)");
    }
    const project = this.store.getState().project;
    const { characterId, objectId, biomeId, weaponId } = parsed.data;
    if (characterId !== undefined && !project.characters.some((c) => c.id === characterId)) {
      return fail("not_found", `no character "${characterId}"`);
    }
    if (objectId !== undefined) {
      const asset = project.art.assets.find((a) => a.id === objectId);
      if (!asset) return fail("not_found", `no object "${objectId}"`);
      const what = asset.kind === "character" ? "a character's look" : `a ${asset.kind}`;
      if (!isObjectAsset(asset)) return fail("invalid_request", `"${objectId}" is not an object asset (it is ${what}); objectId takes an object (createObject makes one)`);
    }
    if (weaponId !== undefined && !project.weapons.list.some((w) => w.id === weaponId)) {
      return fail("not_found", `no weapon "${weaponId}"`);
    }
    if (biomeId !== undefined && !project.art.assets.some((a) => a.id === biomeId && a.kind === "biome")) {
      return fail("not_found", `no biome "${biomeId}"`);
    }
    return { ok: true, request: parsed.data };
  }

  /** A free slot, and nothing running (or queued ahead, `ahead`) touches what `keys` touch. */
  private canRun(keys: string[], ahead: string[][]): boolean {
    if (this.active.size >= this.concurrency) return false;
    for (const r of this.active.values()) if (conflicts(r.keys, keys)) return false;
    return !ahead.some((k) => conflicts(k, keys));
  }

  private queuedKeys(): string[][] {
    const project = this.store.getState().project;
    return this.queue.flatMap(({ request }) => {
      const parsed = ArtJobRequest.safeParse(request);
      return parsed.success ? [jobKeys(parsed.data, project)] : [];
    });
  }

  /**
   * Start a job; it runs in the background and reports through events. When it
   * can't run yet (no free slot, or it touches what a running or earlier queued
   * job touches) it is queued instead. `underLock`: the caller holds the AI lock
   * (an Architect run) and keeps it; background jobs in the way are stopped first.
   */
  async start(request: unknown, options: { underLock?: boolean } = {}): Promise<Result> {
    const checked = this.check(request);
    if (!checked.ok) return checked;
    const parsed = checked.request;
    if (!options.underLock) {
      const keys = jobKeys(parsed, this.store.getState().project);
      if (this.canRun(keys, this.queuedKeys())) return { ok: true, jobId: this.launch(parsed, keys, false).id };
      this.enqueue([request]);
      return { ok: true, jobId: "queued", queued: true };
    }
    const running = [...this.active.values()];
    if (running.some((r) => r.underLock)) return fail("locked", "an art job is already running");
    if (running.length > 0) {
      // The Architect's game-art job draws everything still missing: background art makes way.
      this.queue = [];
      for (const stopping of running) {
        stopping.activity.push({ at: new Date().toISOString(), text: "stopped: the Architect's game-art job draws everything still missing" });
        stopping.controller.abort();
      }
      await Promise.all(running.map((r) => r.done));
      if (this.active.size > 0) return fail("locked", "an art job is already running");
    }
    return { ok: true, jobId: this.launch(parsed, jobKeys(parsed, this.store.getState().project), true).id };
  }

  /** `announce`: tell listeners now (the queue pump tells them once it is done). */
  private launch(request: Parsed, keys: string[], underLock: boolean, announce = true): Running {
    const running: Running = {
      underLock,
      waiting: null,
      epoch: this.store.epoch(),
      id: `art_${Date.now().toString(36)}_${(++this.seq).toString(36)}`,
      request,
      keys,
      biomeId: request.biomeId,
      startedAt: new Date().toISOString(),
      activity: [],
      cost: 0,
      revisions: [],
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(running.id, running);
    if (announce) this.emit();
    running.done = this.run(running, this.options.models!);
    return running;
  }

  /**
   * Queue jobs (from a chat turn, the creator, the live cast); each starts as soon
   * as it can. A job that can't start is logged as failed, so the creator sees
   * why. The same job already queued or running isn't queued twice (an auto job
   * per character).
   */
  enqueue(requests: unknown[], options: { onlyIfUndrawn?: boolean } = {}): void {
    for (const request of requests) {
      if (this.isQueued(request)) continue;
      this.queue.push({ request, ...(options.onlyIfUndrawn && { onlyIfUndrawn: true }) });
    }
    this.emit();
    this.pump();
  }

  private isQueued(request: unknown): boolean {
    const key = (r: unknown) => {
      const parsed = ArtJobRequest.safeParse(r);
      if (!parsed.success) return JSON.stringify(r);
      return parsed.data.stage === "auto" ? `auto:${parsed.data.objectId ? `object:${parsed.data.objectId}` : parsed.data.characterId}` : JSON.stringify(parsed.data);
    };
    const k = key(request);
    return this.queue.some((q) => key(q.request) === k) || [...this.active.values()].some((r) => key(r.request) === k);
  }

  private drawn(request: unknown): boolean {
    const parsed = ArtJobRequest.safeParse(request);
    if (!parsed.success) return false;
    const project = this.store.getState().project;
    if (parsed.data.objectId) {
      const object = project.art.assets.find((a) => a.id === parsed.data.objectId);
      return isObjectAsset(object) && object.rig !== null;
    }
    if (!parsed.data.characterId) return false;
    const character = project.characters.find((c) => c.id === parsed.data.characterId);
    const asset = project.art.assets.find((a) => a.id === character?.appearance);
    return asset?.kind === "character" && asset.rig !== null;
  }

  /** Start every queued job that can run now, in queue order; a job never passes an earlier one it conflicts with. */
  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const ahead: string[][] = [];
        const waiting: Queued[] = [];
        for (const entry of this.queue) {
          if (entry.onlyIfUndrawn && this.drawn(entry.request)) continue;
          const checked = this.check(entry.request);
          if (!checked.ok) {
            this.recordUnstarted(entry.request, checked.error.message);
            continue;
          }
          const keys = jobKeys(checked.request, this.store.getState().project);
          if (this.canRun(keys, ahead)) {
            this.launch(checked.request, keys, false, false);
            continue;
          }
          waiting.push(entry);
          ahead.push(keys);
        }
        this.queue = waiting;
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
    this.emit();
  }

  /** Log a queued job that couldn't start, so the creator sees why. */
  private recordUnstarted(request: unknown, message: string): void {
    const parsed = ArtJobRequest.safeParse(request);
    const failed: ArtJobSummary = {
      id: `art_${Date.now().toString(36)}_${(++this.seq).toString(36)}`,
      stage: parsed.success ? parsed.data.stage : "concepts",
      characterId: parsed.success ? parsed.data.characterId : undefined,
      objectId: parsed.success ? parsed.data.objectId : undefined,
      biomeId: parsed.success ? parsed.data.biomeId : undefined,
      at: new Date().toISOString(),
      outcome: "failed",
      cost: 0,
      summary: "nothing saved",
      error: `could not start: ${message}`,
      revisions: [],
      activity: [],
    };
    this.jobs = [...this.jobs, failed].slice(-RECENT_JOBS);
    this.append(failed);
  }

  private append(summary: ArtJobSummary): Promise<void> {
    this.writes = this.writes.then(() => appendFile(this.path, JSON.stringify(summary) + "\n")).catch((e: unknown) => console.error("[art] job log:", e));
    return this.writes;
  }

  /** One recompose step per existing room of a biome (each its own cheap call and AI change). */
  private recomposeRooms(ctx: ArtContext, biomeId: string): { stage: "worldCompose"; run: () => Promise<StageResult> }[] {
    const biome = this.store.getState().project.art.assets.find((a) => a.id === biomeId);
    if (!biome || biome.kind !== "biome") return [];
    return biome.rooms.map((room) => ({
      stage: "worldCompose" as const,
      run: () => worldComposeStage(ctx, { biomeId, roomId: room.id }),
    }));
  }

  /**
   * The game-art job: core gameArtPlan's steps (or the requested subset), each run as its
   * usual stages and saved on its own. A failed step is logged and skipped, along with the
   * steps that need it (the rooms of a biome that failed); planning again later resumes.
   * Steps that touch different things (scheduling.ts: characters, weapons, a biome with its
   * rooms and props, modals, item icons) run side by side, up to the service's concurrency;
   * a step that touches everything (the art direction) runs alone before the ones after it.
   */
  private gameArtPhases(ctx: ArtContext, running: Running): Phase[] {
    const wanted = running.request.steps;
    const project = this.store.getState().project;
    const plan = gameArtPlan(project).filter((s) => !wanted || wanted.includes(s.id));
    const estimate = plan.reduce((sum, s) => sum + s.estimatedCost, 0);
    running.budget = Math.max(this.options.budget, estimate * 3);
    ctx.log({ text: `plan: ${plan.length} steps, about $${estimate.toFixed(2)}` });
    const biomes = new Map<string, string>();
    const failed = new Set<string>();
    const groups: { steps: Step[]; keys: string[] }[] = [];
    for (const step of plan) {
      const r = step.request;
      const out: Step[] = [];
      const add = (stage: Step["stage"], run: () => Promise<StageResult>, first = false) =>
        out.push({
          stage,
          run: async () => {
            if (failed.has(step.id) || (r.biomeStep && failed.has(r.biomeStep))) return { operations: [], summary: "" };
            if (first) ctx.log({ text: `step ${step.id}: ${step.description}` });
            try {
              return await run();
            } catch (e) {
              if (e instanceof BudgetExceeded || running.controller.signal.aborted) throw e;
              failed.add(step.id);
              ctx.log({ text: `step ${step.id} failed: ${e instanceof Error ? e.message : String(e)}` });
              return { operations: [], summary: `${step.id} failed` };
            }
          },
        });
      switch (r.stage) {
        case "artDirection":
          add("artDirection", () => artDirectionStage(ctx), true);
          break;
        case "auto": {
          const c = r.objectId ? { objectId: r.objectId } : { characterId: r.characterId! };
          // Pick up where the character (or object) stands (a job stopped part-way, the creator's own sheets): concept
          // sheets already drawn are chosen from, a chosen design is built on; only what's missing is drawn.
          const character = project.characters.find((ch) => ch.id === r.characterId);
          const assetId = r.objectId ?? character?.appearance;
          const asset = assetId ? project.art.assets.find((a) => a.id === assetId) : undefined;
          const drawn = asset?.kind === "character" ? asset : undefined;
          const sheets = (drawn?.concepts.length ?? 0) > 0;
          const chosen = !!drawn?.chosen;
          if (!chosen && !sheets) add("concepts", () => generateConcepts(ctx, c), true);
          if (!chosen) add("choose", () => chooseConcept(ctx, c), sheets);
          add("rig", () => buildRig(ctx, c), chosen);
          add("animate", () => animate(ctx, c));
          break;
        }
        case "animate":
          add("animate", () => animate(ctx, { ...(r.objectId ? { objectId: r.objectId } : { characterId: r.characterId! }), ...(r.slots ? { slots: r.slots } : {}), ...(r.clips ? { clips: r.clips } : {}) }), true);
          break;
        case "weaponArt":
          add("weaponArt", () => weaponArtStage(ctx, { weaponId: r.weaponId! }), true);
          break;
        case "worldKit":
          add(
            "worldKit",
            async () => {
              const result = await worldKitStage(ctx, { theme: r.brief, name: r.name });
              biomes.set(step.id, result.biomeId);
              return result;
            },
            true,
          );
          break;
        case "worldCompose":
          add("worldCompose", () => worldComposeStage(ctx, { biomeId: r.biomeId ?? biomes.get(r.biomeStep!)!, roomId: r.roomId, dressRoom: r.dressRoom }), true);
          break;
        case "propArt":
          add("propArt", () => propArtStage(ctx, { worldRoomId: r.worldRoomId! }), true);
          break;
        case "modalArt":
          add("modalArt", () => modalArtStage(ctx, { modalId: r.modalId! }), true);
          break;
        case "itemArt":
          add("itemArt", () => itemArtStage(ctx), true);
          break;
      }
      // A worldKit step is keyed by its own id too, so the steps that use its biome (biomeStep) follow it in its lane.
      const keys = jobKeys(r, project);
      groups.push({ steps: out, keys: r.stage === "worldKit" ? [...keys, `biomeStep:${step.id}`] : keys });
    }
    // One at a time: today's order exactly.
    if (this.concurrency === 1) return [[groups.flatMap((g) => g.steps)]];
    const phases: Phase[] = [];
    let together: typeof groups = [];
    const flush = () => {
      if (together.length) phases.push(lanesOf(together, (g) => g.keys).map((lane) => lane.flatMap((g) => g.steps)));
      together = [];
    };
    for (const group of groups) {
      if (group.keys.includes(EVERYTHING)) {
        flush();
        phases.push([group.steps]);
      } else together.push(group);
    }
    flush();
    return phases;
  }

  /** Cancel one running job (`jobId`), or every running job and the queue. */
  cancel(jobId?: string): { ok: true } | { ok: false; error: OperationError } {
    if (jobId !== undefined) {
      const running = this.active.get(jobId);
      if (!running) return fail("not_found", `no running art job "${jobId}"`);
      running.controller.abort();
      return { ok: true };
    }
    this.queue = [];
    for (const running of this.active.values()) running.controller.abort();
    this.emit();
    return { ok: true };
  }

  /** Resolves when no job runs (jobs the ones finishing start are waited for too). */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((r) => r.done));
  }

  /** Resolves when job `jobId` ends, with its summary. */
  async finished(jobId: string): Promise<ArtJobSummary | undefined> {
    await this.active.get(jobId)?.done;
    return this.jobs.find((j) => j.id === jobId);
  }

  /** Resolves when no job runs, none is queued and the job log is written (tests, scripts). */
  async drained(): Promise<void> {
    for (;;) {
      await this.idle();
      if (this.queue.length === 0) break;
      this.pump();
      if (this.active.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.writes;
  }

  /** Save under the Architect's lock: one at a time, each based on the revision it lands on. */
  private saveLocked(operations: OperationCall[]) {
    const save = this.lockedSaves.then(() =>
      this.store.applyBatch({ operations, baseRevision: this.store.getState().project.revision, author: "ai" }),
    );
    this.lockedSaves = save.catch(() => {});
    return save;
  }

  private async run(running: Running, models: ArtModels): Promise<void> {
    const { request } = running;
    const ctx: ArtContext = {
      project: () => this.store.getState().project,
      image: imageModelFor(models, this.store.getState().project.art.direction.imageModel),
      vision: models.vision,
      renderer: this.options.renderer,
      files: this.options.files,
      signal: running.controller.signal,
      rigRounds: this.options.rigRounds,
      animRounds: this.options.animRounds,
      roomRounds: this.options.roomRounds,
      ...(this.options.defaultRigMode ? { defaultRigMode: this.options.defaultRigMode } : {}),
      log: (a) => {
        running.activity.push({ at: new Date().toISOString(), ...a });
        this.emit();
      },
      remaining: () => (running.budget ?? this.options.budget) - running.cost,
      spend: (usage) => {
        running.cost += usage.cost;
        const budget = running.budget ?? this.options.budget;
        if (running.cost > budget) {
          throw new BudgetExceeded(`this job reached its $${budget.toFixed(2)} budget`);
        }
      },
    };
    // A job's keys grow with what it creates (a new biome): later jobs on it wait.
    const touch = () => {
      const keys = jobKeys({ ...request, biomeId: running.biomeId }, this.store.getState().project);
      running.keys = [...new Set([...running.keys, ...keys])];
    };

    const stages: Step[] = [];
    // A character stage's subject: the object when the request names one, else the character.
    const character = { ...request, characterId: request.characterId ?? "" };
    const conceptStep = { stage: "concepts" as const, run: () => generateConcepts(ctx, character) };
    const chooseStep = { stage: "choose" as const, run: () => chooseConcept(ctx, character) };
    const rigStep = { stage: "rig" as const, run: () => buildRig(ctx, character) };
    const animStep = { stage: "animate" as const, run: () => animate(ctx, character) };
    let phases: Phase[] | null = null;
    switch (request.stage) {
      case "worldKit": {
        const isNew = !request.biomeId;
        stages.push({
          stage: "worldKit",
          run: async () => {
            const result = await worldKitStage(ctx, { ...request, theme: request.brief });
            running.biomeId = result.biomeId;
            running.keys = [...new Set([...running.keys, `biome:${result.biomeId}`])];
            return result;
          },
        });
        // A new biome gets its first room right away (one cheap call), so there is something to look at;
        // a repainted one gets its rooms recomposed, since the new sheets hold different pieces.
        if (isNew) {
          stages.push({
            stage: "worldCompose",
            run: () => worldComposeStage(ctx, { biomeId: running.biomeId!, dressRoom: request.dressRoom }),
          });
        } else {
          stages.push(...this.recomposeRooms(ctx, request.biomeId!));
        }
        break;
      }
      case "worldCompose":
        stages.push({ stage: "worldCompose", run: () => worldComposeStage(ctx, { ...request, biomeId: request.biomeId! }) });
        break;
      case "worldRepaint":
        stages.push({ stage: "worldRepaint", run: () => worldRepaintStage(ctx, { biomeId: request.biomeId!, part: request.part!, feedback: request.feedback }) });
        if (request.part === "structures" || request.part === "props") stages.push(...this.recomposeRooms(ctx, request.biomeId!));
        break;
      case "concepts":
        stages.push(conceptStep);
        break;
      case "choose":
        stages.push(chooseStep);
        break;
      case "rig":
        stages.push(rigStep);
        break;
      case "animate":
        stages.push(animStep);
        break;
      case "propArt":
        stages.push({ stage: "propArt", run: () => propArtStage(ctx, { worldRoomId: request.worldRoomId! }) });
        break;
      case "modalArt":
        stages.push({ stage: "modalArt", run: () => modalArtStage(ctx, { modalId: request.modalId! }) });
        break;
      case "itemArt":
        stages.push({ stage: "itemArt", run: () => itemArtStage(ctx) });
        break;
      case "weaponArt":
        stages.push({ stage: "weaponArt", run: () => weaponArtStage(ctx, { weaponId: request.weaponId!, feedback: request.feedback }) });
        break;
      case "gameArt":
        phases = this.gameArtPhases(ctx, running);
        break;
      case "artDirection":
        stages.push({ stage: "artDirection", run: () => artDirectionStage(ctx) });
        break;
      case "auto": {
        // Auto takes the AI's picks; feedback and sheet/cell choices apply to the first stage only.
        const plain = { characterId: request.characterId ?? "", objectId: request.objectId, rigMode: request.rigMode };
        stages.push(
          conceptStep,
          { stage: "choose", run: () => chooseConcept(ctx, plain) },
          { stage: "rig", run: () => buildRig(ctx, plain) },
          { stage: "animate", run: () => animate(ctx, plain) },
        );
        break;
      }
    }

    const summaries: string[] = [];
    const runStep = async (step: Step): Promise<void> => {
      if (running.controller.signal.aborted) throw new StageError("cancelled");
      const result = await step.run();
      // A cancel that arrived during the stage's last model call still wins.
      if (running.controller.signal.aborted) throw new StageError("cancelled");
      if (result.operations.length === 0) {
        if (result.summary) summaries.push(result.summary);
        return;
      }
      const saved = running.underLock
        ? await this.saveLocked(result.operations)
        : await this.store.commitBackground(() => ({ operations: result.operations }), {
            signal: running.controller.signal,
            epoch: running.epoch,
            onWait: (reason) => {
              running.waiting = reason;
              if (reason) ctx.log({ text: `waiting to save (${reason})` });
              else this.emit();
            },
          });
      if (running.controller.signal.aborted) throw new StageError("cancelled");
      if (!saved.ok) throw new StageError(`saving the ${step.stage} result failed: ${saved.error.message}`);
      if ("revision" in saved && saved.revision === null) return;
      touch();
      running.revisions.push(saved.project.revision);
      summaries.push(result.summary);
      ctx.log({ text: `saved: ${result.summary}` });
    };

    let outcome: ArtJobSummary["outcome"] = "committed";
    let error: string | undefined;
    try {
      for (const phase of phases ?? [[stages]]) await runLanes(phase, this.concurrency, runStep);
    } catch (e) {
      if (running.controller.signal.aborted) outcome = "cancelled";
      else if (e instanceof BudgetExceeded) outcome = "over_budget";
      else outcome = "failed";
      error = e instanceof Error ? e.message : String(e);
      if (outcome !== "cancelled" && !(e instanceof StageError) && !(e instanceof BudgetExceeded)) {
        console.error("[art]", e);
      }
    }

    const summary: ArtJobSummary = {
      id: running.id,
      stage: request.stage,
      characterId: request.characterId,
      objectId: request.objectId,
      biomeId: running.biomeId,
      at: running.startedAt,
      outcome,
      cost: running.cost,
      summary: summaries.join("; ") || "nothing saved",
      ...(error ? { error } : {}),
      revisions: running.revisions,
      activity: running.activity,
    };
    this.active.delete(running.id);
    this.totalCost += running.cost;
    this.jobs = [...this.jobs, summary].slice(-RECENT_JOBS);
    await this.append(summary);
    console.info(`[art] ${request.stage} ${request.characterId ?? request.objectId ?? request.weaponId ?? running.biomeId ?? "new biome"}: ${outcome}, ~$${running.cost.toFixed(4)}${error ? ` (${error})` : ""}`);
    this.pump();
  }

  /** Stop the jobs and clear the log (after a project reset, which already backed it up). */
  async reset(): Promise<void> {
    this.cancel();
    await this.idle();
    await this.writes;
    this.jobs = [];
    this.totalCost = 0;
    await writeFile(this.path, "");
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
