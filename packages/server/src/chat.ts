import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArtJobRequest,
  ChatEntry,
  ChatRequest,
  fail,
  toIssues,
  type ChatActivity,
  type ChatState,
  type OperationCall,
  type OperationError,
} from "@anomaly/core";
import { buildAgent, type AgentEvent, type AgentProfile, type ChatMessage, type TurnRunner } from "@anomaly/agent";
import type { ProjectStore } from "./projectStore.ts";
import type { ArtService } from "./art/service.ts";

const HISTORY_ENTRIES = 20;

type Result = { ok: true } | { ok: false; error: OperationError };

interface Running {
  activity: ChatActivity[];
  controller: AbortController;
  done: Promise<void>;
}

/** One agent's conversation about the project and its running turn. One AI turn runs at a time across all agents (the store's lock). */
/** Plain-language one-liner for a queued art job. */
export function describeJob(job: ArtJobRequest): string {
  switch (job.stage) {
    case "worldKit":
      return `queued: paint world "${(job.name ?? job.brief ?? job.biomeId ?? "").slice(0, 40)}" (${job.quality ?? "draft"})`;
    case "worldCompose":
      return `queued: compose a room for ${job.biomeId}`;
    case "worldRepaint":
      return `queued: repaint ${job.biomeId} ${job.part}`;
    default:
      return `queued: art for ${job.characterId}`;
  }
}

export class ChatService {
  private readonly store: ProjectStore;
  private readonly runner: TurnRunner;
  readonly agent: AgentProfile;
  private readonly path: string;
  private entries: ChatEntry[];
  private running: Running | null = null;
  /** Art jobs queued by turns go here (set by createProjectServer). */
  art: ArtService | null = null;
  private listeners = new Set<(state: ChatState) => void>();

  private constructor(store: ProjectStore, runner: TurnRunner, agent: AgentProfile, entries: ChatEntry[]) {
    this.store = store;
    this.runner = runner;
    this.agent = agent;
    this.path = chatPath(store, agent);
    this.entries = entries;
    let undone = store.undoneRevisions().join();
    store.subscribe(() => {
      const next = store.undoneRevisions().join();
      if (next !== undone) {
        undone = next;
        this.emit();
      }
    });
  }

  static async open(store: ProjectStore, runner: TurnRunner, agent: AgentProfile = buildAgent): Promise<ChatService> {
    let raw = "";
    try {
      raw = await readFile(chatPath(store, agent), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const entries = raw
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed = ChatEntry.safeParse(JSON.parse(line));
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      });
    return new ChatService(store, runner, agent, entries);
  }

  getState(): ChatState {
    return {
      entries: this.entries,
      running: this.running && { activity: this.running.activity },
      undone: this.store.undoneRevisions(),
    };
  }

