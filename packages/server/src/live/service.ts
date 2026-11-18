import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  applyPreview,
  buildPreview,
  canPreview,
  castFromPages,
  fail,
  gameCharacterPages,
  LiveSettingsRequest,
  markStagesStale,
  previewOwnsPlan,
  progressionFingerprint,
  toIssues,
  type LiveSettings,
  type LiveState,
  type OperationError,
  type PreviewOutcome,
  type ProjectSpec,
} from "@anomaly/core";
import { buildAgent, type TurnRunner } from "@anomaly/agent";
import type { ProjectStore } from "../projectStore.ts";
import type { ArtService } from "../art/service.ts";
import { privateTurn } from "../agentTurn.ts";

/**
 * The studio fills in as the creator designs, in the background:
 *
 * - Live cast: a wiki page that describes a game character (core gameCharacterPages:
 *   its in_game field, its link, the progression's lists, its role) becomes one: an
 *   enemy page gets a new enemy, linked to the page; the player page is linked to the
 *   player. New enemies get a behavior from their page (a build-assistant turn on a
 *   private copy, written at first-region strength), then every character a new page
 *   describes gets its art (an auto art job, skipped if it is drawn by then). Each page
 *   is handled once: undoing or deleting what it made doesn't bring it back.
 * - Live rooms: when the progression changes (regions, a start), the Architect's code
 *   stages build rooms for it with no model and no art (core buildPreview, off the
 *   main thread). Once the creator or the Architect has taken over the plan (core
 *   previewOwnsPlan), a progression change marks the Architect's done stages stale
 *   instead, for the creator to rebuild when they choose.
 *
 * Both run a moment after the project settles (debounced; never while an AI turn or
 * the Architect holds the project) and save through ProjectStore.commitBackground:
 * each result is its own AI revision on the project as it is then, waiting while a
 * playtest runs. State persists in <dir>/live.json (settings, the pages handled and
 * the progression last followed); on first open, what is already there counts as
 * handled, so turning this on never redoes an existing project.
 */

export interface LiveServiceOptions {
  /** Build-assistant turns that write new characters' behaviors (null: placeholders stay). */
  runner: TurnRunner | null;
  art: ArtService | null;
  /** Settings for a project that has none saved yet. */
  defaults: LiveSettings;
  /** Quiet time after the last change before working (ms). */
  debounceMs?: number;
  /** Build the rooms in a worker thread (default true; falls back to this thread). */
  worker?: boolean;
}

interface Persisted {
  settings: LiveSettings;
  /** Wiki pages already turned into game characters (or seen before this was on). */
  pages: string[];
  /** Fingerprint of the progression the rooms last followed. */
  progression: string | null;
}

