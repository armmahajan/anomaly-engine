import {
  ACTION_TYPES,
  CONDITION_TYPES,
  EFFECT_TYPES,
  MAX_SEED,
  PROTOCOL_VERSION,
  snapPlacement,
  toRuntimeProject,
  runtimeImageRefs,
  kitFiles,
  type AgentId,
  type ArtJobRequest,
  type Stage,
  type ArtState,
  type ArchitectRunRequest,
  type ArchitectState,
  type ChangeResult,
  type ChatState,
  type EntityState,
  type LiveSettings,
  type LiveState,
  type ProjectSpec,
  type ProjectState,
  type RuntimeMode,
  type RuntimeToStudio,
  type WorldStart,
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
  /** Each agent's conversation: build assistant (the game) and director (wiki and progression). */
  chats: Record<AgentId, ChatState>;
  /** Seed of the current or most recent playtest. */
  seed: number | null;
  art: ArtState;
  /** The Architect's run (stage progress, last outcome, activity). The plan itself is project.architect. */
  architect: ArchitectState;
  /** Background work that fills the studio in as the creator designs (game characters from the wiki, rooms from the progression). */
  live: LiveState;
  /** Worlds mode: the piece the creator clicked in the runtime (null = none), and where the camera looks. */
  worldPick: string | null;
  worldCameraX: number | null;
  /** Play: the room the player is in (null in edit mode). */
  room: string | null;
}

