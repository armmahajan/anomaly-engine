import {
  ACTION_TYPES,
  CONDITION_TYPES,
  PROTOCOL_VERSION,
  type ChangeResult,
  type EntityState,
  type ProjectSpec,
  type ProjectState,
  type RuntimeMode,
  type RuntimeToStudio,
} from "@anomaly/core";
import * as api from "./api.ts";
import { RuntimeBridge } from "./runtimeBridge.ts";

export type RuntimeStatus = "booting" | "ready" | "unavailable";

export interface SessionState {
  /** Latest project known from the server (the server is the source of truth). */
  project: ProjectSpec;
  canUndo: boolean;
  serverConnected: boolean;
  /** Edit or play. Edits are locked as soon as play is requested and
   *  unlocked only once the runtime confirms it is back in edit mode. */
  mode: RuntimeMode;
  runtimeStatus: RuntimeStatus;
  /** Project revision the runtime has built its scene from. */
  loadedRevision: number | null;
  lastProblem: string | null;
}

export interface RuntimeSnapshot {
  mode: RuntimeMode;
  revision: number;
  entities: EntityState[];
}

const BOOT_TIMEOUT_MS = 30_000;

/**
 * One studio window: mirrors the server's project, relays edits to it,
 * and keeps the game runtime in sync. This is also the browser-side API
 * surface (`window.studio`).
 */
