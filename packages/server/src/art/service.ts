import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
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
}

type Result = { ok: true; jobId: string } | { ok: false; error: OperationError };

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
}

/**
 * Runs art jobs (one at a time) and keeps their log (<dir>/art-jobs.jsonl).
 * A job holds the AI lock like a chat turn; each completed stage is saved as
 * one AI change (one undo step), so an auto run that fails late keeps the
 * stages that worked.
 */
export class ArtService {
  private readonly store: ProjectStore;
  private readonly options: ArtServiceOptions;
  private readonly path: string;
  private jobs: ArtJobSummary[];
  private totalCost: number;
  private running: Running | null = null;
  /** Jobs waiting to start (queued from chat turns). */
  private queue: unknown[] = [];
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
      },
      jobs: this.jobs,
      queued: this.queue.length,
      totalCost: this.totalCost,
    };
  }

  subscribe(listener: (state: ArtState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start a job; it runs in the background and reports through events. */
  async start(request: unknown): Promise<Result> {
    const parsed = ArtJobRequest.safeParse(request);
    if (!parsed.success) return fail("invalid_request", "malformed art job request", toIssues(parsed.error));
    if (!this.options.models) {
      return fail("unavailable", this.options.unavailableReason ?? "art generation is not configured (no model API key)");
    }
    const project = this.store.getState().project;
    const { characterId, biomeId } = parsed.data;
    if (characterId !== undefined && !project.characters.some((c) => c.id === characterId)) {
      return fail("not_found", `no character "${characterId}"`);
    }
    if (biomeId !== undefined && !project.art.assets.some((a) => a.id === biomeId && a.kind === "biome")) {
      return fail("not_found", `no biome "${biomeId}"`);
    }
    const lock = await this.store.beginAiTurn();
    if (!lock.ok) return lock;

    const running: Running = {
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
   * Start jobs one after another (from a chat turn, after it released the lock).
   * A job that can't start is logged as failed, so the creator sees why.
   */
  enqueue(requests: unknown[]): void {
    this.queue.push(...requests);
    this.emit();
    void this.startNext();
  }

  private async startNext(): Promise<void> {
    while (!this.running && this.queue.length > 0) {
      const request = this.queue.shift();
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

  cancel(): { ok: true } {
    this.queue = [];
    this.running?.controller.abort();
    return { ok: true };
  }

  async idle(): Promise<void> {
    await this.running?.done;
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
      log: (a) => {
        running.activity.push({ at: new Date().toISOString(), ...a });
        this.emit();
      },
      remaining: () => this.options.budget - running.cost,
      spend: (usage) => {
        running.cost += usage.cost;
        if (running.cost > this.options.budget) {
          throw new BudgetExceeded(`this job reached its $${this.options.budget.toFixed(2)} budget`);
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
      case "gameArt":
        stages.push({ stage: "gameArt", run: async () => { throw new StageError("gameArt is not implemented yet"); } });
        break;
      case "auto": {
        // Auto takes the AI's picks; feedback and sheet/cell choices apply to the first stage only.
        const plain = { characterId: request.characterId ?? "" };
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
        const saved = await this.store.applyBatch({
          operations: result.operations,
          baseRevision: this.store.getState().project.revision,
          author: "ai",
        });
        if (!saved.ok) throw new StageError(`saving the ${step.stage} result failed: ${saved.error.message}`);
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
    this.store.endAiTurn();
    this.running = null;
    this.totalCost += running.cost;
    this.jobs = [...this.jobs, summary].slice(-RECENT_JOBS);
    await appendFile(this.path, JSON.stringify(summary) + "\n");
    void this.startNext();
    console.info(`[art] ${request.stage} ${request.characterId ?? running.biomeId ?? "new biome"}: ${outcome}, ~$${running.cost.toFixed(4)}${error ? ` (${error})` : ""}`);
    this.emit();
  }

  /** Clear the job log (after a project reset, which already backed it up). */
  async reset(): Promise<void> {
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