type Result = { ok: true; live: LiveState } | { ok: false; error: OperationError };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class LiveService {
  private readonly store: ProjectStore;
  private readonly options: LiveServiceOptions;
  private readonly path: string;
  private persisted: Persisted;
  private state: Omit<LiveState, "settings" | "waiting">;
  private listeners = new Set<(state: LiveState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private castJob: Promise<void> | null = null;
  private roomsJob: Promise<void> | null = null;
  private controller = new AbortController();
  private closed = false;
  private readonly unsubscribe: (() => void)[];

  private constructor(store: ProjectStore, options: LiveServiceOptions, persisted: Persisted) {
    this.store = store;
    this.options = options;
    this.path = join(store.dir, "live.json");
    this.persisted = persisted;
    this.state = { cast: { working: [], message: "", error: null }, rooms: { status: "idle", message: "", error: null } };
    this.unsubscribe = [store.subscribe(() => this.schedule()), store.subscribeLocks(() => (this.emit(), this.schedule()))];
  }

  static async open(store: ProjectStore, options: LiveServiceOptions): Promise<LiveService> {
    let saved: Partial<Persisted> | null = null;
    try {
      saved = JSON.parse(await readFile(join(store.dir, "live.json"), "utf8")) as Partial<Persisted>;
    } catch {
      saved = null;
    }
    const live = new LiveService(store, options, saved ? { settings: { ...options.defaults, ...saved.settings }, pages: saved.pages ?? [], progression: saved.progression ?? null } : baseline(store.getState().project, options.defaults));
    if (!saved) await live.save();
    live.schedule();
    return live;
  }

  getState(): LiveState {
    return { settings: this.persisted.settings, ...this.state, waiting: this.store.waitingReason() };
  }

  subscribe(listener: (state: LiveState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Turn the live cast and/or the live rooms on or off. */
  async configure(request: unknown): Promise<Result> {
    const parsed = LiveSettingsRequest.safeParse(request);
    if (!parsed.success) return fail("invalid_request", "malformed live settings", toIssues(parsed.error));
    this.persisted.settings = { ...this.persisted.settings, ...parsed.data };
    await this.save();
    this.emit();
    this.schedule();
    return { ok: true, live: this.getState() };
  }

  /** After a project reset: stop what runs, and take the new project as it is. */
  async reset(): Promise<void> {
    this.controller.abort();
    this.controller = new AbortController();
    await Promise.all([this.castJob, this.roomsJob]);
    this.persisted = { ...baseline(this.store.getState().project, this.persisted.settings), settings: this.persisted.settings };
    this.state = { cast: { working: [], message: "", error: null }, rooms: { status: "idle", message: "", error: null } };
    await this.save();
    this.emit();
  }

  /** Resolves when nothing is scheduled or running (tests, scripts). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.timer) await sleep(this.debounce + 5);
      else if (this.castJob || this.roomsJob) await Promise.all([this.castJob, this.roomsJob]);
      else return;
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller.abort();
    for (const off of this.unsubscribe) off();
  }

  private get debounce(): number {
    return this.options.debounceMs ?? 1500;
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, this.debounce);
    this.timer.unref?.();
  }

  private tick(): void {
    // Nothing new can appear under an AI turn or an Architect run; the lock's release ticks again.
    if (this.store.isAiLocked()) return;
    const project = this.store.getState().project;
    if (this.persisted.settings.cast && !this.castJob) this.startCast(project);
    if (this.persisted.settings.rooms && !this.roomsJob) this.startRooms(project);
  }

  // --- live cast ---

  private startCast(project: ProjectSpec): void {
    const handled = new Set(this.persisted.pages);
    const fresh = gameCharacterPages(project).filter(({ page }) => !handled.has(page.id)).map(({ page }) => page.id);
    if (fresh.length === 0) return;
    this.persisted.pages = [...this.persisted.pages, ...fresh];
    const signal = this.controller.signal;
    this.castJob = this.save()
      .then(() => this.runCast(fresh, signal))
      .catch((e: unknown) => {
        this.state.cast = { working: [], message: "", error: e instanceof Error ? e.message : String(e) };
      })
      .finally(() => {
        this.castJob = null;
        this.emit();
        this.schedule();
      });
  }

  private async runCast(pageIds: string[], signal: AbortSignal): Promise<void> {
    const epoch = this.store.epoch();
    const onWait = () => this.emit();
    const say = (message: string, working: string[] = this.state.cast.working) => {
      this.state.cast = { ...this.state.cast, working, message };
      this.emit();
    };
    say(`adding ${pageIds.length} character page(s) to the cast`, pageIds);
    let made: ReturnType<typeof castFromPages> = { operations: [], created: [], draw: [] };
    const saved = await this.store.commitBackground(
      (project) => {
        made = castFromPages(project, pageIds);
        return { operations: made.operations };
      },
      { signal, epoch, onWait },
    );
    if (!saved.ok) throw new Error(`could not add the characters: ${saved.error.message}`);
    const { created, draw } = made;
    // Linked characters (the player) can be drawn right away; new ones once they behave (their clips follow the behavior).
    this.draw(draw.filter((id) => !created.includes(id)));
    let error: string | null = null;
    if (created.length > 0 && this.options.runner) {
      say(`writing behaviors for ${created.join(", ")}`, created);
      try {
        const turn = await privateTurn(this.options.runner, buildAgent, this.store.getState().project, behaviorMessage(this.store.getState().project, created), {
          signal,
          log: () => {},
        });
        if (turn.operations.length > 0) {
          const behaved = await this.store.commitBackground(() => ({ operations: turn.operations }), { signal, epoch, onWait });
          if (!behaved.ok) error = `the behaviors for ${created.join(", ")} no longer apply: ${behaved.error.message}`;
        }
      } catch (e) {
        if (signal.aborted) return;
        error = `writing behaviors failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (signal.aborted) return;
    this.draw(created);
    this.state.cast = { working: [], message: `added ${draw.length ? draw.join(", ") : "nothing new"} to the cast`, error };
  }

  /** Queue art for characters that still exist, unless they're drawn by the time their turn comes. */
  private draw(ids: string[]): void {
    const art = this.options.art;
    if (!art || ids.length === 0 || !art.getState().available) return;
    const project = this.store.getState().project;
    const existing = ids.filter((id) => project.characters.some((c) => c.id === id));
    art.enqueue(
      existing.map((characterId) => ({ stage: "auto", characterId })),
      { onlyIfUndrawn: true },
    );
  }

  // --- live rooms ---

  private startRooms(project: ProjectSpec): void {
    const fp = progressionFingerprint(project);
    if (fp === this.persisted.progression) return;
    const signal = this.controller.signal;
    this.roomsJob = (canPreview(project) ? (previewOwnsPlan(project) ? this.buildRooms(project, fp, signal) : this.markStale(fp, signal)) : this.follow(fp))
      .catch((e: unknown) => {
        this.state.rooms = { status: "idle", message: "", error: e instanceof Error ? e.message : String(e) };
      })
      .finally(() => {
        this.roomsJob = null;
        this.emit();
        this.schedule();
      });
  }

  private async follow(fp: string): Promise<void> {
    this.persisted.progression = fp;
    await this.save();
  }

  private async buildRooms(snapshot: ProjectSpec, fp: string, signal: AbortSignal): Promise<void> {
    const epoch = this.store.epoch();
    this.state.rooms = { status: "building", message: `building rooms for ${snapshot.progression.regions.length} region(s)…`, error: null };
    this.emit();
    const outcome = await this.preview(snapshot);
    if (signal.aborted) return;
    this.state.rooms = { ...this.state.rooms, status: "saving" };
    this.emit();
    const saved = await this.store.commitBackground(
      (current) => {
        const next = applyPreview(current, outcome.project);
        return next && { project: next, stage: "preview", summary: `${outcome.summary} (no model, no art)` };
      },
      { signal, epoch, onWait: () => this.emit() },
    );
    if (!saved.ok) throw new Error(`the rooms could not be saved: ${saved.error.message}`);
    if (saved.revision === null) {
      // The progression moved on (or someone took over) meanwhile: the next tick follows.
      this.state.rooms = { status: "idle", message: "", error: null };
      return;
    }
    this.persisted.progression = fp;
    await this.save();
    const problems = outcome.issues.length ? `; ${outcome.issues.length} issue(s): ${outcome.issues.slice(0, 3).map((i) => i.message).join("; ")}` : "";
    this.state.rooms = { status: "idle", message: `${outcome.summary} (a preview: no model, no art)`, error: problems ? problems.slice(2) : null };
  }

  private async markStale(fp: string, signal: AbortSignal): Promise<void> {
    const saved = await this.store.commitBackground(
      (current) => {
        if (previewOwnsPlan(current)) return null;
        const next = markStagesStale(current);
        return next && { project: next, stage: "progression", summary: "the progression changed since the last build: stages marked stale" };
      },
      { signal, epoch: this.store.epoch(), onWait: () => this.emit() },
    );
    if (!saved.ok) throw new Error(saved.error.message);
    this.persisted.progression = fp;
    await this.save();
    this.state.rooms = {
      status: "idle",
      message: saved.revision !== null ? "the progression changed: the Architect's stages are marked stale (rebuild from the Architect tab)" : "the progression changed; the plan is yours, so the rooms aren't rebuilt automatically",
      error: null,
    };
  }

  /** buildPreview in a worker thread (geometry can take seconds), or here if a worker can't start. */
  private preview(project: ProjectSpec): Promise<PreviewOutcome> {
    if (this.options.worker === false) return Promise.resolve(buildPreview(project));
    return new Promise((resolve) => {
      let settled = false;
      const inline = (why: unknown) => {
        if (settled) return;
        settled = true;
        console.warn(`[live] building the rooms on the main thread (${why instanceof Error ? why.message : String(why)})`);
        resolve(buildPreview(project));
      };
      let worker: Worker;
      try {
        worker = new Worker(new URL("./previewWorker.ts", import.meta.url), { workerData: project });
      } catch (e) {
        return inline(e);
      }
      worker.once("message", (outcome: PreviewOutcome) => {
        settled = true;
        resolve(outcome);
        void worker.terminate();
      });
      worker.once("error", inline);
      worker.once("exit", (code) => inline(`worker exited with ${code}`));
    });
  }

  private async save(): Promise<void> {
    await writeFile(this.path, JSON.stringify(this.persisted, null, 2) + "\n");
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

/** What counts as already done when live work starts on a project: its pages, and its progression unless the rooms can be built now. */
function baseline(project: ProjectSpec, settings: LiveSettings): Persisted {
  const fresh = project.architect.rooms.length === 0 && canPreview(project) && previewOwnsPlan(project);
  return { settings, pages: gameCharacterPages(project).map(({ page }) => page.id), progression: fresh ? null : progressionFingerprint(project) };
}

/** The build assistant's brief for the characters the live cast just made. */
export function behaviorMessage(project: ProjectSpec, ids: string[]): string {
  const list = ids
    .map((id) => {
      const page = project.wiki.pages.find((p) => p.characterId === id);
      return `${id}${page ? ` (wiki page ${page.id})` : ""}`;
    })
    .join(", ");
  return `Give these new enemy characters their behavior: ${list}. They were just made from their wiki pages as placeholders (a box that patrols). Read each one's wiki page (and the pages of the regions it is met in) and give it a fitting name, size, color, movement, stats and a behavior built from the primitives, true to its page; one the progression or its page makes a boss or a guardian gets several attacks with clear windups and phases. Write each at first-region strength: stats rise automatically in deeper regions. Change only these characters: don't create or delete characters, don't add spawns or rooms, don't queue art.`;
}