  subscribe(listener: (state: ChatState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start a turn; it runs in the background and reports through events. */
  async send(request: unknown): Promise<Result> {
    const parsed = ChatRequest.safeParse(request);
    if (!parsed.success) return fail("invalid_request", "malformed chat request", toIssues(parsed.error));
    const lock = await this.store.beginAiTurn();
    if (!lock.ok) return lock;

    const history = toHistory(this.entries.slice(-HISTORY_ENTRIES));
    const controller = new AbortController();
    const running: Running = { activity: [], controller, done: Promise.resolve() };
    this.running = running;
    await this.append({ role: "user", at: new Date().toISOString(), text: parsed.data.message });
    running.done = this.runTurn(running, parsed.data.message, history);
    return { ok: true };
  }

  cancel(): Result {
    this.running?.controller.abort();
    return { ok: true };
  }

  /** Clear the conversation (after a project reset, which already backed it up). */
  async reset(): Promise<void> {
    this.entries = [];
    await writeFile(this.path, "");
    this.emit();
  }

  async idle(): Promise<void> {
    await this.running?.done;
  }

  private async runTurn(running: Running, message: string, history: ChatMessage[]): Promise<void> {
    let error: string | undefined;
    const onEvent = (event: AgentEvent) => {
      if (event.type === "error") error = event.message;
      if (event.type === "tool_call") running.activity.push({ kind: "tool", text: event.name });
      else if (event.type === "tool_result") running.activity.at(-1)!.ok = event.ok;
      else if (event.type === "assistant_text") running.activity.push({ kind: "text", text: event.text });
      else return;
      this.emit();
    };

    let entry: ChatEntry;
    let queuedJobs: ArtJobRequest[] = [];
    try {
      const result = await this.runner({
        project: this.store.getState().project,
        history,
        userMessage: message,
        signal: running.controller.signal,
        commit: (operations, baseRevision) => this.store.applyBatch({ operations, baseRevision, author: "ai" }),
        onEvent,
        agent: this.agent,
        artAvailable: this.art?.getState().available ?? false,
      });
      queuedJobs = ["committed", "no_changes"].includes(result.outcome) ? result.jobs : [];
      entry = {
        role: "assistant",
        at: new Date().toISOString(),
        text: result.reply,
        outcome: result.outcome,
        revision: result.outcome === "committed" ? result.project.revision : null,
        changes: [...result.operations.map(describeCall), ...queuedJobs.map(describeJob)],
        usage: result.usage,
        ...(error && ["commit_failed", "step_limit", "model_error"].includes(result.outcome) ? { error } : {}),
      };
    } catch (e) {
      entry = {
        role: "assistant",
        at: new Date().toISOString(),
        text: "",
        outcome: "model_error",
        revision: null,
        changes: [],
        usage: { promptTokens: 0, completionTokens: 0 },
        error: e instanceof Error ? e.message : String(e),
      };
    }

    this.store.endAiTurn();
    this.running = null;
    await this.append(entry);
    // Art jobs start now that the turn released the lock.
    if (queuedJobs.length > 0) this.art?.enqueue(queuedJobs);
    const { promptTokens, completionTokens, cost } = entry.usage;
    console.info(
      `[chat:${this.agent.id}] ${entry.outcome}, ${entry.changes.length} change(s), ${promptTokens} in / ${completionTokens} out` +
        (cost === undefined ? "" : `, ~$${cost.toFixed(4)}`),
    );
  }

  private async append(entry: ChatEntry): Promise<void> {
    this.entries = [...this.entries, entry];
    await appendFile(this.path, JSON.stringify(entry) + "\n");
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

/** The build assistant keeps the original chat.jsonl; other agents get <agent>-chat.jsonl. */
function chatPath(store: ProjectStore, agent: AgentProfile): string {
  return join(store.dir, agent.id === "build" ? "chat.jsonl" : `${agent.id}-chat.jsonl`);
}

function toHistory(entries: ChatEntry[]): ChatMessage[] {
  return entries.map((e) => {
    if (e.role === "user") return { role: "user", content: e.text };
    const saved = e.outcome === "committed" || e.outcome === "no_changes";
    return { role: "assistant", content: saved ? e.text : `${e.text}\n(This turn stopped: ${e.outcome}. No changes were saved.)`.trim() };
  });
}

/** Plain-language one-liner for a saved operation. */
export function describeCall({ name, input }: OperationCall): string {
  const i = input as Record<string, string | undefined> & { character?: { id: string } };
  switch (name) {
    case "createCharacter":
      return `created ${i.character?.id}`;
    case "duplicateCharacter":
      return `copied ${i.characterId} as ${i.newId}`;
    case "deleteCharacter":
      return `deleted ${i.characterId}`;
    case "updateCharacter":
      return `changed ${i.characterId}`;
    case "updateBehavior":
      return `tuned ${i.characterId} › ${i.stateId}`;
    case "setBehavior":
      return `rewrote ${i.characterId}'s behavior`;
    case "addRoomSpawn":
      return `placed ${i.characterId} in ${i.roomId}`;
    case "moveRoomSpawn":
      return `moved ${i.spawnId}`;
    case "removeRoomSpawn":
      return `removed ${i.spawnId}`;
    case "setPlaytest":
      return "changed the playtest";
    case "createWikiPage":
      return `drafted page ${(i as { page?: { id?: string } }).page?.id}`;
    case "updateWikiPage":
      return `edited page ${i.pageId}`;
    case "acceptWikiPage":
      return `accepted page ${i.pageId}`;
    case "deleteWikiPage":
      return `deleted page ${i.pageId}`;
    case "createRegion":
    case "createAbility":
    case "createConnection":
    case "createStoryBeat": {
      const item = Object.values(i)[0] as unknown as { id?: string } | undefined;
      return `drafted ${name.slice(6).replace("StoryBeat", "story beat").toLowerCase()} ${item?.id}`;
    }
    case "updateRegion":
    case "updateAbility":
    case "updateConnection":
    case "updateStoryBeat":
      return `edited ${i.regionId ?? i.abilityId ?? i.connectionId ?? i.beatId}`;
    case "setProgressionEnds":
      return [i.start !== undefined && `start: ${i.start ?? "none"}`, i.ending !== undefined && `ending: ${i.ending ?? "none"}`].filter(Boolean).join(", ");
    case "acceptProgressionItem":
      return `accepted ${i.id}`;
    case "deleteProgressionItem":
      return `deleted ${i.id}`;
    default:
      return name;
  }
}
