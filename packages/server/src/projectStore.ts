import { appendFile, copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyBatch,
  applyOperation,
  BatchRequest,
  fail,
  findUndoTarget,
  migrateProject,
  OperationRequest,
  PlaytestRequest,
  ResetRequest,
  fixtureSliceProject,
  summarizeChange,
  toIssues,
  undoLast,
  UndoRequest,
  validateProject,
  type Author,
  type Change,
  type ChangeResult,
  type HistoryEntry,
  type HistorySummary,
  type OperationError,
  type PlaytestResult,
  type ProjectEvent,
  type ProjectSpec,
  type ProjectState,
} from "@anomaly/core";

/**
 * Owns one project on disk:
 *   <dir>/project.json   current project (the commit point)
 *   <dir>/history.jsonl  append-only change log, one HistoryEntry per line
 *
 * All changes are serialized through one queue, validated with the core
 * operations, appended to history, then committed by atomically replacing
 * project.json. On load, history entries newer than project.json (a crash
 * between the two writes) are discarded.
 */
export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(event: ProjectEvent) => void>();
  private playtestOwner: string | null = null;
  private aiTurn = false;
  readonly dir: string;
  private readonly createInitial: () => ProjectSpec;
  private project: ProjectSpec;
  private history: HistoryEntry[];

  private constructor(dir: string, createInitial: () => ProjectSpec, project: ProjectSpec, history: HistoryEntry[]) {
    this.dir = dir;
    this.createInitial = createInitial;
    this.project = project;
    this.history = history;
  }

  static async open(dir: string, createInitial: () => ProjectSpec): Promise<ProjectStore> {
    await mkdir(dir, { recursive: true });
    const projectPath = join(dir, "project.json");

    let raw: string | null = null;
    try {
      raw = await readFile(projectPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    if (raw === null) {
      const initial = createInitial();
      const store = new ProjectStore(dir, createInitial, initial, []);
      await store.writeProject(initial);
      await writeFile(join(dir, "history.jsonl"), "");
      return store;
    }

    // Older files are upgraded in memory; the next commit writes the new format.
    const validated = validateProject(migrateProject(JSON.parse(raw)));
    if (!validated.ok) {
      const details = validated.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      throw new Error(`${projectPath} is not a valid project: ${details}`);
    }
    const history = await readHistory(join(dir, "history.jsonl"), validated.project.revision);
    return new ProjectStore(dir, createInitial, validated.project, history);
  }

  getState(): ProjectState {
    return { project: this.project, canUndo: findUndoTarget(this.history) !== null };
  }

  undoneRevisions(): number[] {
    return this.history.flatMap((e) => (e.change.kind === "undo" ? [e.change.undoes] : []));
  }

  getHistory(): HistorySummary[] {
    return this.history.map((e) => ({
      revision: e.revision,
      at: e.at,
      author: e.author,
      summary: summarizeChange(e.change),
    }));
  }

  subscribe(listener: (event: ProjectEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a named core operation. `request` is untrusted. */
  applyOperation(request: unknown): Promise<ChangeResult> {
    return this.exclusive(async () => {
      const parsed = OperationRequest.safeParse(request);
      if (!parsed.success) return fail("invalid_request", "malformed operation request", toIssues(parsed.error));
      const { name, input, baseRevision, author } = parsed.data;

      const blocked = this.checkEditable(baseRevision, author);
      if (blocked) return blocked;

      const result = applyOperation(this.project, name, input);
      if (!result.ok) return result;
      return this.commit(result.project, author, { kind: "operation", name, input });
    });
  }

  /** Apply several operations atomically: one revision, one undo step. */
  applyBatch(request: unknown): Promise<ChangeResult> {
    return this.exclusive(async () => {
      const parsed = BatchRequest.safeParse(request);
      if (!parsed.success) return fail("invalid_request", "malformed batch request", toIssues(parsed.error));
      const { operations, baseRevision, author } = parsed.data;

      const blocked = this.checkEditable(baseRevision, author);
      if (blocked) return blocked;

      const result = applyBatch(this.project, operations);
      if (!result.ok) return result;
      // applyBatch validated the shape; record exactly what was applied.
      const calls = (operations as { name: string; input: unknown }[]).map(({ name, input }) => ({ name, input }));
      return this.commit(result.project, author, { kind: "batch", operations: calls });
    });
  }

  undo(request: unknown): Promise<ChangeResult> {
    return this.exclusive(async () => {
      const parsed = UndoRequest.safeParse(request);
      if (!parsed.success) return fail("invalid_request", "malformed undo request", toIssues(parsed.error));
      const { baseRevision, author } = parsed.data;

      const blocked = this.checkEditable(baseRevision, author);
      if (blocked) return blocked;

      const result = undoLast(this.project, this.history);
      if (!result.ok) return result;
      return this.commit(result.project, author, { kind: "undo", undoes: result.undoes });
    });
  }

  /**
   * Commit a whole-project change made by a job step (an Architect stage) as one
   * revision by the AI: `change` gets the project as it is now and returns the next
   * one (validated here). One undo step restores the project from before it.
   */
  commitStage(stage: string, change: (project: ProjectSpec) => { project: ProjectSpec; summary: string }): Promise<ChangeResult> {
    return this.exclusive(async () => {
      const blocked = this.checkEditable(this.project.revision, "ai");
      if (blocked) return blocked;
      let next: { project: ProjectSpec; summary: string };
      try {
        next = change(this.project);
      } catch (e) {
        return fail("invalid_result", `architect ${stage} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const validated = validateProject({ ...next.project, revision: this.project.revision + 1 });
      if (!validated.ok) return fail("invalid_result", `architect ${stage} would leave the project invalid: ${validated.issues.map((i) => i.message).slice(0, 5).join("; ")}`, validated.issues);
      return this.commit(validated.project, "ai", { kind: "stage", stage, summary: next.summary });
    });
  }

  /** Take or release the playtest lock. While held, all edits are rejected. */
  setPlaytest(request: unknown): Promise<PlaytestResult> {
    return this.exclusive(async () => {
      const parsed = PlaytestRequest.safeParse(request);
      if (!parsed.success) return fail("invalid_request", "malformed playtest request", toIssues(parsed.error));
      const { active, clientId } = parsed.data;
      if (active) {
        if (this.aiTurn) return fail("locked", "the AI is editing the project; wait for it or cancel");
        if (this.playtestOwner !== null && this.playtestOwner !== clientId) {
          return fail("locked", "another studio window is already playtesting");
        }
        this.playtestOwner = clientId;
      } else if (this.playtestOwner === clientId) {
        this.playtestOwner = null;
      }
      return { ok: true, revision: this.project.revision };
    });
  }

  /** Lock the project for an AI turn: only `author: "ai"` edits pass until `endAiTurn`. */
  beginAiTurn(): Promise<{ ok: true } | { ok: false; error: OperationError }> {
    return this.exclusive(async () => {
      if (this.playtestOwner !== null) return fail("locked", "a playtest is running; stop it before chatting");
      if (this.aiTurn) return fail("locked", "the AI is already working on a message");
      this.aiTurn = true;
      return { ok: true as const };
    });
  }

  endAiTurn(): void {
    this.aiTurn = false;
  }

  /** Back up the project folder to backups/<time>/, then replace the project with a fresh one. */
  reset(request: unknown): Promise<ChangeResult> {
    return this.exclusive(async () => {
      const parsed = ResetRequest.safeParse(request);
      if (!parsed.success) return fail("invalid_request", "malformed reset request", toIssues(parsed.error));
      const blocked = this.checkEditable(parsed.data.baseRevision, "user");
      if (blocked) return blocked;

      const backup = join(this.dir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      await mkdir(backup, { recursive: true });
      for (const entry of await readdir(this.dir, { withFileTypes: true })) {
        if (entry.isFile()) await copyFile(join(this.dir, entry.name), join(backup, entry.name));
      }

      const fresh = parsed.data.from === "example" ? fixtureSliceProject() : this.createInitial();
      const next = { ...fresh, revision: this.project.revision + 1 };
      await writeFile(join(this.dir, "history.jsonl"), "");
      await this.writeProject(next);
      this.project = next;
      this.history = [];
      this.emit({ revision: next.revision, author: "user", summary: "reset project" });
      return { ok: true, ...this.getState() };
    });
  }

  /** Called when a client disconnects, so a closed tab can't hold the lock forever. */
  releasePlaytest(clientId: string): void {
    if (this.playtestOwner === clientId) this.playtestOwner = null;
  }

  /** Wait for queued changes to finish (used by tests). */
  async idle(): Promise<void> {
    await this.queue.catch(() => {});
  }

  // --- internals ---

  private checkEditable(baseRevision: number, author: Author): { ok: false; error: OperationError } | null {
    if (this.playtestOwner !== null) return fail("locked", "a playtest is running; stop it before editing");
    if (this.aiTurn && author !== "ai") return fail("locked", "the AI is editing the project; wait for it or cancel");
    if (baseRevision !== this.project.revision) {
      return fail(
        "stale_revision",
        `edit was based on revision ${baseRevision} but the project is at revision ${this.project.revision}`,
      );
    }
    return null;
  }

  private async commit(next: ProjectSpec, author: Author, change: Change): Promise<ChangeResult> {
    const entry: HistoryEntry = {
      revision: next.revision,
      at: new Date().toISOString(),
      author,
      change,
      before: this.project,
    };
    await appendFile(join(this.dir, "history.jsonl"), JSON.stringify(entry) + "\n");
    await this.writeProject(next);
    this.project = next;
    this.history.push(entry);

    this.emit({ revision: next.revision, author, summary: summarizeChange(change) });
    return { ok: true, ...this.getState() };
  }

  private emit(cause: ProjectEvent["cause"]): void {
    const event: ProjectEvent = { type: "project", ...this.getState(), cause };
    for (const listener of this.listeners) listener(event);
  }

  private async writeProject(project: ProjectSpec): Promise<void> {
    const path = join(this.dir, "project.json");
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(project, null, 2) + "\n");
    await rename(tmp, path);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }
}

async function readHistory(path: string, committedRevision: number): Promise<HistoryEntry[]> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const entries: HistoryEntry[] = [];
  for (const [i, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      entry.before = migrateProject(entry.before) as ProjectSpec;
      // Entries past the committed revision were never committed (crash mid-write).
      if (entry.revision <= committedRevision) entries.push(entry);
    } catch {
      console.warn(`[project-store] skipping unreadable history line ${i + 1} in ${path}`);
    }
  }
  return entries;
}
