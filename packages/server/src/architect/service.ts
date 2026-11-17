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
  pacingStage,
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
  /** Problems a later stage reported that this stage should fix (the plan stage, on a repair). */
  feedback?: string[];
}

export interface StageRunResult {
  project: ProjectSpec;
  issues: StageIssue[];
  summary: string;
  /** The run can't go on (default: verify with issues). */
  blocking?: boolean;
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
    // Difficulty scales enemies by the regions they're placed in, so it follows population.
    population: sync((p, options) => {
      const placed = populationStage(p, options);
      const scaled = difficultyStage(placed.project);
      return { project: scaled.project, issues: [...placed.issues, ...scaled.issues], summary: `${placed.summary}; ${scaled.summary}` };
    }),
    cast: async ({ project }) => ({ project, issues: [], summary: "no model: the plan's enemies must exist already" }),
    screens: sync(screensStage),
    verify: sync((p) => verifyStage(p)),
    pacing: sync((p) => pacingStage(p)),
    art: async ({ project, log, signal }) => {
      if (!art || !art.getState().available) return { project, issues: [], summary: "no art models configured; skipped" };
      // The run holds the AI lock; the art job works inside it. Stop cancels the job too.
      const started = await art.start({ stage: "gameArt" }, { underLock: true });
      if (!started.ok) return { project, issues: [{ stage: "art", code: "art-refused", message: started.error.message }], summary: `art refused: ${started.error.message}` };
      log("drawing the game (game-art job)");
      const stop = () => art.cancel();
      signal.addEventListener("abort", stop);
      await art.idle();
      signal.removeEventListener("abort", stop);
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
  /** How many times one run may send failures back to an earlier stage. */
  private readonly maxRepairs: number;
  /** Send a game off its play-time target back to the plan stage (worth it when the model plans). */
  private readonly repairPacing: boolean;

  constructor(store: ProjectStore, runners: StageRunners, options: { maxRepairs?: number; repairPacing?: boolean } = {}) {
    this.store = store;
    this.runners = runners;
    this.maxRepairs = options.maxRepairs ?? 3;
    this.repairPacing = options.repairPacing ?? false;
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
    let queue = stages;
    let only = rooms;
    let feedback: string[] | undefined;
    let repairs = 0;
    const end = stages.at(-1)!;
    try {
      for (let i = 0; i < queue.length; i++) {
        stage = queue[i]!;
        if (signal.aborted) return this.finish("cancelled", stage, []);
        this.running!.stage = stage;
        this.running!.stages = queue;
        this.note(stage, "started");
        this.emit();
        const before = this.store.getState().project;
        const outcome = await this.runners[stage]({
          project: before,
          ...(only ? { rooms: only } : {}),
          ...(stage === "plan" && feedback ? { feedback } : {}),
          signal,
          log: (text) => this.note(stage, text),
        });
        const blocking = outcome.blocking ?? (stage === "verify" && outcome.issues.length > 0);
        // Repairs: a failed verify goes back to the stage that caused it; a game off its play-time target goes back to the plan.
        const repair = blocking ? repairFor(before, outcome.issues) : stage === "pacing" && this.repairPacing && outcome.issues.length > 0 ? { from: "plan" as const, reseed: [], rooms: undefined } : null;
        const canRepair = repair !== null && repairs < this.maxRepairs;
        const status: StageStatus = { status: blocking ? "failed" : "done", summary: outcome.summary, at: new Date().toISOString() };
        const committed = await this.store.commitStage(stage, (current) => {
          let next = withStatus(current === before ? outcome.project : { ...current, architect: outcome.project.architect }, stage, status);
          if (canRepair && repair!.reseed.length) next = reseed(next, repair!.reseed);
          return { project: next, summary: outcome.summary };
        });
        if (!committed.ok) throw new Error(committed.error.message);
        this.note(stage, outcome.summary);
        if (canRepair) {
          repairs++;
          queue = ARCHITECT_STAGES.slice(ARCHITECT_STAGES.indexOf(repair!.from), ARCHITECT_STAGES.indexOf(end) + 1);
          only = repair!.rooms;
          feedback = outcome.issues.map((x) => x.message);
          this.note(stage, `repair ${repairs}/${this.maxRepairs}: back to ${repair!.from}${only ? ` for ${only.join(", ")}` : ""}${repair!.reseed.length ? ` (new seeds for ${repair!.reseed.length} room(s))` : ""}`);
          i = -1;
          continue;
        }
        if (blocking) return this.finish("failed", stage, outcome.issues, `${stage} found issues`);
        if (signal.aborted) return this.finish("cancelled", stage, outcome.issues);
        const paused = this.store.getState().project.architect.pauseAfter.includes(stage) && i < queue.length - 1;
        if (paused) return this.finish("paused", stage, outcome.issues);
        if (i === queue.length - 1) return this.finish("finished", stage, outcome.issues);
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

/**
 * Where a failed verify goes back to: the earliest stage its issues name. Geometry
 * issues tied to rooms rebuild just those rooms with new seeds (the rooms of a
 * leaking gate's link included); anything else reruns its stage for every room.
 */
export function repairFor(project: ProjectSpec, issues: StageIssue[]): { from: ArchitectStage; rooms: string[] | undefined; reseed: string[] } | null {
  const fixable = issues.filter((i) => i.stage !== "verify" && i.stage !== "art");
  if (fixable.length === 0) return null;
  const from = ARCHITECT_STAGES.find((s) => fixable.some((i) => i.stage === s))!;
  const roomOf = (i: StageIssue) => i.roomId ?? (i.linkId ? project.architect.links.find((l) => l.id === i.linkId)?.a.room : undefined);
  const atFrom = fixable.filter((i) => i.stage === from);
  // A new plan can change any room: rebuild them all.
  const rooms = from !== "plan" && atFrom.every((i) => roomOf(i)) ? [...new Set(atFrom.map((i) => roomOf(i)!))].filter((id) => project.architect.rooms.some((r) => r.id === id && !r.pinned)) : undefined;
  const reseed = from === "geometry" ? (rooms ?? project.architect.rooms.filter((r) => !r.pinned).map((r) => r.id)) : [];
  return { from, rooms: rooms?.length ? rooms : undefined, reseed };
}

/** New geometry seeds for these plan rooms (deterministic: the next seed). */
export function reseed(project: ProjectSpec, rooms: string[]): ProjectSpec {
  return {
    ...project,
    architect: { ...project.architect, rooms: project.architect.rooms.map((r) => (rooms.includes(r.id) ? { ...r, seed: (r.seed + 7919) % 1_000_000 } : r)) },
  };
}
