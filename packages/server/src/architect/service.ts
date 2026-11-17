import {
  ARCHITECT_STAGES,
  ArchitectRunRequest,
  difficultyStage,
  fail,
  geometryStage,
  layoutStage,
  populationStage,
  screensStage,
  seedPlan,
  toIssues,
  verifyStage,
  type ArchitectStage,
  type ArchitectState,
  type OperationError,
  type ProjectSpec,
  type StageIssue,
  type StageStatus,
} from "@anomaly/core";
import type { ArtService } from "../art/service.ts";
import type { ProjectStore } from "../projectStore.ts";

/**
 * Runs the Architect: its stages in order on the project, each result committed
 * as one undoable revision by the AI (with the stage's status), pausing where the
 * plan says, stopping on a failed verify (no art for a broken game) or when
 * cancelled. While it runs the project is locked to everyone but the AI, as for a
 * chat turn. Stage runners are injectable: model stages (plan, cast) come from the
 * Architect agent; the defaults are deterministic (the plan seeded from the
 * progression, the code stages from core).
 */

export interface StageRunContext {
  project: ProjectSpec;
  /** Only these plan rooms (regenerating part of the world). */
  rooms?: string[];
  signal: AbortSignal;
  log: (text: string) => void;
}

export interface StageRunResult {
  project: ProjectSpec;
  issues: StageIssue[];
  summary: string;
}

export type StageRunner = (ctx: StageRunContext) => Promise<StageRunResult>;
export type StageRunners = Record<ArchitectStage, StageRunner>;

const sync = (fn: (project: ProjectSpec, options?: { rooms?: string[] }) => StageRunResult): StageRunner => async (ctx) =>
  fn(ctx.project, ctx.rooms ? { rooms: ctx.rooms } : {});

/** The deterministic stages; `overrides` replaces any (the model's plan and cast, fakes in tests). */
export function defaultStageRunners(options: { art?: ArtService | null; overrides?: Partial<StageRunners> } = {}): StageRunners {
  const art = options.art ?? null;
  return {
    plan: async ({ project }) =>
      project.architect.rooms.length > 0
        ? { project, issues: [], summary: `kept the plan (${project.architect.rooms.length} rooms)` }
        : (() => {
            const plan = seedPlan(project);
            return { project: { ...project, architect: plan }, issues: [], summary: `planned ${plan.rooms.length} rooms and ${plan.links.length} links from the progression` };
          })(),
    layout: sync(layoutStage),
    geometry: sync(geometryStage),
    population: sync(populationStage),
    cast: sync((p) => difficultyStage(p)),
    screens: sync(screensStage),
    verify: sync((p) => verifyStage(p)),
    pacing: async ({ project }) => ({ project, issues: [], summary: "pacing: not implemented yet" }),
    art: async ({ project, log }) => {
      if (!art || !art.getState().available) return { project, issues: [], summary: "no art models configured; skipped" };
      const started = await art.start({ stage: "gameArt" });
      if (!started.ok) return { project, issues: [{ stage: "art", code: "art-refused", message: started.error.message }], summary: `art refused: ${started.error.message}` };
      log("drawing the game (game-art job)");
      await art.idle();
      const job = art.getState().jobs.at(-1);
      return { project, issues: [], summary: job ? `art ${job.outcome}, $${job.cost.toFixed(3)}` : "art done" };
    },
    ...options.overrides,
  };
}

type Result = { ok: true } | { ok: false; error: OperationError };

const LOG_LIMIT = 200;

export class ArchitectService {
  private running: (NonNullable<ArchitectState["running"]> & { abort: AbortController; done: Promise<void> }) | null = null;
  private last: ArchitectState["last"] = null;
  private log: ArchitectState["log"] = [];
  private listeners = new Set<(state: ArchitectState) => void>();

  private readonly store: ProjectStore;
  private readonly runners: StageRunners;

  constructor(store: ProjectStore, runners: StageRunners) {
    this.store = store;
    this.runners = runners;
  }

  getState(): ArchitectState {
    const r = this.running;
    return {
      running: r ? { stage: r.stage, stages: r.stages, startedAt: r.startedAt, ...(r.rooms ? { rooms: r.rooms } : {}) } : null,
      last: this.last,
      log: this.log,
    };
  }