/** The runtime's state (see protocol.ts "state"). */
export type RuntimeSnapshot = Omit<Extract<RuntimeToStudio, { type: "state" }>, "type" | "requestId">;

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
      chats: { build: idleChat, narrative: idleChat, architect: idleChat },
      seed: null,
      art: { available: false, models: { image: "", vision: "" }, budget: 0, running: null, jobs: [], queued: 0, pending: [], totalCost: 0 },
      architect: { running: null, last: null, log: [] },
      live: {
        settings: { cast: false, rooms: false },
        cast: { working: [], message: "", error: null },
        rooms: { status: "idle", message: "", error: null },
        waiting: null,
      },
      worldPick: null,
      worldCameraX: null,
      room: null,
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
        else if (event.type === "architect") this.set({ architect: event.architect });
        else if (event.type === "live") this.set({ live: event.live });
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
    if (this.bridge.send({ type: "load", project: toRuntimeProject(project) })) this.requestedRevision = project.revision;
    // The images it draws: kits of biomes that dress rooms or draw props, modal images, item icons, cutout
    // rigs' images and rig part textures (sent once each; the runtime redraws when they arrive). A game export bundles the same set.
    const images = runtimeImageRefs(project);
    if (images.length > 0) void this.sendImages(images);
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
        this.sentImages.clear(); // a rebooted runtime has lost them
        void this.resendStage();
        return;
      case "loaded":
        this.set({ loadedRevision: message.revision });
        return;
      case "modeChanged": {
        const leavingPlay = this.state.mode === "play" && message.mode === "edit";
        this.set({ mode: message.mode, ...(message.mode === "edit" && { room: null }) });
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
      case "worldPick":
        this.set({ worldPick: message.placementId });
        return;
      case "roomEntered":
        this.set({ room: message.room });
        return;
      case "worldCamera":
        this.set({ worldCameraX: message.x });
        return;
      case "worldMove":
        void this.moveWorldPiece(message.placementId, message.x, message.y, message.free ?? false);
        return;
    }
  }

  /** The runtime's primitives must match the schema's, or behaviors would misbehave silently. */
  private checkPrimitives(runtime: { actions: string[]; conditions: string[]; effects: string[] }): void {
    const diff = (expected: readonly string[], actual: string[]) => {
      const missing = expected.filter((t) => !actual.includes(t));
      const extra = actual.filter((t) => !expected.includes(t));
      return [...missing.map((t) => `missing ${t}`), ...extra.map((t) => `unexpected ${t}`)];
    };
    const problems = [...diff(ACTION_TYPES, runtime.actions), ...diff(CONDITION_TYPES, runtime.conditions), ...diff(EFFECT_TYPES, runtime.effects)];
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

  /**
   * True while an AI turn or an Architect run (with its game-art job) holds the project: it
   * is locked to everyone but the AI. Background work (art jobs, the live cast and rooms)
   * never locks the creator out; its saves wait while a playtest runs.
   */
  aiBusy = (): boolean =>
    Object.values(this.state.chats).some((c) => c.running !== null) || this.state.architect.running !== null || this.state.art.running?.underLock === true;

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
    else this.reportProblem(result.error.message);
    return result;
  };

  canPlay(): boolean {
    const s = this.state;
    return s.runtimeStatus === "ready" && s.mode === "edit" && !this.aiBusy() && s.loadedRevision === s.project.revision;
  }

  /** Back up the project on the server and start over from the starter project (or the example game). */
  resetProject = async (from: "starter" | "example" | "blank" = "starter"): Promise<ChangeResult> => {
    const blocked = this.editBlocked();
    if (blocked) return blocked;
    const result = await api.resetProject(this.state.project.revision, from);
    if (result.ok) this.receiveProject(result);
    return result;
  };

  /**
   * Send a chat message to one of the agents. A running playtest is stopped first.
   * Edit/retry: `replace` is the index of the latest user message whose exchange this replaces;
   * `undoRevision` (that turn's saved revision, still the latest) is undone first.
   */
  sendChat = async (agent: AgentId, message: string, edit: { replace?: number; undoRevision?: number } = {}): Promise<{ ok: true } | { ok: false; error: string }> => {
    // The chat panel shows why a message wasn't sent, next to the message.
    const failed = (error: string) => ({ ok: false as const, error });
    if (this.state.mode === "play") {
      this.stop();
      if (!(await this.waitFor(() => this.state.mode === "edit", STOP_TIMEOUT_MS))) return failed("could not stop the playtest to send the message");
    }
    await this.releasing;
    if (edit.undoRevision !== undefined) {
      if (this.state.project.revision !== edit.undoRevision || !this.state.canUndo) return failed("the project changed since that turn, so its changes can't be undone automatically");
      const undone = await this.undo();
      if (!undone.ok) return { ok: false, error: undone.error.message };
    }
    const result = await api.sendChat(agent, message, edit.replace);
    return result.ok ? { ok: true } : failed(result.error.message);
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

  /** Run the Architect (all stages, a range, or some rooms). A running playtest is stopped first. */
  startArchitect = async (request: ArchitectRunRequest = {}): Promise<boolean> => {
    if (this.state.mode === "play") {
      this.stop();
      if (!(await this.waitFor(() => this.state.mode === "edit", STOP_TIMEOUT_MS))) {
        this.reportProblem("could not stop the playtest to run the Architect");
        return false;
      }
    }
    await this.releasing;
    const result = await api.startArchitect(request);
    if (!result.ok) this.reportProblem(`architect: ${result.error.message}`);
    return result.ok;
  };

  /** Turn the live cast (wiki characters become game characters) and/or the live rooms (the progression becomes rooms) on or off. */
  setLive = async (settings: Partial<LiveSettings>): Promise<boolean> => {
    const result = await api.setLive(settings);
    if (!result.ok) this.reportProblem(`live: ${result.error.message}`);
    else this.set({ live: result.live });
    return result.ok;
  };

  /** Stop the Architect after its current stage. */
  cancelArchitect = async (): Promise<void> => {
    await api.cancelArchitect();
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

  /** Images the runtime already has (world kits), by file ref. */
  private sentImages = new Set<string>();
  /** The biome room the world stage shows, for saving drags. */
  private worldTarget: { biomeId: string; roomId: string } | null = null;

  /**
   * Show a world room: sends any kit images the runtime lacks (once each), then the stage.
   * `target` is what drags in the runtime will edit.
   */
  showWorld = async (stage: Extract<Stage, { mode: "world" }>, refs: string[], target: { biomeId: string; roomId: string }): Promise<void> => {
    this.worldTarget = target;
    this.stage = stage;
    await this.sendImages(refs);
    if (this.stage === stage) this.setStage(stage);
  };

  private async sendImages(refs: string[]): Promise<void> {
    const missing = [...new Set(refs)].filter((r) => !this.sentImages.has(r));
    if (missing.length === 0 || this.state.runtimeStatus !== "ready") return;
    try {
      const images = Object.fromEntries(await Promise.all(missing.map(async (ref) => [ref, await api.fileBase64(ref)] as const)));
      if (this.bridge.send({ type: "images", images })) missing.forEach((r) => this.sentImages.add(r));
    } catch (error) {
      this.reportProblem(`could not load world images: ${String(error)}`);
    }
  }

  private async resendStage(): Promise<void> {
    if (this.stage.mode === "world") {
      const s = this.stage.scene;
      await this.sendImages(kitFiles(s));
    }
    this.bridge.send({ type: "stage", stage: this.stage });
  }

  /**
   * A piece dragged in the runtime: snap it onto the surface under it (unless Alt was held) and
   * save it as an ordinary edit (undoable), or put it back if editing is locked.
   */
  private async moveWorldPiece(placementId: string, x: number, y: number, free: boolean): Promise<void> {
    if (!this.worldTarget || this.stage.mode !== "world") return;
    const scene = this.stage.scene;
    const placement = scene.placements.find((p) => p.id === placementId);
    if (!placement) return;
    const dropped = { ...placement, x, y };
    const piece = scene.pieces.find((p) => p.id === placement.piece);
    const target = free ? dropped : snapPlacement(dropped, piece, scene, { placements: scene.placements, pieces: scene.pieces }).placement;
    if (target.x === placement.x && target.y === placement.y) {
      this.bridge.send({ type: "stage", stage: this.stage }); // snapped back to where it was
      return;
    }
    const result = await this.applyOperation("updatePlacement", {
      assetId: this.worldTarget.biomeId,
      roomId: this.worldTarget.roomId,
      placementId,
      changes: { x: target.x, y: target.y },
    });
    if (!result.ok) {
      this.reportProblem(result.error.message);
      this.bridge.send({ type: "stage", stage: this.stage }); // the runtime snaps the piece back
    }
  }

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

  /** Start a playtest. Omit `seed` for a fresh random run; pass one to replay it. With `world`, play the game world from there. */
  play = async (seed?: number, world?: WorldStart): Promise<boolean> => {
    if (!this.canPlay()) return false;
    const runSeed = seed ?? Math.floor(Math.random() * MAX_SEED);
    this.set({ mode: "play", seed: runSeed }); // lock local edits immediately
    let lock = await api.setPlaytest(true, this.clientId);
    // Background work may save just before the lock: load that revision and ask again (its saves wait from now on).
    for (let tries = 0; lock.ok && lock.revision !== this.state.loadedRevision && tries < 3; tries++) {
      await api.setPlaytest(false, this.clientId);
      this.set({ mode: "edit" });
      this.syncRuntime();
      const target = lock.revision;
      if (!(await this.waitFor(() => this.state.loadedRevision !== null && this.state.loadedRevision >= target && this.state.loadedRevision === this.state.project.revision, STOP_TIMEOUT_MS))) break;
      this.set({ mode: "play" });
      lock = await api.setPlaytest(true, this.clientId);
    }
    // Abort if the lock failed or the project moved on while we asked.
    if (!lock.ok || lock.revision !== this.state.loadedRevision) {
      if (lock.ok) void api.setPlaytest(false, this.clientId);
      else this.reportProblem(`cannot start playtest: ${lock.error.message}`);
      this.set({ mode: "edit" });
      this.syncRuntime();
      return false;
    }
    if (!this.bridge.send({ type: "play", seed: runSeed, ...(world && { world }) })) {
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
    const { type: _type, requestId: _id, ...state } = await this.bridge.requestState();
    return state;
  };

  /** Edit mode: show a modal of the loaded project over the game (null = close it). */
  // Clearing a preview with no runtime attached (a tab closing while the frame reloads) has nothing to clear: not a problem.
  previewModal = (modalId: string | null): boolean => (modalId === null && !this.bridge.attached ? true : this.bridge.send({ type: "previewModal", modalId }));
}
