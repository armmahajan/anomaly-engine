import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultProject } from "@anomaly/core";
import { callTools, FakeModel, narrativeAgent, runAgentTurn, say, toolCall, type TurnRunner } from "@anomaly/agent";
import { ChatService, ProjectStore } from "../src/index.ts";

let dir: string;
let store: ProjectStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anomaly-chat-"));
  store = await ProjectStore.open(dir, createDefaultProject);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fastCharger: TurnRunner = (request) =>
  runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(toolCall("duplicateCharacter", { characterId: "charger", newId: "fast_charger", name: "Fast Charger" })),
      callTools(
        toolCall("updateBehavior", { characterId: "fast_charger", stateId: "charge", action: { speed: 800 } }),
        toolCall("addRoomSpawn", { roomId: "arena", characterId: "fast_charger", x: 1100, y: 660 }),
      ),
      say("Added a Fast Charger."),
    ]),
  });

/** Runs until cancelled. */
const waitForCancel: TurnRunner = (request) =>
  new Promise((resolve) =>
    request.signal!.addEventListener("abort", () =>
      resolve({
        outcome: "cancelled",
        messages: [],
        reply: "",
        project: request.project,
        operations: [],
        jobs: [],
        usage: { promptTokens: 0, completionTokens: 0 },
      }),
    ),
  );

const editPlayer = (author: "user" | "ai" = "user") =>
  store.applyOperation({
    name: "updateCharacter",
    input: { characterId: "player", changes: { stats: { runSpeed: 400 } } },
    baseRevision: store.getState().project.revision,
    author,
  });

describe("ChatService", () => {
  it("saves a turn as one AI change that a single undo reverts, and keeps the conversation", async () => {
    const chat = await ChatService.open(store, fastCharger);
    expect(await chat.send({ message: "Add a faster Charger" })).toEqual({ ok: true });
    await chat.idle();

    expect(chat.getState().entries.at(-1)).toMatchObject({
      role: "assistant",
      text: "Added a Fast Charger.",
      outcome: "committed",
      revision: 1,
      changes: ["copied charger as fast_charger", "tuned fast_charger › charge", "placed fast_charger in arena"],
    });
    expect(store.getHistory()).toEqual([expect.objectContaining({ revision: 1, author: "ai" })]);
    expect((await ChatService.open(store, fastCharger)).getState().entries).toHaveLength(2);

    await store.undo({ baseRevision: 1 });
    expect(store.getState().project.characters.map((c) => c.id)).not.toContain("fast_charger");
    expect(chat.getState().undone).toEqual([1]);
  });

  it("locks edits and playtests during a turn; cancelling saves nothing", async () => {
    const chat = await ChatService.open(store, waitForCancel);
    await chat.send({ message: "think forever" });

    expect(chat.getState().running).not.toBeNull();
    expect(await editPlayer()).toMatchObject({ ok: false, error: { code: "locked" } });
    expect(await store.setPlaytest({ active: true, clientId: "a" })).toMatchObject({ ok: false, error: { code: "locked" } });
    expect(await chat.send({ message: "again" })).toMatchObject({ ok: false, error: { code: "locked" } });

    chat.cancel();
    await chat.idle();
    expect(chat.getState()).toMatchObject({ running: null, entries: [{ role: "user" }, { outcome: "cancelled" }] });
    expect(chat.getState().entries[1]).not.toHaveProperty("error");
    expect((await editPlayer()).ok).toBe(true);
  });

  it("edit/retry replaces the latest exchange, only once its saved changes are undone", async () => {
    const histories: string[][] = [];
    const recording: TurnRunner = (request) => {
      histories.push(request.history.map((m) => `${m.role}: ${m.content}`));
      return fastCharger(request);
    };
    const chat = await ChatService.open(store, recording);
    await chat.send({ message: "Add a faster Charger" });
    await chat.idle();

    // Its changes still stand: replacing would hide them.
    expect(await chat.send({ message: "Add a fast Charger", replace: 0 })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    // Only a user message that is the latest one can be replaced.
    expect(await chat.send({ message: "Add a fast Charger", replace: 1 })).toMatchObject({ ok: false, error: { code: "stale_revision" } });
    expect(chat.getState().entries).toHaveLength(2);

    await store.undo({ baseRevision: 1 });
    expect(await chat.send({ message: "Add a fast Charger", replace: 0 })).toEqual({ ok: true });
    await chat.idle();
    expect(chat.getState().entries.map((e) => (e.role === "user" ? e.text : e.outcome))).toEqual(["Add a fast Charger", "committed"]);
    expect(histories[1]).toEqual([]); // the replaced exchange is not part of the conversation any more
    expect(store.getState().project.characters.map((c) => c.id)).toContain("fast_charger");
    const reopened = await ChatService.open(store, recording);
    expect(reopened.getState().entries.map((e) => e.role)).toEqual(["user", "assistant"]);

    // An earlier exchange can't be replaced once a later message exists.
    await store.undo({ baseRevision: store.getState().project.revision });
    await chat.send({ message: "Add a faster Charger" });
    await chat.idle();
    expect(await chat.send({ message: "again", replace: 0 })).toMatchObject({ ok: false, error: { code: "stale_revision" } });
  });

  it("refuses to start a turn during a playtest", async () => {
    const chat = await ChatService.open(store, fastCharger);
    await store.setPlaytest({ active: true, clientId: "a" });
    expect(await chat.send({ message: "hi" })).toMatchObject({ ok: false, error: { code: "locked" } });
    expect(chat.getState().entries).toEqual([]);
  });

  it("reset backs up the project folder and starts fresh", async () => {
    const chat = await ChatService.open(store, fastCharger);
    await chat.send({ message: "Add a faster Charger" });
    await chat.idle();

    expect(await store.reset({ baseRevision: 1 })).toMatchObject({ ok: true, project: { revision: 2 }, canUndo: false });
    await chat.reset();
    expect(store.getState().project.characters.map((c) => c.id)).toEqual(["player", "crawler", "charger"]);
    expect(chat.getState().entries).toEqual([]);

    const [backup] = await readdir(join(dir, "backups"));
    expect((await readdir(join(dir, "backups", backup!))).sort()).toEqual(["chat.jsonl", "history.jsonl", "project.json"]);
  });

  it("each agent keeps its own conversation, and only one AI turn runs at a time across them", async () => {
    const seen: string[] = [];
    const drafter: TurnRunner = (request) => {
      seen.push(request.agent!.id);
      return runAgentTurn({
        ...request,
        model: new FakeModel([
          callTools(toolCall("createWikiPage", { page: { id: "overview", kind: "overview", title: "Drowned Lamp" } })),
          say("Drafted the overview."),
        ]),
      });
    };
    const build = await ChatService.open(store, waitForCancel);
    const narrative = await ChatService.open(store, drafter, narrativeAgent);

    await build.send({ message: "think forever" });
    expect(await narrative.send({ message: "a drowned kingdom" })).toMatchObject({ ok: false, error: { code: "locked" } });
    build.cancel();
    await build.idle();

    expect(await narrative.send({ message: "a drowned kingdom" })).toEqual({ ok: true });
    await narrative.idle();
    expect(seen).toEqual(["narrative"]);
    expect(narrative.getState().entries.at(-1)).toMatchObject({ outcome: "committed", changes: ["drafted page overview"] });
    expect(store.getState().project.wiki.pages).toEqual([expect.objectContaining({ id: "overview", status: "draft" })]);
    expect(build.getState().entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect((await readdir(dir)).sort()).toEqual(["chat.jsonl", "history.jsonl", "narrative-chat.jsonl", "project.json"]);
  });
});