  subscribe(listener: (state: ArchitectState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(request: unknown): Promise<Result> {
    const parsed = ArchitectRunRequest.safeParse(request ?? {});
    if (!parsed.success) return fail("invalid_request", "malformed Architect run request", toIssues(parsed.error));
    if (this.running) return fail("locked", "the Architect is already running");
    const project = this.store.getState().project;
    const from = parsed.data.from ?? ARCHITECT_STAGES.find((s) => project.architect.stages[s]?.status !== "done") ?? "plan";
    const to = parsed.data.to ?? "art";
    const stages = ARCHITECT_STAGES.slice(ARCHITECT_STAGES.indexOf(from), ARCHITECT_STAGES.indexOf(to) + 1);
    if (stages.length === 0) return fail("invalid_request", `"${from}" comes after "${to}"`);
    const unknown = (parsed.data.rooms ?? []).filter((id) => !project.architect.rooms.some((r) => r.id === id));
    if (unknown.length) return fail("not_found", `no plan room(s) ${unknown.join(", ")}`);
    const lock = await this.store.beginAiTurn();
    if (!lock.ok) return lock;

    const abort = new AbortController();
    const rooms = parsed.data.rooms;
    this.running = { stage: stages[0]!, stages, startedAt: new Date().toISOString(), ...(rooms ? { rooms } : {}), abort, done: Promise.resolve() };
    this.running.done = this.run(stages, rooms, abort.signal).finally(() => {
      this.store.endAiTurn();
      this.running = null;
      this.emit();
    });
    this.emit();
    return { ok: true };
  }

  /** Stop after the current stage. */
  cancel(): { ok: true } {
    this.running?.abort.abort();
    return { ok: true };
  }

  /** Resolves when no run is in progress (tests, scripts). */
  async idle(): Promise<void> {
    while (this.running) await this.running.done;
  }

  reset(): void {
    this.cancel();
    this.last = null;
    this.log = [];
    this.emit();
  }

  private async run(stages: ArchitectStage[], rooms: string[] | undefined, signal: AbortSignal): Promise<void> {
    let stage: ArchitectStage = stages[0]!;
    try {
      for (const [i, s] of stages.entries()) {
        stage = s;
        if (signal.aborted) return this.finish("cancelled", stage, []);
        this.running!.stage = stage;
        this.note(stage, "started");
        this.emit();
        const before = this.store.getState().project;
        const outcome = await this.runners[stage]({ project: before, ...(rooms ? { rooms } : {}), signal, log: (text) => this.note(stage, text) });
        const blocking = stage === "verify" && outcome.issues.length > 0;
        const status: StageStatus = { status: blocking ? "failed" : "done", summary: outcome.summary, at: new Date().toISOString() };
        const committed = await this.store.commitStage(stage, (current) => ({
          project: withStatus(current === before ? outcome.project : { ...current, architect: outcome.project.architect }, stage, status),
          summary: outcome.summary,
        }));
        if (!committed.ok) throw new Error(committed.error.message);
        this.note(stage, outcome.summary);
        if (blocking) return this.finish("failed", stage, outcome.issues, "verify found issues");
        const paused = this.store.getState().project.architect.pauseAfter.includes(stage) && i < stages.length - 1;
        if (paused) return this.finish("paused", stage, outcome.issues);
        if (i === stages.length - 1) return this.finish("finished", stage, outcome.issues);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.note(stage, `failed: ${message}`);
      await this.store.commitStage(stage, (current) => ({
        project: withStatus(current, stage, { status: "failed", summary: message.slice(0, 2000), at: new Date().toISOString() }),
        summary: `failed: ${message.slice(0, 200)}`,
      }));
      this.finish("failed", stage, [], message);
    }
  }

  private finish(outcome: NonNullable<ArchitectState["last"]>["outcome"], stage: ArchitectStage, issues: StageIssue[], error?: string): void {
    this.last = { outcome, stage, at: new Date().toISOString(), issues, ...(error ? { error } : {}) };
    this.note(stage, outcome === "finished" ? "run finished" : `run ${outcome}${error ? `: ${error}` : ""}`);
  }

  private note(stage: ArchitectStage, text: string): void {
    this.log = [...this.log, { at: new Date().toISOString(), stage, text }].slice(-LOG_LIMIT);
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

/** Record a stage's status, and mark later stages that were done as stale (they ran on what this stage replaced). */
export function withStatus(project: ProjectSpec, stage: ArchitectStage, status: StageStatus): ProjectSpec {
  const stages = { ...project.architect.stages, [stage]: status };
  if (status.status === "done") {
    for (const later of ARCHITECT_STAGES.slice(ARCHITECT_STAGES.indexOf(stage) + 1)) {
      const s = stages[later];
      if (s?.status === "done") stages[later] = { ...s, status: "stale" };
    }
  }
  return { ...project, architect: { ...project.architect, stages } };
}
