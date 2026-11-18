import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  gameArtPlan,
  ArtJobRequest,
  ArtJobSummary,
  fail,
  toIssues,
  type ArtActivityEntry,
  type ArtStage,
  type ArtState,
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

const RECENT_JOBS = 20;

export interface ArtModels {
  image: ImageModel;
  vision: VisionModel;
}

export interface ArtServiceOptions {
  /** Null when no API key is configured: jobs are refused with an explanation. */
  models: ArtModels | null;
  renderer: ArtRenderer;
  files: FileStore;
  /** USD limit per job. */
  budget: number;
  /** Shown when models are missing. */
  unavailableReason?: string;
  rigRounds?: number;
  animRounds?: number;
  roomRounds?: number;
  /** Rig mode when the art direction doesn't pick one: cutout for real models (it won the rig A/B, 2026-11-18). */
  defaultRigMode?: "vector" | "cutout" | "traced";
}

type Result = { ok: true; jobId: string; queued?: boolean } | { ok: false; error: OperationError };

/** A job waiting its turn. `onlyIfUndrawn`: skip it if the character is drawn (rigged) by the time it would start. */
interface Queued {
  request: unknown;
  onlyIfUndrawn?: boolean;
}

interface Running {
  id: string;
  /** The biome a world job works on (set once a new biome exists). */
  biomeId?: string;
  request: ReturnType<typeof ArtJobRequest.parse>;
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

/**
 * Runs art jobs (one at a time, the rest queued) and keeps their log
 * (<dir>/art-jobs.jsonl). Jobs are background work: they hold no lock, so the
 * creator keeps editing (and chatting) while one runs. Each completed stage is
 * saved as one AI change (one undo step) onto the project as it is then
 * (ProjectStore.commitBackground: its operations applied again), waiting while a
 * playtest or an AI turn runs; a stage whose changes no longer apply (its
 * character was deleted meanwhile) fails the job cleanly. An auto run that fails
 * late keeps the stages that worked. The Architect's game-art job is the
 * exception: it runs inside the run's lock and saves as the run's edits; it
 * stops a background job that is running (it draws whatever is missing anyway).
 */
export class ArtService {
  private readonly store: ProjectStore;
  private readonly options: ArtServiceOptions;
  private readonly path: string;
  private jobs: ArtJobSummary[];
  private totalCost: number;
  private running: Running | null = null;
  /** Jobs waiting to start. */
  private queue: Queued[] = [];
  private listeners = new Set<(state: ArtState) => void>();

  private constructor(store: ProjectStore, options: ArtServiceOptions, jobs: ArtJobSummary[], totalCost: number) {
    this.store = store;
    this.options = options;
    this.path = join(store.dir, "art-jobs.jsonl");
    this.jobs = jobs;
    this.totalCost = totalCost;
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
    const r = this.running;
    return {
      available: this.options.models !== null,
      models: { image: this.options.models?.image.id ?? "none", vision: this.options.models?.vision.id ?? "none" },
      budget: this.options.budget,
      running: r && {
        id: r.id,
        stage: r.request.stage,
        characterId: r.request.characterId,
        biomeId: r.biomeId,
        startedAt: r.startedAt,
        cost: r.cost,
        activity: r.activity,
        underLock: r.underLock,
        waiting: r.waiting,
      },
      jobs: this.jobs,
      queued: this.queue.length,
      pending: this.queue.flatMap(({ request }) => {
        const parsed = ArtJobRequest.safeParse(request);
        return parsed.success ? [{ stage: parsed.data.stage, characterId: parsed.data.characterId, biomeId: parsed.data.biomeId }] : [];
      }),
      totalCost: this.totalCost,
    };
  }

