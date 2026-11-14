import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  private readonly dir: string;
  private project: ProjectSpec;
  private history: HistoryEntry[];

  private constructor(dir: string, project: ProjectSpec, history: HistoryEntry[]) {
    this.dir = dir;
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
      const store = new ProjectStore(dir, initial, []);
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
    return new ProjectStore(dir, validated.project, history);
  }

  getState(): ProjectState {
    return { project: this.project, canUndo: findUndoTarget(this.history) !== null };
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

      const blocked = this.checkEditable(baseRevision);
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

      const blocked = this.checkEditable(baseRevision);
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

      const blocked = this.checkEditable(baseRevision);
      if (blocked) return blocked;

      const result = undoLast(this.project, this.history);
      if (!result.ok) return result;
      return this.commit(result.project, author, { kind: "undo", undoes: result.undoes });
    });
  }

  /** Take or release the playtest lock. While held, all edits are rejected. */
  setPlaytest(request: unknown): Promise<PlaytestResult> {
    return this.exclusive(async () => {
      const parsed = PlaytestRequest.safeParse(request);
      if (!parsed.success) return fail("invalid_request", "malformed playtest request", toIssues(parsed.error));
      const { active, clientId } = parsed.data;
      if (active) {
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

  /** Called when a client disconnects, so a closed tab can't hold the lock forever. */
  releasePlaytest(clientId: string): void {
    if (this.playtestOwner === clientId) this.playtestOwner = null;
  }

  /** Wait for queued changes to finish (used by tests). */
  async idle(): Promise<void> {
    await this.queue.catch(() => {});
  }

  // --- internals ---

  private checkEditable(baseRevision: number): { ok: false; error: OperationError } | null {
    if (this.playtestOwner !== null) return fail("locked", "a playtest is running; stop it before editing");
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

    const state = this.getState();
    const event: ProjectEvent = {
      type: "project",
      ...state,
      cause: { revision: next.revision, author, summary: summarizeChange(change) },
    };
    for (const listener of this.listeners) listener(event);
    return { ok: true, ...state };
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