export class Session {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private bridge = new RuntimeBridge(
    (m) => this.handleRuntimeMessage(m),
    (p) => this.reportProblem(p),
  );
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last revision we asked the runtime to load (avoids duplicate loads). */
  private requestedRevision: number | null = null;
  private readonly clientId = `studio_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  constructor(initial: ProjectState) {
    this.state = {
      project: initial.project,
      canUndo: initial.canUndo,
      serverConnected: false,
      mode: "edit",
      runtimeStatus: "booting",
      loadedRevision: null,
      lastProblem: null,
    };
  }

  // --- store plumbing (for useSyncExternalStore) ---

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // --- server sync ---

  /** Follow project changes from the server, whoever made them. */
  connectServer(): () => void {
    return api.subscribeToProject(
      this.clientId,
      (event) => this.receiveProject(event),
      (connected) => {
        this.set({ serverConnected: connected });
        // The server drops our playtest lock when the stream drops; take it back.
        if (connected && this.state.mode === "play") void api.setPlaytest(true, this.clientId);
      },
      (problem) => this.reportProblem(problem),
    );
  }

  private receiveProject({ project, canUndo }: ProjectState): void {
    if (project.revision < this.state.project.revision) return; // out-of-order, already newer
    this.set({ project, canUndo });
    this.syncRuntime();
  }

  /** In edit mode, make sure the runtime shows the latest project. */
  private syncRuntime(): void {
    const { runtimeStatus, mode, project } = this.state;
    if (runtimeStatus !== "ready" || mode !== "edit" || this.requestedRevision === project.revision) return;
    if (this.bridge.send({ type: "load", project })) this.requestedRevision = project.revision;
  }

  // --- runtime lifecycle ---

  attachRuntime(frame: HTMLIFrameElement): () => void {
    this.set({ runtimeStatus: "booting", loadedRevision: null, mode: "edit" });
    clearTimeout(this.bootTimer);
    this.bootTimer = setTimeout(() => {
      if (this.state.runtimeStatus === "booting") {
        this.set({ runtimeStatus: "unavailable" });
        this.reportProblem("game runtime did not start (is it built? run `npm run build:game`)");
      }
    }, BOOT_TIMEOUT_MS);
    const detach = this.bridge.attach(frame);
    return () => {
      clearTimeout(this.bootTimer);
      detach();
    };
  }

  private handleRuntimeMessage(message: RuntimeToStudio): void {
    switch (message.type) {
      case "ready":
        clearTimeout(this.bootTimer);
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.set({ runtimeStatus: "unavailable" });
          this.reportProblem(
            `runtime speaks protocol v${message.protocolVersion}, studio expects v${PROTOCOL_VERSION}; rebuild the game`,
          );
          return;
        }
        this.checkPrimitives(message.primitives);
        // Also handles a runtime reboot: start over from edit mode.
        if (this.state.mode === "play") void api.setPlaytest(false, this.clientId);
        this.bridge.rejectAll("runtime restarted");
        this.requestedRevision = null;
        this.set({ runtimeStatus: "ready", mode: "edit", loadedRevision: null });
        this.syncRuntime();
        return;
      case "loaded":
        this.set({ loadedRevision: message.revision });
        return;
      case "modeChanged": {
        const leavingPlay = this.state.mode === "play" && message.mode === "edit";
        this.set({ mode: message.mode });
        if (leavingPlay) {
          void api.setPlaytest(false, this.clientId);
          this.syncRuntime();
        }
        return;
      }
      case "error":
        this.reportProblem(`runtime: ${message.message} (${message.code})`);
        return;
      case "state":
        return; // correlated by the bridge
    }
  }

  /** The runtime's primitives must match the schema's, or behaviors would misbehave silently. */
  private checkPrimitives(runtime: { actions: string[]; conditions: string[] }): void {
    const diff = (expected: readonly string[], actual: string[]) => {
      const missing = expected.filter((t) => !actual.includes(t));
      const extra = actual.filter((t) => !expected.includes(t));
      return [...missing.map((t) => `missing ${t}`), ...extra.map((t) => `unexpected ${t}`)];
    };
    const problems = [...diff(ACTION_TYPES, runtime.actions), ...diff(CONDITION_TYPES, runtime.conditions)];
    if (problems.length > 0) {
      this.reportProblem(`runtime primitives don't match the schema (${problems.join(", ")}); rebuild the game`);
    }
  }

  reportProblem(problem: string): void {
    console.warn(`[studio] ${problem}`);
    this.set({ lastProblem: problem });
  }

  dismissProblem(): void {
    this.set({ lastProblem: null });
  }

  // --- the editing + playtest API ---

  getProject = (): ProjectSpec => this.state.project;

  /** Apply any named core operation through the server. */
  applyOperation = async (name: string, input: unknown): Promise<ChangeResult> => {
    if (this.state.mode !== "edit") {
      return { ok: false, error: { code: "locked", message: "stop the playtest before editing", issues: [] } };
    }
    const result = await api.applyOperation({ name, input, baseRevision: this.state.project.revision, author: "user" });
    if (result.ok) this.receiveProject(result);
    return result;
  };

  /** Apply several operations atomically (one revision, one undo step); see core `applyBatch`. */
  applyBatch = async (operations: { name: string; input: unknown }[]): Promise<ChangeResult> => {
    if (this.state.mode !== "edit") {
      return { ok: false, error: { code: "locked", message: "stop the playtest before editing", issues: [] } };
    }
    const result = await api.applyBatch({ operations, baseRevision: this.state.project.revision, author: "user" });
    if (result.ok) this.receiveProject(result);
    return result;
  };

  /** Partially update a character type; see core `updateCharacter`. */
  updateCharacter = (input: unknown): Promise<ChangeResult> => this.applyOperation("updateCharacter", input);

  undo = async (): Promise<ChangeResult> => {
    if (this.state.mode !== "edit") {
      return { ok: false, error: { code: "locked", message: "stop the playtest before undoing", issues: [] } };
    }
    const result = await api.undo({ baseRevision: this.state.project.revision, author: "user" });
    if (result.ok) this.receiveProject(result);
    return result;
  };

  canPlay(): boolean {
    const s = this.state;
    return s.runtimeStatus === "ready" && s.mode === "edit" && s.loadedRevision === s.project.revision;
  }

  play = async (): Promise<boolean> => {
    if (!this.canPlay()) return false;
    this.set({ mode: "play" }); // lock local edits immediately
    const lock = await api.setPlaytest(true, this.clientId);
    // Abort if the lock failed or the project moved on while we asked.
    if (!lock.ok || lock.revision !== this.state.loadedRevision) {
      if (lock.ok) void api.setPlaytest(false, this.clientId);
      else this.reportProblem(`cannot start playtest: ${lock.error.message}`);
      this.set({ mode: "edit" });
      this.syncRuntime();
      return false;
    }
    if (!this.bridge.send({ type: "play" })) {
      void api.setPlaytest(false, this.clientId);
      this.set({ mode: "edit" });
      return false;
    }
    return true;
  };

  /** Stop the playtest; the runtime resets the scene to its spawn state. */
  stop = (): boolean => {
    if (this.state.runtimeStatus !== "ready") return false;
    return this.bridge.send({ type: "stop" });
  };

  getRuntimeState = async (): Promise<RuntimeSnapshot> => {
    const { mode, revision, entities } = await this.bridge.requestState();
    return { mode, revision, entities };
  };
}