  subscribe(listener: (state: ArtState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start a job; it runs in the background and reports through events. While another
   * job runs it is queued instead. `underLock`: the caller holds the AI lock (an
   * Architect run) and keeps it; a background job in the way is stopped first.
   */
  async start(request: unknown, options: { underLock?: boolean } = {}): Promise<Result> {
    const parsed = ArtJobRequest.safeParse(request);
    if (!parsed.success) return fail("invalid_request", "malformed art job request", toIssues(parsed.error));
    if (!this.options.models) {
      return fail("unavailable", this.options.unavailableReason ?? "art generation is not configured (no model API key)");
    }
    const project = this.store.getState().project;
    const { characterId, biomeId, weaponId } = parsed.data;
    if (characterId !== undefined && !project.characters.some((c) => c.id === characterId)) {
      return fail("not_found", `no character "${characterId}"`);
    }
    if (weaponId !== undefined && !project.weapons.list.some((w) => w.id === weaponId)) {
      return fail("not_found", `no weapon "${weaponId}"`);
    }
    if (biomeId !== undefined && !project.art.assets.some((a) => a.id === biomeId && a.kind === "biome")) {
      return fail("not_found", `no biome "${biomeId}"`);
    }
    if (this.running && !options.underLock) {
      this.enqueue([request]);
      return { ok: true, jobId: "queued", queued: true };
    }
    if (this.running) {
      if (this.running.underLock) return fail("locked", "an art job is already running");
      // The Architect's game-art job draws everything still missing: background art makes way.
      const stopping = this.running;
      stopping.activity.push({ at: new Date().toISOString(), text: "stopped: the Architect's game-art job draws everything still missing" });
      this.queue = [];
      stopping.controller.abort();
      await stopping.done;
      if (this.running) return fail("locked", "an art job is already running");
    }

    const running: Running = {
      underLock: options.underLock ?? false,
      waiting: null,
      epoch: this.store.epoch(),
      id: `art_${Date.now().toString(36)}`,
      request: parsed.data,
      biomeId: parsed.data.biomeId,
      startedAt: new Date().toISOString(),
      activity: [],
      cost: 0,
      revisions: [],
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.running = running;
    this.emit();
    running.done = this.run(running, this.options.models);
    return { ok: true, jobId: running.id };
  }

  /**
   * Start jobs one after another (from a chat turn, the creator, the live cast).
   * A job that can't start is logged as failed, so the creator sees why. The same
   * job already queued or running isn't queued twice (an auto job per character).
   */
  enqueue(requests: unknown[], options: { onlyIfUndrawn?: boolean } = {}): void {
    for (const request of requests) {
      if (this.isQueued(request)) continue;
      this.queue.push({ request, ...(options.onlyIfUndrawn && { onlyIfUndrawn: true }) });
    }
    this.emit();
    void this.startNext();
  }

  private isQueued(request: unknown): boolean {
    const key = (r: unknown) => {
      const parsed = ArtJobRequest.safeParse(r);
      if (!parsed.success) return JSON.stringify(r);
      return parsed.data.stage === "auto" ? `auto:${parsed.data.characterId}` : JSON.stringify(parsed.data);
    };
    const k = key(request);
    return this.queue.some((q) => key(q.request) === k) || (this.running !== null && key(this.running.request) === k);
  }

  private drawn(request: unknown): boolean {
    const parsed = ArtJobRequest.safeParse(request);
    if (!parsed.success || !parsed.data.characterId) return false;
    const project = this.store.getState().project;
    const character = project.characters.find((c) => c.id === parsed.data.characterId);
    const asset = project.art.assets.find((a) => a.id === character?.appearance);
    return asset?.kind === "character" && asset.rig !== undefined;
  }

  private starting = false;

  private async startNext(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.startQueued();
    } finally {
      this.starting = false;
    }
  }

  private async startQueued(): Promise<void> {
    while (!this.running && this.queue.length > 0) {
      const { request, onlyIfUndrawn } = this.queue.shift()!;
      if (onlyIfUndrawn && this.drawn(request)) {
        this.emit();
        continue;
      }
      const started = await this.start(request);
      if (!started.ok) {
        const parsed = ArtJobRequest.safeParse(request);
        const failed: ArtJobSummary = {
          id: `art_${Date.now().toString(36)}`,
          stage: parsed.success ? parsed.data.stage : "concepts",
          characterId: parsed.success ? parsed.data.characterId : undefined,
          biomeId: parsed.success ? parsed.data.biomeId : undefined,
          at: new Date().toISOString(),
          outcome: "failed",
          cost: 0,
          summary: "nothing saved",
          error: `could not start: ${started.error.message}`,
          revisions: [],
          activity: [],
        };
        this.jobs = [...this.jobs, failed].slice(-RECENT_JOBS);
        await appendFile(this.path, JSON.stringify(failed) + "\n");
        this.emit();
      }
    }
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
   */
  private gameArtSteps(ctx: ArtContext, running: Running): Step[] {
    const wanted = running.request.steps;
    const plan = gameArtPlan(this.store.getState().project).filter((s) => !wanted || wanted.includes(s.id));
    const estimate = plan.reduce((sum, s) => sum + s.estimatedCost, 0);
    running.budget = Math.max(this.options.budget, estimate * 3);
    ctx.log({ text: `plan: ${plan.length} steps, about $${estimate.toFixed(2)}` });
    const biomes = new Map<string, string>();
    const failed = new Set<string>();
    const out: Step[] = [];
    for (const step of plan) {
      const r = step.request;
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
          const c = { characterId: r.characterId! };
          add("concepts", () => generateConcepts(ctx, c), true);
          add("choose", () => chooseConcept(ctx, c));
          add("rig", () => buildRig(ctx, c));
          add("animate", () => animate(ctx, c));
          break;
        }
        case "animate":
          add("animate", () => animate(ctx, { characterId: r.characterId!, ...(r.slots ? { slots: r.slots } : {}), ...(r.clips ? { clips: r.clips } : {}) }), true);
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
    }
    return out;
  }

  cancel(): { ok: true } {
    this.queue = [];
    this.running?.controller.abort();
    return { ok: true };
  }

  /** Resolves when the running job (if any) ends. */
  async idle(): Promise<void> {
    await this.running?.done;
  }

  /** Resolves when no job runs and none is queued (tests, scripts). */
  async drained(): Promise<void> {
    for (;;) {
      if (this.running) await this.running.done;
      else if (this.queue.length > 0 || this.starting) await new Promise((resolve) => setTimeout(resolve, 5));
      else return;
    }
  }

  private async run(running: Running, models: ArtModels): Promise<void> {
    const { request } = running;
    const ctx: ArtContext = {
      project: () => this.store.getState().project,
      image: models.image,
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

    const stages: { stage: Exclude<ArtStage, "auto">; run: () => Promise<StageResult> }[] = [];
    const character = { ...request, characterId: request.characterId ?? "" };
    const conceptStep = { stage: "concepts" as const, run: () => generateConcepts(ctx, character) };
    const chooseStep = { stage: "choose" as const, run: () => chooseConcept(ctx, character) };
    const rigStep = { stage: "rig" as const, run: () => buildRig(ctx, character) };
    const animStep = { stage: "animate" as const, run: () => animate(ctx, character) };
    switch (request.stage) {
      case "worldKit": {
        const isNew = !request.biomeId;
        stages.push({
          stage: "worldKit",
          run: async () => {
            const result = await worldKitStage(ctx, { ...request, theme: request.brief });
            running.biomeId = result.biomeId;
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
        stages.push(...this.gameArtSteps(ctx, running));
        break;
      case "artDirection":
        stages.push({ stage: "artDirection", run: () => artDirectionStage(ctx) });
        break;
      case "auto": {
        // Auto takes the AI's picks; feedback and sheet/cell choices apply to the first stage only.
        const plain = { characterId: request.characterId ?? "", rigMode: request.rigMode };
        stages.push(
          conceptStep,
          { stage: "choose", run: () => chooseConcept(ctx, plain) },
          { stage: "rig", run: () => buildRig(ctx, plain) },
          { stage: "animate", run: () => animate(ctx, plain) },
        );
        break;
      }
    }

    let outcome: ArtJobSummary["outcome"] = "committed";
    let error: string | undefined;
    const summaries: string[] = [];
    try {
      for (const step of stages) {
        if (running.controller.signal.aborted) throw new StageError("cancelled");
        const result = await step.run();
        // A cancel that arrived during the stage's last model call still wins.
        if (running.controller.signal.aborted) throw new StageError("cancelled");
        if (result.operations.length === 0) {
          if (result.summary) summaries.push(result.summary);
          continue;
        }
        const saved = running.underLock
          ? await this.store.applyBatch({ operations: result.operations, baseRevision: this.store.getState().project.revision, author: "ai" })
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
        if ("revision" in saved && saved.revision === null) continue;
        running.revisions.push(saved.project.revision);
        summaries.push(result.summary);
        ctx.log({ text: `saved: ${result.summary}` });
      }
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
      biomeId: running.biomeId,
      at: running.startedAt,
      outcome,
      cost: running.cost,
      summary: summaries.join("; ") || "nothing saved",
      ...(error ? { error } : {}),
      revisions: running.revisions,
      activity: running.activity,
    };
    this.running = null;
    this.totalCost += running.cost;
    this.jobs = [...this.jobs, summary].slice(-RECENT_JOBS);
    await appendFile(this.path, JSON.stringify(summary) + "\n");
    void this.startNext();
    console.info(`[art] ${request.stage} ${request.characterId ?? running.biomeId ?? "new biome"}: ${outcome}, ~$${running.cost.toFixed(4)}${error ? ` (${error})` : ""}`);
    this.emit();
  }

  /** Stop the jobs and clear the log (after a project reset, which already backed it up). */
  async reset(): Promise<void> {
    this.cancel();
    await this.idle();
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
