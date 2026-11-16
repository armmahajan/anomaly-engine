import {
  ACTION_TYPES,
  CONDITION_TYPES,
  MAX_SEED,
  PROTOCOL_VERSION,
  type AgentId,
  type ArtJobRequest,
  type Stage,
  type ArtState,
  type ChangeResult,
  type ChatState,
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
  /** Each agent's conversation: build assistant (arena) and director (wiki and progression). */
  chats: Record<AgentId, ChatState>;
  /** Seed of the current or most recent playtest. */
  seed: number | null;
  art: ArtState;
}

export interface RuntimeSnapshot {
  mode: RuntimeMode;
  revision: number;
  seed: number | null;
  deaths: number;
  stage: Stage["mode"];
  entities: EntityState[];
}

const BOOT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

const idleChat: ChatState = { entries: [], running: null, undone: [] };

const locked = (message: string): ChangeResult => ({ ok: false, error: { code: "locked", message, issues: [] } });

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
  /** Pending release of the playtest lock after leaving play. */
  private releasing: Promise<unknown> = Promise.resolve();
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
      chats: { build: idleChat, narrative: idleChat },
      seed: null,
      art: { available: false, models: { image: "", vision: "" }, budget: 0, running: null, jobs: [], totalCost: 0 },
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

  /** Follow project and chat changes from the server, whoever made them. */
  connectServer(): () => void {
    return api.subscribeToServer(
      this.clientId,
      (event) => {
        if (event.type === "project") this.receiveProject(event);
        else if (event.type === "chat") this.set({ chats: { ...this.state.chats, [event.agent]: event.chat } });
        else this.set({ art: event.art });
      },
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
    // The runtime never needs the design documents.
    const runtimeProject = { ...project, wiki: { pages: [] }, progression: { abilities: [], regions: [], connections: [], beats: [] } };
    if (this.bridge.send({ type: "load", project: runtimeProject })) this.requestedRevision = project.revision;
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
        this.bridge.send({ type: "stage", stage: this.stage });
        return;
      case "loaded":
        this.set({ loadedRevision: message.revision });
        return;
      case "modeChanged": {
        const leavingPlay = this.state.mode === "play" && message.mode === "edit";
        this.set({ mode: message.mode });
        if (leavingPlay) {
          this.releasing = api.setPlaytest(false, this.clientId);
          this.syncRuntime();
        }
        return;
      }
      case "error":
        this.reportProblem(`runtime: ${message.message} (${message.code})`);
        return;
      case "state":
        return; // correlated by the bridge
      case "rendered":
        return; // the studio never asks the runtime to render
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
  /** True while an AI turn or art job runs: the project is locked to everyone but the AI. */
  aiBusy = (): boolean =>
    Object.values(this.state.chats).some((c) => c.running !== null) || this.state.art.running !== null;

  private editBlocked(): ChangeResult | null {
    if (this.state.mode !== "edit") return locked("stop the playtest before editing");
    if (this.aiBusy()) return locked("the AI is editing the project; wait for it or cancel");
    return null;
  }

  applyOperation = async (name: string, input: unknown): Promise<ChangeResult> => {
    const blocked = this.editBlocked();
    if (blocked) return blocked;
    const result = await api.applyOperation({ name, input, baseRevision: this.state.project.revision, author: "user" });
    if (result.ok) this.receiveProject(result);
    return result;
  };

  /** Apply several operations atomically (one revision, one undo step); see core `applyBatch`. */
  applyBatch = async (operations: { name: string; input: unknown }[]): Promise<ChangeResult> => {
    const blocked = this.editBlocked();
    if (blocked) return blocked;
    const result = await api.applyBatch({ operations, baseRevision: this.state.project.revision, author: "user" });
    if (result.ok) this.receiveProject(result);
    return result;
  };

  /** Partially update a character type; see core `updateCharacter`. */
  updateCharacter = (input: unknown): Promise<ChangeResult> => this.applyOperation("updateCharacter", input);

  undo = async (): Promise<ChangeResult> => {
    const blocked = this.editBlocked();
    if (blocked) return blocked;
    const result = await api.undo({ baseRevision: this.state.project.revision, author: "user" });
    if (result.ok) this.receiveProject(result);
    return result;
  };

  canPlay(): boolean {
    const s = this.state;
    return s.runtimeStatus === "ready" && s.mode === "edit" && !this.aiBusy() && s.loadedRevision === s.project.revision;
  }

  /** Back up the project on the server and start over from the starter project. */
  resetProject = async (): Promise<ChangeResult> => {
    const blocked = this.editBlocked();
    if (blocked) return blocked;
    const result = await api.resetProject(this.state.project.revision);
    if (result.ok) this.receiveProject(result);
    return result;
  };

  /** Send a chat message to one of the agents. A running playtest is stopped first. */
  sendChat = async (agent: AgentId, message: string): Promise<boolean> => {
    if (this.state.mode === "play") {
      this.stop();
      if (!(await this.waitFor(() => this.state.mode === "edit", STOP_TIMEOUT_MS))) {
        this.reportProblem("could not stop the playtest to send the message");
        return false;
      }
    }
    await this.releasing;
    const result = await api.sendChat(agent, message);
    if (!result.ok) this.reportProblem(`chat: ${result.error.message}`);
    return result.ok;
  };

  cancelChat = async (agent: AgentId): Promise<void> => {
    await api.cancelChat(agent);
  };

  /** Start an art job (concepts, choose, rig, animate, auto). A running playtest is stopped first. */
  startArtJob = async (request: ArtJobRequest): Promise<boolean> => {
    if (this.state.mode === "play") {
      this.stop();
      if (!(await this.waitFor(() => this.state.mode === "edit", STOP_TIMEOUT_MS))) {
        this.reportProblem("could not stop the playtest to start the art job");
        return false;
      }
    }
    await this.releasing;
    const result = await api.startArtJob(request);
    if (!result.ok) this.reportProblem(`art: ${result.error.message}`);
    return result.ok;
  };

  cancelArtJob = async (): Promise<void> => {
    await api.cancelArtJob();
  };

  /** Edit mode: play `clip` on every spawn of a character (null = back to its behavior). */
  /** What the runtime shows (the studio's mode). Re-sent if the runtime reboots. */
  private stage: Stage = { mode: "game" };

  setStage = (stage: Stage): boolean => {
    this.stage = stage;
    if (this.state.runtimeStatus !== "ready") return false;
    return this.bridge.send({ type: "stage", stage });
  };

  previewClip = (characterId: string, clip: string | null): boolean => {
    if (this.state.runtimeStatus !== "ready" || this.state.mode !== "edit") return false;
    return this.bridge.send({ type: "previewClip", characterId, clip });
  };

  private waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const unsubscribe = this.subscribe(() => predicate() && done(true));
    });
  }

  /** Start a playtest. Omit `seed` for a fresh random run; pass one to replay it. */
  play = async (seed?: number): Promise<boolean> => {
    if (!this.canPlay()) return false;
    const runSeed = seed ?? Math.floor(Math.random() * MAX_SEED);
    this.set({ mode: "play", seed: runSeed }); // lock local edits immediately
    const lock = await api.setPlaytest(true, this.clientId);
    // Abort if the lock failed or the project moved on while we asked.
    if (!lock.ok || lock.revision !== this.state.loadedRevision) {
      if (lock.ok) void api.setPlaytest(false, this.clientId);
      else this.reportProblem(`cannot start playtest: ${lock.error.message}`);
      this.set({ mode: "edit" });
      this.syncRuntime();
      return false;
    }
    if (!this.bridge.send({ type: "play", seed: runSeed })) {
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
    const { mode, revision, seed, deaths, stage, entities } = await this.bridge.requestState();
    return { mode, revision, seed, deaths, stage, entities };
  };
}
